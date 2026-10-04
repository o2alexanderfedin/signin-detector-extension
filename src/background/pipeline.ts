/// <reference types="chrome" />

import { createConfidenceEngine, type ConfidenceEngine } from '../engine/confidenceEngine';
import { resolveWebAppKey } from '../identity/appIdentity';
import { sendVerdictUpdate as sendVerdictUpdateMessage } from '../content/messaging';
import { classifyNetwork, type NetworkRequestInput } from '../sensors/network/classify';
import type { ClockFn, SensorSignalMessage, SignalEvidence, SignalName, VerdictResult, WebAppKey } from '../shared/types';
import { createCookieSensor, type CookiesApi } from './sensors/cookieSensor';
import type { PersistedVerdictState, VerdictStore } from './state/verdictStore';

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
   * collapse onto the same key per IDN-01). Only tabs that use the cookie
   * store the change happened in are refreshed, from that store alone.
   */
  handleCookieChanged(changeInfo: chrome.cookies.CookieChangeInfo): Promise<void>;
  /** `chrome.webRequest.onCompleted` carries `tabId` directly -- no WebAppKey resolution needed. */
  handleNetworkCompleted(details: chrome.webRequest.OnCompletedDetails): Promise<void>;
  /** A content-script `SENSOR_SIGNAL` message (storage/dom) -- routed via `sender.tab.id`. */
  handleSensorSignal(message: SensorSignalMessage, sender: MessageSenderLike): Promise<void>;
  /** `chrome.tabs.onRemoved` -- drops in-memory engine state and clears the persisted snapshot. */
  handleTabRemoved(tabId: number): Promise<void>;
  /**
   * `chrome.tabs.onReplaced` -- the browser swapped `removedTabId` for `addedTabId` (a prerendered or
   * restored page) without an `onRemoved` for the old one. The old tab is dropped like a closed tab,
   * and its saved verdict moves to the new tab, exactly as a verdict saved before a worker restart
   * comes back: the site it records decides, at the new page's first message, whether it is kept.
   * A new tab that already has state of its own keeps it.
   */
  handleTabReplaced(addedTabId: number, removedTabId: number): Promise<void>;
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
   * Reads the tab's own site's cookies once, the first time the tab is known to show that site. A
   * user who signed in before opening the tab already has the session cookie, and no cookie change
   * will ever be reported for it; without this read the cookie would count only when it changed
   * while the tab happened to be open. The read is made once per site per tab (until the worker
   * restarts), not on every message, and only from the cookie store the tab uses: a tab no store
   * lists is not read, so a private window is never judged by the regular window's cookies.
   */
  async function readCookiesOnce(tabId: number, state: TabRuntimeState): Promise<void> {
    const webAppKey = state.webAppKey;
    if (webAppKey === null || state.vector.cookie !== undefined) {
      return;
    }
    const stores = await cookiesApi.getAllCookieStores();
    const storeId = stores.find((store) => store.tabIds.includes(tabId))?.id;
    if (storeId === undefined) {
      return;
    }
    const evidence = await cookieSensor.getEvidence(webAppKey, clock, storeId);
    // A cookie change handled meanwhile is newer, and a move to another site makes this read stale.
    if (state.webAppKey === webAppKey && state.vector.cookie === undefined) {
      state.vector = { ...state.vector, cookie: evidence };
    }
  }

  /**
   * The shared recompute step every handler below funnels into (RCT-01):
   * merge the fresh evidence into the tab's accumulated `SignalVector`,
   * feed the engine, persist its new snapshot (PLT-01), and notify that
   * tab's content script (PLT-02).
   *
   * `pageKey` is the web application the tab showed when the event happened, if the event says.
   * Only an event from the page now in the tab (`identifiesPage`, a content-script message) may
   * move the tab to another site: that evidence and verdict describe the old site, so the tab starts
   * over from 'unknown'. Any other event may only name the site while it is still unknown -- a cookie
   * change or a request from the old page can be handled just after the tab moved, and must not
   * move it back and throw away the new site's evidence.
   *
   * `requestKey`, given for cookie and network evidence, is the web application that evidence is
   * about. It is kept only when that is the tab's own site: another site's `/me` or cookie answers
   * for that site, not for whether the user is signed in to the page in the tab.
   */
  async function refreshSignal(
    tabId: number,
    evidence: SignalEvidence,
    pageKey: WebAppKey | null,
    identifiesPage: boolean,
    requestKey?: WebAppKey | null,
  ): Promise<void> {
    const loading = getTabState(tabId);
    const state = await loading;
    if (tabStates.get(tabId) !== loading) {
      return; // The tab was closed while its state loaded: saving now would leave a snapshot for a tab that is gone.
    }
    if (pageKey !== null && (state.webAppKey === null || identifiesPage)) {
      if (state.webAppKey !== null && state.webAppKey !== pageKey) {
        state.engine = createEngine(clock);
        state.vector = {};
      }
      state.webAppKey = pageKey;
    }
    if (evidence.signal !== 'cookie') {
      await readCookiesOnce(tabId, state);
    }
    if (tabStates.get(tabId) !== loading) {
      return; // Closed while its cookies were read.
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
    // A private window or a Firefox container keeps its own cookies: only tabs that use the store
    // the cookie changed in are affected, and they are judged by that store's cookies alone.
    const storeId = changeInfo.cookie.storeId;
    const stores = await cookiesApi.getAllCookieStores();
    const tabsInStore = new Set(stores.find((store) => store.id === storeId)?.tabIds ?? []);
    const tabs = await tabsApi.query({});
    for (const tab of tabs) {
      if (tab.id === undefined || tab.url === undefined || !tabsInStore.has(tab.id)) {
        continue;
      }
      const webAppKey = resolveWebAppKey(tab.url);
      if (webAppKey !== changedKey) {
        continue;
      }
      const evidence = await cookieSensor.getEvidence(webAppKey, clock, storeId);
      if (removedSince(tab.id, startedAt)) {
        continue; // Closed while this event waited: saving now would leave a snapshot for a tab that is gone.
      }
      await refreshSignal(tab.id, evidence, webAppKey, false, webAppKey);
    }
  }

  async function handleNetworkCompleted(details: chrome.webRequest.OnCompletedDetails): Promise<void> {
    if (details.tabId < 0) {
      return; // Not associated with a real tab (e.g. the SW's own requests) -- nothing to route to.
    }
    const evidence = classifyNetwork(toNetworkRequestInput(details));
    await refreshSignal(details.tabId, evidence, requestPageKey(details), false, resolveWebAppKey(details.url));
  }

  async function handleSensorSignal(message: SensorSignalMessage, sender: MessageSenderLike): Promise<void> {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      return;
    }
    const pageUrl = sender.tab?.url;
    await refreshSignal(tabId, message.evidence, pageUrl === undefined ? null : resolveWebAppKey(pageUrl), true);
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    removedAt.set(tabId, ++removalCount);
    tabStates.delete(tabId);
    await store.clear(tabId);
  }

  /** True when a saved snapshot holds anything beyond the empty default. */
  function holdsVerdict(snapshot: PersistedVerdictState | undefined): boolean {
    return snapshot !== undefined && (snapshot.state !== 'unknown' || snapshot.pendingSignedOutSince !== null || (snapshot.webAppKey ?? null) !== null);
  }

  async function handleTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    removedAt.set(removedTabId, ++removalCount);
    tabStates.delete(removedTabId);
    const carried = await store.get(removedTabId);
    await store.clear(removedTabId);
    // Every event the new tab handled saved its state, so a saved state means the new page already
    // sent evidence of its own: that describes it better. An event still in flight saves over the
    // carried verdict when it finishes, so the new page's own evidence wins there too.
    const own = await store.get(addedTabId);
    if (holdsVerdict(own)) {
      return;
    }
    if (carried !== undefined) {
      await store.set(addedTabId, carried);
    }
  }

  return { handleCookieChanged, handleNetworkCompleted, handleSensorSignal, handleTabRemoved, handleTabReplaced };
}
