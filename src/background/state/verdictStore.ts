/// <reference types="chrome" />

import type { ConfidenceEngineSnapshot } from '../../engine/confidenceEngine';

/**
 * Per-tab persisted engine state (PLT-01). Identical in shape to
 * {@link ConfidenceEngineSnapshot} -- this store persists EXACTLY what
 * `createConfidenceEngine`'s serialize()/restore seam needs to resume
 * hysteresis (ENG-03) and the asymmetric signed-out debounce (ENG-04)
 * deterministically after a service-worker restart.
 *
 * Only derived numbers/enums are ever present here -- never a raw cookie,
 * token, or storage value (PRV-01) -- because this type is the engine's
 * OWN snapshot type, and the engine itself is Chrome-API-free and never
 * touches raw session material.
 */
export type PersistedVerdictState = ConfidenceEngineSnapshot;

/**
 * The safe default returned by `get()` when a tab has no persisted state
 * yet (e.g. the service worker just woke and has never seen this tab, or
 * the tab is brand new). Matches the engine's own default construction
 * (`createConfidenceEngine()` with no `restore` argument).
 */
export const UNKNOWN_VERDICT_STATE: PersistedVerdictState = {
  state: 'unknown',
  confidence: 0,
  pendingSignedOutSince: null,
};

/**
 * Thin, single-responsibility `chrome.storage.session` adapter for
 * per-tab verdict/hysteresis state (PLT-01). This is the ONLY module this
 * phase introduces that touches a Chrome API.
 */
export interface VerdictStore {
  /** Never throws on a missing tab -- resolves to {@link UNKNOWN_VERDICT_STATE} instead. */
  get(tabId: number): Promise<PersistedVerdictState | undefined>;
  set(tabId: number, state: PersistedVerdictState): Promise<void>;
  /** Called on tab close; a no-op (not an error) if the tab had no persisted state. */
  clear(tabId: number): Promise<void>;
}

const STORAGE_KEY_PREFIX = 'verdict:';

function storageKey(tabId: number): string {
  return `${STORAGE_KEY_PREFIX}${tabId}`;
}

/**
 * Creates a {@link VerdictStore} backed by `chrome.storage.session`
 * (in-memory, cleared on browser exit -- see the Phase 2 CONTEXT decision
 * record). Deliberately holds NO in-memory cache: every method reads or
 * writes storage directly on each call ("rehydrate-on-demand"), because a
 * service worker must never assume JS-level state survives its own
 * suspension -- that assumption is exactly the bug this store exists to
 * prevent.
 *
 * `storageArea` defaults to the real `chrome.storage.session` and is
 * injectable for testing (backed by `@webext-core/fake-browser` in
 * `verdictStore.test.ts`, matching the global `chrome`/`browser` stub WXT's
 * Vitest plugin installs).
 */
export function createVerdictStore(
  storageArea: chrome.storage.StorageArea = chrome.storage.session,
): VerdictStore {
  return {
    async get(tabId: number): Promise<PersistedVerdictState | undefined> {
      const key = storageKey(tabId);
      const record = await storageArea.get(key);
      const value = record[key] as PersistedVerdictState | undefined;
      return value ?? UNKNOWN_VERDICT_STATE;
    },

    async set(tabId: number, state: PersistedVerdictState): Promise<void> {
      await storageArea.set({ [storageKey(tabId)]: state });
    },

    async clear(tabId: number): Promise<void> {
      await storageArea.remove(storageKey(tabId));
    },
  };
}
