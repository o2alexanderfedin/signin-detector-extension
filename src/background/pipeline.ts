/// <reference types="chrome" />

import { createConfidenceEngine, type ConfidenceEngine } from '../engine/confidenceEngine';
import { resolveWebAppKey } from '../identity/appIdentity';
import { sendVerdictUpdate as sendVerdictUpdateMessage } from '../content/messaging';
import { classifyNetwork, type NetworkRequestInput } from '../sensors/network/classify';
import type { ClockFn, SensorSignalMessage, SignalEvidence, SignalName, VerdictResult, WebAppKey } from '../shared/types';
import { createCookieSensor, type CookiesApi } from './sensors/cookieSensor';
import type { VerdictStore } from './state/verdictStore';

/**
 * The narrow `chrome.tabs` subset {@link createPipeline} depends on --
 * injectable so it's unit-testable without a real browser, same "inject
 * the chrome namespace" pattern `cookieSensor.ts`/`networkSensor.ts` use.
 * `@webext-core/fake-browser` DOES implement `tabs.query` (unlike
 * `cookies`/`webRequest`), so tests may pass `fakeBrowser.tabs` directly.
 */
export interface TabsApi {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
}

/**
 * The structural subset of `@webext-core/messaging`'s `ExtensionMessage['sender']`
 * (itself `Runtime.MessageSender`) this module reads. Kept minimal/structural
 * (rather than importing the library type) so `pipeline.ts` stays decoupled
 * from the messaging library's exact type, while still accepting the real
 * sender object `content/messaging.ts#onSensorSignal` hands it.
 */
export interface MessageSenderLike {
  readonly tab?: {
    readonly id?: number;
    readonly url?: string;
  };
}

/**
 * Injectable dependencies for {@link createPipeline} (RCT-01 orchestrator).
 * Every Chrome sub-API defaults to the real global `chrome.*` -- overridden
 * in tests with `@webext-core/fake-browser` (for `tabs`) and hand-rolled
 * fakes (for `cookies`, which fake-browser does not implement -- same
 * pattern as `cookieSensor.test.ts`).
 */
export interface PipelineDeps {
  readonly cookiesApi?: CookiesApi;
  readonly tabsApi?: TabsApi;
  readonly store: VerdictStore;
  readonly createEngine?: typeof createConfidenceEngine;
  readonly clock?: ClockFn;
  /** Defaults to `content/messaging.ts#sendVerdictUpdate` -- reused, not reimplemented. */
  readonly sendVerdictUpdate?: (result: VerdictResult, tabId: number) => Promise<void>;
}

/** The orchestrator surface `entrypoints/background.ts`'s listeners delegate into (PLT-03). */
export interface Pipeline {
  /**
   * `chrome.cookies.onChanged` carries no `tabId` (cookies aren't
   * tab-scoped) -- resolves every currently open tab's `WebAppKey` from its
   * URL via `resolveWebAppKey`, and refreshes cookie evidence for exactly
   * the tabs whose `WebAppKey` matches the changed cookie's registrable
   * domain (also resolved via `resolveWebAppKey`, so subdomain cookies
   * collapse onto the same key per IDN-01).
   */
  handleCookieChanged(changeInfo: chrome.cookies.CookieChangeInfo): Promise<void>;
  /** `chrome.webRequest.onCompleted` carries `tabId` directly -- no WebAppKey resolution needed. */
  handleNetworkCompleted(details: chrome.webRequest.OnCompletedDetails): Promise<void>;
  /** A content-script `SENSOR_SIGNAL` message (storage/dom) -- routed via `sender.tab.id`. */
  handleSensorSignal(message: SensorSignalMessage, sender: MessageSenderLike): Promise<void>;
  /** `chrome.tabs.onRemoved` -- drops in-memory engine state and clears the persisted snapshot. */
  handleTabRemoved(tabId: number): Promise<void>;
}

/** Per-tab in-memory bookkeeping: the live engine instance and the accumulated per-signal evidence. */
interface TabRuntimeState {
  engine: ConfidenceEngine;
  vector: { -readonly [K in SignalName]?: SignalEvidence };
  /** The web application the evidence above belongs to; `null` until an event names one. */
  webAppKey: WebAppKey | null;
}

/**
 * The web application whose page a completed request belongs to, or `null` when the event does not
 * say. A request made by the top-level page names that page's origin as its initiator. A top-level
 * load is not taken at its own URL: it may be a download that never replaces the page. Requests from
 * sub-frames belong to other sites, so they name nothing.
 */
function requestPageKey(details: chrome.webRequest.OnCompletedDetails): WebAppKey | null {
  if (details.frameId === 0 && details.initiator !== undefined) {
    return resolveWebAppKey(details.initiator);
  }
  return null;
}

/**
 * Maps a completed `chrome.webRequest` request into the pure
 * `classifyNetwork` classifier's input shape. Deliberately re-derived here
 * (rather than imported from `networkSensor.ts`, whose `watch()` callback
 * does not expose the originating `tabId` needed for per-tab routing) --
 * this mapping is trivial adapter glue, not a reimplementation of the
 * (reused, untouched) classification rule itself.
 */
function toNetworkRequestInput(details: chrome.webRequest.OnCompletedDetails): NetworkRequestInput {
  const hasAuthorizationHeader = (details.responseHeaders ?? []).some(
    (header) => header.name.toLowerCase() === 'authorization',
  );
  return { url: details.url, statusCode: details.statusCode, hasAuthorizationHeader };
}

/**
 * Creates the {@link Pipeline} orchestrator (RCT-01): the ONLY module that
 * fuses per-tab `ConfidenceEngine` state, `verdictStore` persistence
 * (PLT-01 rehydration), and outbound `VERDICT_UPDATE` messaging (PLT-02)
 * into the live signal -> verdict -> notify loop. Composes ALREADY-TESTED
 * units (the engine, the store, the cookie sensor, the pure network
 * classifier, the messaging helpers) -- it reimplements none of their
 * logic, only the routing between them.
 *
 * Entirely event-driven: every method here is a direct response to one
 * observed Chrome event (cookie change, network completion, a content
 * sensor's message, or tab close) -- nothing here polls or reacts to
 * navigation.
 */
export function createPipeline(deps: PipelineDeps): Pipeline {
  const cookiesApi = deps.cookiesApi ?? chrome.cookies;
  const tabsApi: TabsApi = deps.tabsApi ?? chrome.tabs;
  const store = deps.store;
  const createEngine = deps.createEngine ?? createConfidenceEngine;
  const clock = deps.clock ?? Date.now;
  const sendVerdictUpdate = deps.sendVerdictUpdate ?? sendVerdictUpdateMessage;

  const cookieSensor = createCookieSensor(cookiesApi);

  /**
   * Live per-tab state, lost on service-worker suspension by design -- rebuilt lazily via {@link getTabState}.
   * Holds the pending load rather than the loaded state, so events that arrive for a tab while its
   * snapshot is still being read all share ONE state instead of each building its own.
   */
  const tabStates = new Map<number, Promise<TabRuntimeState>>();

  /**
   * Counts tab removals, and remembers the count at which each tab was last removed. A handler that
   * waits before it reaches a tab notes the count first, so it can tell afterwards that the tab was
   * closed while it waited.
   */
  let removalCount = 0;
  const removedAt = new Map<number, number>();
  function removedSince(tabId: number, count: number): boolean {
    return (removedAt.get(tabId) ?? 0) > count;
  }

  /**
   * Get-or-create a tab's runtime state (PLT-01 rehydration): on first
   * touch after a (real or simulated) service-worker restart, seeds a
   * fresh `ConfidenceEngine` from the tab's persisted snapshot in
   * `verdictStore` rather than defaulting to 'unknown' -- the engine's own
   * `restore` seam (`confidenceEngine.ts`) does the actual state
   * reconstruction; this function only supplies it the right snapshot.
   */
  function getTabState(tabId: number): Promise<TabRuntimeState> {
    const existing = tabStates.get(tabId);
    if (existing !== undefined) {
      return existing;
    }
    const loading = store.get(tabId).then(
      (snapshot): TabRuntimeState => ({
        engine: createEngine(clock, snapshot),
        vector: {},
        webAppKey: snapshot?.webAppKey ?? null,
      }),
    );
    tabStates.set(tabId, loading);
    // A failed read must not stick: forget it so the tab's next event tries again.
    loading.catch(() => {
      if (tabStates.get(tabId) === loading) {
        tabStates.delete(tabId);
      }
    });
    return loading;
  }

  /**
   * The shared recompute step every handler below funnels into (RCT-01):
   * merge the fresh evidence into the tab's accumulated `SignalVector`,
   * feed the engine, persist its new snapshot (PLT-01), and notify that
   * tab's content script (PLT-02).
   *
   * `pageKey` is the web application the tab shows when the event happened, if the event says. When
   * it differs from the one the tab's evidence was gathered on, the tab has moved to another site:
   * that evidence and verdict describe the old site, so the tab starts over from 'unknown'.
   *
   * `requestKey`, given for network evidence only, is the web application the request went to. Such
   * evidence is kept only when that is the tab's own site: another site's `/me` answers for that
   * site's user, not for whether the user is signed in to the page in the tab.
   */
  async function refreshSignal(
    tabId: number,
    evidence: SignalEvidence,
    pageKey: WebAppKey | null,
    requestKey?: WebAppKey | null,
  ): Promise<void> {
    const loading = getTabState(tabId);
    const state = await loading;
    if (tabStates.get(tabId) !== loading) {
      return; // The tab was closed while its state loaded: saving now would leave a snapshot for a tab that is gone.
    }
    if (pageKey !== null) {
      if (state.webAppKey !== null && state.webAppKey !== pageKey) {
        state.engine = createEngine(clock);
        state.vector = {};
      }
      state.webAppKey = pageKey;
    }
    const firstParty = requestKey === undefined || (requestKey !== null && requestKey === state.webAppKey);
    // Cookie, storage and DOM evidence each describe the page as it is now, so "nothing seen" replaces
    // what was there. A network event describes one request: one that is not an identity response says
    // nothing about the session, so it must not erase the last identity response the tab saw.
    const saysSomething = evidence.signal !== 'network' || evidence.observed;
    if (firstParty && saysSomething) {
      state.vector = { ...state.vector, [evidence.signal]: evidence };
    }
    const result = state.engine.update(state.vector);
    await store.set(tabId, { ...state.engine.serialize(), webAppKey: state.webAppKey });
    await sendVerdictUpdate(result, tabId);
  }

  async function handleCookieChanged(changeInfo: chrome.cookies.CookieChangeInfo): Promise<void> {
    const changedKey = resolveWebAppKey(changeInfo.cookie.domain.replace(/^\./, ''));
    if (changedKey === null) {
      return;
    }

    const startedAt = removalCount;
    const tabs = await tabsApi.query({});
    for (const tab of tabs) {
      if (tab.id === undefined || tab.url === undefined) {
        continue;
      }
      const webAppKey = resolveWebAppKey(tab.url);
      if (webAppKey !== changedKey) {
        continue;
      }
      const evidence = await cookieSensor.getEvidence(webAppKey, clock);
      if (removedSince(tab.id, startedAt)) {
        continue; // Closed while this event waited: saving now would leave a snapshot for a tab that is gone.
      }
      await refreshSignal(tab.id, evidence, webAppKey);
    }
  }

  async function handleNetworkCompleted(details: chrome.webRequest.OnCompletedDetails): Promise<void> {
    if (details.tabId < 0) {
      return; // Not associated with a real tab (e.g. the SW's own requests) -- nothing to route to.
    }
    const evidence = classifyNetwork(toNetworkRequestInput(details));
    await refreshSignal(details.tabId, evidence, requestPageKey(details), resolveWebAppKey(details.url));
  }

  async function handleSensorSignal(message: SensorSignalMessage, sender: MessageSenderLike): Promise<void> {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      return;
    }
    const pageUrl = sender.tab?.url;
    await refreshSignal(tabId, message.evidence, pageUrl === undefined ? null : resolveWebAppKey(pageUrl));
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    removedAt.set(tabId, ++removalCount);
    tabStates.delete(tabId);
    await store.clear(tabId);
  }

  return { handleCookieChanged, handleNetworkCompleted, handleSensorSignal, handleTabRemoved };
}
