/// <reference types="chrome" />

import { createConfidenceEngine, type ConfidenceEngine } from '../engine/confidenceEngine';
import { resolveWebAppKey } from '../identity/appIdentity';
import { sendVerdictUpdate as sendVerdictUpdateMessage } from '../content/messaging';
import { classifyNetwork, type NetworkRequestInput } from '../sensors/network/classify';
import type { ClockFn, SensorSignalMessage, SignalEvidence, SignalName, VerdictResult } from '../shared/types';
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
  readonly engine: ConfidenceEngine;
  vector: { -readonly [K in SignalName]?: SignalEvidence };
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

  /** Live per-tab state, lost on service-worker suspension by design -- rebuilt lazily via {@link getTabState}. */
  const tabStates = new Map<number, TabRuntimeState>();

  /**
   * Get-or-create a tab's runtime state (PLT-01 rehydration): on first
   * touch after a (real or simulated) service-worker restart, seeds a
   * fresh `ConfidenceEngine` from the tab's persisted snapshot in
   * `verdictStore` rather than defaulting to 'unknown' -- the engine's own
   * `restore` seam (`confidenceEngine.ts`) does the actual state
   * reconstruction; this function only supplies it the right snapshot.
   */
  async function getTabState(tabId: number): Promise<TabRuntimeState> {
    const existing = tabStates.get(tabId);
    if (existing !== undefined) {
      return existing;
    }
    const snapshot = await store.get(tabId);
    const state: TabRuntimeState = { engine: createEngine(clock, snapshot), vector: {} };
    tabStates.set(tabId, state);
    return state;
  }

  /**
   * The shared recompute step every handler below funnels into (RCT-01):
   * merge the fresh evidence into the tab's accumulated `SignalVector`,
   * feed the engine, persist its new snapshot (PLT-01), and notify that
   * tab's content script (PLT-02).
   */
  async function refreshSignal(tabId: number, evidence: SignalEvidence): Promise<void> {
    const state = await getTabState(tabId);
    state.vector = { ...state.vector, [evidence.signal]: evidence };
    const result = state.engine.update(state.vector);
    await store.set(tabId, state.engine.serialize());
    await sendVerdictUpdate(result, tabId);
  }

  async function handleCookieChanged(changeInfo: chrome.cookies.CookieChangeInfo): Promise<void> {
    const changedKey = resolveWebAppKey(changeInfo.cookie.domain.replace(/^\./, ''));
    if (changedKey === null) {
      return;
    }

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
      await refreshSignal(tab.id, evidence);
    }
  }

  async function handleNetworkCompleted(details: chrome.webRequest.OnCompletedDetails): Promise<void> {
    if (details.tabId < 0) {
      return; // Not associated with a real tab (e.g. the SW's own requests) -- nothing to route to.
    }
    const evidence = classifyNetwork(toNetworkRequestInput(details));
    await refreshSignal(details.tabId, evidence);
  }

  async function handleSensorSignal(message: SensorSignalMessage, sender: MessageSenderLike): Promise<void> {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      return;
    }
    await refreshSignal(tabId, message.evidence);
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    tabStates.delete(tabId);
    await store.clear(tabId);
  }

  return { handleCookieChanged, handleNetworkCompleted, handleSensorSignal, handleTabRemoved };
}
