/// <reference types="chrome" />

import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { createVerdictStore, UNKNOWN_VERDICT_STATE, type PersistedVerdictState } from './verdictStore';

/**
 * PLT-01 -- chrome.storage.session adapter tests.
 *
 * `chrome`/`browser` are globally stubbed to `fakeBrowser` by WXT's Vitest
 * plugin (see vitest.config.ts). Each `createVerdictStore()` call below
 * makes a BRAND NEW store instance with no shared JS state, over the SAME
 * underlying `fakeBrowser` in-memory storage within a test -- this is the
 * "simulated service-worker restart" the ROADMAP calls for: a service
 * worker restart destroys all JS state but chrome.storage.session survives
 * for the life of the browser session.
 */
describe('verdictStore (PLT-01)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  // ---------------------------------------------------------------------
  // ROADMAP Phase 2 success criterion 1: verdict/hysteresis state written
  // for a tab rehydrates from chrome.storage.session after a simulated
  // service-worker restart, with no data loss.
  // ---------------------------------------------------------------------
  describe('criterion 1: rehydration across a simulated SW restart', () => {
    it('set() then a new store instance over the same fake chrome.storage.session -- get() returns the identical state', async () => {
      const tabId = 42;
      const state: PersistedVerdictState = {
        state: 'signed-in',
        confidence: 0.85,
        pendingSignedOutSince: null,
      };

      const beforeRestart = createVerdictStore();
      await beforeRestart.set(tabId, state);

      // Simulated SW restart: a fresh store instance, no shared JS state.
      const afterRestart = createVerdictStore();
      await expect(afterRestart.get(tabId)).resolves.toEqual(state);
    });

    it('rehydrates a pending signed-out debounce timestamp with no loss (required to resume ENG-04 asymmetric debounce deterministically)', async () => {
      const tabId = 7;
      const state: PersistedVerdictState = {
        state: 'signed-in',
        confidence: 0.2,
        pendingSignedOutSince: 123_456,
      };

      await createVerdictStore().set(tabId, state);

      const restarted = createVerdictStore();
      await expect(restarted.get(tabId)).resolves.toEqual(state);
    });

    it('multiple tabs persist and rehydrate independently', async () => {
      const stateA: PersistedVerdictState = { state: 'signed-in', confidence: 0.9, pendingSignedOutSince: null };
      const stateB: PersistedVerdictState = { state: 'signed-out', confidence: 0.1, pendingSignedOutSince: null };

      const store = createVerdictStore();
      await store.set(1, stateA);
      await store.set(2, stateB);

      const restarted = createVerdictStore();
      await expect(restarted.get(1)).resolves.toEqual(stateA);
      await expect(restarted.get(2)).resolves.toEqual(stateB);
    });
  });

  // ---------------------------------------------------------------------
  // ROADMAP Phase 2 success criterion 2: closing a tab clears its
  // persisted verdict state -- no stale state lingers for that tab.
  // ---------------------------------------------------------------------
  describe('criterion 2: clear(tabId) on tab close', () => {
    it('removes the persisted state -- a subsequent get() falls back to the Unknown default', async () => {
      const tabId = 99;
      const store = createVerdictStore();
      await store.set(tabId, { state: 'signed-out', confidence: 0.1, pendingSignedOutSince: null });

      await store.clear(tabId);

      await expect(store.get(tabId)).resolves.toEqual(UNKNOWN_VERDICT_STATE);
    });

    it('only removes the target tab -- other tabs are unaffected', async () => {
      const store = createVerdictStore();
      const stateForTab2: PersistedVerdictState = { state: 'signed-out', confidence: 0.1, pendingSignedOutSince: null };
      await store.set(1, { state: 'signed-in', confidence: 0.9, pendingSignedOutSince: null });
      await store.set(2, stateForTab2);

      await store.clear(1);

      await expect(store.get(1)).resolves.toEqual(UNKNOWN_VERDICT_STATE);
      await expect(store.get(2)).resolves.toEqual(stateForTab2);
    });

    it('clearing a tab with no persisted state is a safe no-op (does not throw)', async () => {
      const store = createVerdictStore();
      await expect(store.clear(404)).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // ROADMAP Phase 2 success criterion 3: the service worker waking with no
  // prior state for a tab gets a safe Unknown default, never a throw.
  // ---------------------------------------------------------------------
  describe('criterion 3: missing tab -> safe Unknown default, no throw', () => {
    it('get() for a tab with no prior state resolves to the Unknown default', async () => {
      const store = createVerdictStore();
      await expect(store.get(12_345)).resolves.toEqual(UNKNOWN_VERDICT_STATE);
    });

    it('the Unknown default is actually state "unknown" with zero confidence and no pending timer', () => {
      expect(UNKNOWN_VERDICT_STATE).toEqual({
        state: 'unknown',
        confidence: 0,
        pendingSignedOutSince: null,
      });
    });

    it('get() on a brand-new store with completely empty storage never throws', async () => {
      const store = createVerdictStore();
      await expect(store.get(1)).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------
  // Privacy boundary (PRV-01): only derived numbers/enums are persisted --
  // never raw session material -- in the underlying storage record.
  // ---------------------------------------------------------------------
  describe('persists only derived values', () => {
    it('the raw chrome.storage.session record contains only state/confidence/pendingSignedOutSince fields', async () => {
      const tabId = 3;
      await createVerdictStore().set(tabId, {
        state: 'signed-in',
        confidence: 0.77,
        pendingSignedOutSince: null,
      });

      const raw = await chrome.storage.session.get(null);
      const values = Object.values(raw);
      expect(values).toHaveLength(1);

      const [value] = values;
      expect(Object.keys(value as object).sort()).toEqual(['confidence', 'pendingSignedOutSince', 'state']);

      const persisted = value as PersistedVerdictState;
      expect(typeof persisted.state).toBe('string');
      expect(typeof persisted.confidence).toBe('number');
      expect(persisted.pendingSignedOutSince === null || typeof persisted.pendingSignedOutSince === 'number').toBe(
        true,
      );
    });
  });
});
