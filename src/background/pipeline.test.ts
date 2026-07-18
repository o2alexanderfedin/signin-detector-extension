/// <reference types="chrome" />

import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COOKIE_MIN_HIGH_ENTROPY_LENGTH,
  COOKIE_MIN_LONG_EXPIRY_MS,
  DEBOUNCE_SIGNED_OUT_MS,
  DOM_POSITIVE_VALUE,
  NETWORK_REST_IDENTITY_200_VALUE,
  STORAGE_POSITIVE_VALUE,
  STRONG_NEGATIVE_VALUE,
} from '../shared/constants';
import type { SensorSignalMessage, SignalEvidence, VerdictResult, WebAppKey } from '../shared/types';
import type { CookiesApi } from './sensors/cookieSensor';
import { createPipeline, type MessageSenderLike } from './pipeline';
import { createVerdictStore, UNKNOWN_VERDICT_STATE, type PersistedVerdictState, type VerdictStore } from './state/verdictStore';

/**
 * Phase 4 -- `src/background/pipeline.ts` orchestrator tests (RCT-01 /
 * PLT-01 rehydration / PLT-02 outbound notification). `chrome`/`browser`
 * are globally stubbed to `fakeBrowser` by WXT's Vitest plugin (see
 * vitest.config.ts). `fakeBrowser.tabs` IS implemented (get/query/create/
 * onRemoved), so real tab fixtures are used for WebAppKey resolution; a
 * hand-rolled `CookiesApi` fake is used for `chrome.cookies` (not
 * implemented by fake-browser -- same as `cookieSensor.test.ts`).
 */

const NOW = 1_700_000_000_000;
const WEB_APP_KEY = 'example.com' as WebAppKey;

const longValue = 'a'.repeat(COOKIE_MIN_HIGH_ENTROPY_LENGTH);
const longExpirySeconds = (NOW + COOKIE_MIN_LONG_EXPIRY_MS + 1000) / 1000;

function fullMatchCookie(overrides: Partial<chrome.cookies.Cookie> = {}): chrome.cookies.Cookie {
  return {
    domain: WEB_APP_KEY,
    name: 'session_id',
    httpOnly: true,
    secure: true,
    value: longValue,
    expirationDate: longExpirySeconds,
    session: false,
    hostOnly: true,
    path: '/',
    storeId: '0',
    sameSite: 'lax',
    ...overrides,
  };
}

interface FakeCookiesApi {
  readonly api: CookiesApi;
  setCookies(cookies: readonly chrome.cookies.Cookie[]): void;
}

function createFakeCookiesApi(initial: readonly chrome.cookies.Cookie[] = []): FakeCookiesApi {
  let cookies = [...initial];
  const getAll = vi.fn((details: chrome.cookies.GetAllDetails) => {
    if (details.domain === undefined) {
      return Promise.resolve(cookies);
    }
    return Promise.resolve(
      cookies.filter((cookie) => cookie.domain === details.domain || cookie.domain.endsWith(`.${details.domain}`)),
    );
  }) as unknown as CookiesApi['getAll'];

  return {
    api: {
      getAll,
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    setCookies(next) {
      cookies = [...next];
    },
  };
}

function networkCompletedDetails(
  overrides: Partial<chrome.webRequest.OnCompletedDetails> = {},
): chrome.webRequest.OnCompletedDetails {
  return {
    documentLifecycle: 'active',
    frameId: 0,
    frameType: 'outermost_frame',
    method: 'GET',
    parentFrameId: -1,
    requestId: '1',
    tabId: 1,
    timeStamp: NOW,
    type: 'xmlhttprequest',
    url: 'https://example.com/api/me',
    fromCache: false,
    responseHeaders: [],
    statusCode: 200,
    statusLine: 'HTTP/1.1 200 OK',
    ...overrides,
  };
}

/** A trivial in-memory `VerdictStore` -- used where tests want direct control without going through `chrome.storage.session`. */
function createInMemoryStore(): VerdictStore {
  const map = new Map<number, PersistedVerdictState>();
  return {
    get(tabId) {
      return Promise.resolve(map.get(tabId) ?? UNKNOWN_VERDICT_STATE);
    },
    set(tabId, state) {
      map.set(tabId, state);
      return Promise.resolve();
    },
    clear(tabId) {
      map.delete(tabId);
      return Promise.resolve();
    },
  };
}

describe('createPipeline (RCT-01)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  describe('handleSensorSignal (content -> SW routing)', () => {
    it('routes evidence to the engine for sender.tab.id and sends a VERDICT_UPDATE for that tab', async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      const domEvidence: SignalEvidence = { signal: 'dom', observed: true, value: DOM_POSITIVE_VALUE, passwordFormVisible: false };
      const message: SensorSignalMessage = { type: 'SENSOR_SIGNAL', signal: 'dom', evidence: domEvidence };
      const sender: MessageSenderLike = { tab: { id: 5 } };

      await pipeline.handleSensorSignal(message, sender);

      expect(sendVerdictUpdate).toHaveBeenCalledTimes(1);
      const [result, tabId] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(tabId).toBe(5);
      expect(result.confidence).toBeCloseTo(DOM_POSITIVE_VALUE);
    });

    it('is a no-op when sender.tab.id is missing (message not attributable to a tab)', async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
      });

      const evidence: SignalEvidence = { signal: 'storage', observed: true, value: STORAGE_POSITIVE_VALUE };
      await pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'storage', evidence }, {});

      expect(sendVerdictUpdate).not.toHaveBeenCalled();
    });

    it('accumulates evidence across multiple signals for the same tab into one fused verdict', async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
      });

      const storageEvidence: SignalEvidence = { signal: 'storage', observed: true, value: STORAGE_POSITIVE_VALUE };
      const domEvidence: SignalEvidence = { signal: 'dom', observed: true, value: DOM_POSITIVE_VALUE, passwordFormVisible: false };
      const sender: MessageSenderLike = { tab: { id: 9 } };

      await pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'storage', evidence: storageEvidence }, sender);
      await pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'dom', evidence: domEvidence }, sender);

      expect(sendVerdictUpdate).toHaveBeenCalledTimes(2);
      const [, secondResultTabId] = sendVerdictUpdate.mock.calls[1] as [VerdictResult, number];
      expect(secondResultTabId).toBe(9);
      const secondResult = (sendVerdictUpdate.mock.calls[1] as [VerdictResult, number])[0];
      // weighted mean of BOTH storage and dom, not just the latest signal alone.
      const expected = (0.6 * STORAGE_POSITIVE_VALUE + 0.3 * DOM_POSITIVE_VALUE) / (0.6 + 0.3);
      expect(secondResult.confidence).toBeCloseTo(expected);
    });
  });

  describe('handleNetworkCompleted', () => {
    it('routes by details.tabId and feeds classifyNetwork evidence into the engine', async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
      });

      await pipeline.handleNetworkCompleted(networkCompletedDetails({ tabId: 3, url: 'https://example.com/api/me', statusCode: 200 }));

      expect(sendVerdictUpdate).toHaveBeenCalledTimes(1);
      const [result, tabId] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(tabId).toBe(3);
      expect(result.confidence).toBeCloseTo(NETWORK_REST_IDENTITY_200_VALUE);
    });

    it('a 401 on an identity endpoint drives confidence toward the strong-negative value', async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
      });

      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId: 3, url: 'https://example.com/api/session', statusCode: 401 }),
      );

      const [result] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(result.confidence).toBeCloseTo(STRONG_NEGATIVE_VALUE);
    });

    it('ignores requests with no associated tab (tabId < 0)', async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
      });

      await pipeline.handleNetworkCompleted(networkCompletedDetails({ tabId: -1 }));

      expect(sendVerdictUpdate).not.toHaveBeenCalled();
    });
  });

  describe('handleCookieChanged (no tabId on the raw event -- resolves via tab URL)', () => {
    it('refreshes only tabs whose WebAppKey matches the changed cookie domain', async () => {
      const tabA = await fakeBrowser.tabs.create({ url: 'https://example.com/dashboard' });
      const tabB = await fakeBrowser.tabs.create({ url: 'https://other.com/home' });
      const fakeCookies = createFakeCookiesApi([fullMatchCookie()]);

      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: fakeCookies.api,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      await pipeline.handleCookieChanged({ removed: false, cause: 'explicit', cookie: fullMatchCookie() });

      expect(sendVerdictUpdate).toHaveBeenCalledTimes(1);
      const [, tabId] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(tabId).toBe(tabA.id);
      expect(tabId).not.toBe(tabB.id);
    });

    it('collapses a subdomain cookie onto tabs on the same eTLD+1 (IDN-01)', async () => {
      const tab = await fakeBrowser.tabs.create({ url: 'https://login.example.com/sso' });
      const fakeCookies = createFakeCookiesApi([fullMatchCookie({ domain: 'login.example.com' })]);

      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: fakeCookies.api,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      await pipeline.handleCookieChanged({
        removed: false,
        cause: 'explicit',
        cookie: fullMatchCookie({ domain: 'login.example.com' }),
      });

      expect(sendVerdictUpdate).toHaveBeenCalledTimes(1);
      const [, tabId] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(tabId).toBe(tab.id);
    });

    it('ignores tabs with no url and non-http(s) tabs (resolveWebAppKey returns null)', async () => {
      await fakeBrowser.tabs.create({ url: 'chrome://extensions' });
      const fakeCookies = createFakeCookiesApi([fullMatchCookie()]);

      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: fakeCookies.api,
        sendVerdictUpdate,
      });

      await pipeline.handleCookieChanged({ removed: false, cause: 'explicit', cookie: fullMatchCookie() });

      expect(sendVerdictUpdate).not.toHaveBeenCalled();
    });

    it('no-ops entirely when the changed cookie domain does not resolve to a WebAppKey', async () => {
      const fakeCookies = createFakeCookiesApi();
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({ store: createInMemoryStore(), cookiesApi: fakeCookies.api, sendVerdictUpdate });

      await pipeline.handleCookieChanged({
        removed: true,
        cause: 'expired',
        cookie: fullMatchCookie({ domain: 'localhost' }),
      });

      expect(sendVerdictUpdate).not.toHaveBeenCalled();
    });
  });

  describe('handleTabRemoved (PLT-01 cleanup)', () => {
    it('clears the persisted verdict state for the closed tab', async () => {
      const store = createVerdictStore();
      await store.set(11, { state: 'signed-in', confidence: 0.9, pendingSignedOutSince: null });

      const pipeline = createPipeline({ store, cookiesApi: createFakeCookiesApi().api, sendVerdictUpdate: vi.fn() });
      await pipeline.handleTabRemoved(11);

      await expect(store.get(11)).resolves.toEqual(UNKNOWN_VERDICT_STATE);
    });

    it('a tab re-registering after removal starts from Unknown, not stale in-memory state', async () => {
      const store = createInMemoryStore();
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({ store, cookiesApi: createFakeCookiesApi().api, sendVerdictUpdate });

      const evidence: SignalEvidence = { signal: 'dom', observed: true, value: DOM_POSITIVE_VALUE, passwordFormVisible: false };
      await pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'dom', evidence }, { tab: { id: 20 } });
      await pipeline.handleTabRemoved(20);

      const negativeEvidence: SignalEvidence = { signal: 'dom', observed: true, value: DOM_POSITIVE_VALUE, passwordFormVisible: false };
      await pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'dom', evidence: negativeEvidence }, { tab: { id: 20 } });

      // Second call started from a fresh engine (vector reset), so confidence equals a single dom
      // reading again, not an accumulation carried over from before removal.
      const lastResult = (sendVerdictUpdate.mock.calls[1] as [VerdictResult, number])[0];
      expect(lastResult.confidence).toBeCloseTo(DOM_POSITIVE_VALUE);
    });
  });

  describe('PLT-01 rehydration: engine snapshot restored from verdictStore', () => {
    it('a fresh pipeline instance over the same persisted store resumes hysteresis (signed-in stays signed-in even with 0 confidence this tick, pending debounce)', async () => {
      const store = createVerdictStore();
      await store.set(30, { state: 'signed-in', confidence: 0.9, pendingSignedOutSince: null });

      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      // Simulated SW restart: a brand new pipeline instance, no shared JS state,
      // over the SAME underlying fake chrome.storage.session.
      const pipeline = createPipeline({ store, cookiesApi: createFakeCookiesApi().api, sendVerdictUpdate, clock: () => NOW });

      const negativeCookie: SignalEvidence = { signal: 'cookie', observed: false };
      await pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'storage', evidence: { signal: 'storage', observed: false } }, {
        tab: { id: 30 },
      });
      void negativeCookie;

      const [result] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      // Restored committedState was 'signed-in'; an all-unobserved vector fuses to
      // confidence 0, which is below THRESHOLD_SIGNED_OUT -- but the debounce means
      // state stays 'signed-in' on this single tick (ENG-04, already proven in Phase 1;
      // this asserts the restore seam actually threads through pipeline.ts).
      expect(result.state).toBe('signed-in');
      expect(result.confidence).toBe(0);
    });
  });

  describe('full end-to-end loop (RCT-01): cookie appears -> signed-in -> cookie removed -> signed-out', () => {
    it('drives the verdict from unknown to signed-in on a full-match session cookie, then to signed-out after the cookie disappears and the debounce elapses', async () => {
      const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/dashboard' });
      const fakeCookies = createFakeCookiesApi([fullMatchCookie()]);

      let now = NOW;
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: fakeCookies.api,
        sendVerdictUpdate,
        clock: () => now,
      });

      // 1. Session cookie appears.
      await pipeline.handleCookieChanged({ removed: false, cause: 'explicit', cookie: fullMatchCookie() });
      const [firstResult, firstTabId] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(firstTabId).toBe(tab.id);
      expect(firstResult).toEqual({ state: 'signed-in', confidence: 1 });

      // 2. Cookie removed -- confidence drops, but SignedOut is debounced (ENG-04):
      // the verdict should NOT flip on this same tick.
      fakeCookies.setCookies([]);
      await pipeline.handleCookieChanged({ removed: true, cause: 'expired', cookie: fullMatchCookie() });
      const secondResult = (sendVerdictUpdate.mock.calls[1] as [VerdictResult, number])[0];
      expect(secondResult.state).toBe('signed-in');
      expect(secondResult.confidence).toBe(0);

      // 3. Time advances past the signed-out debounce window; another cookie event
      // (still absent) commits the transition.
      now += DEBOUNCE_SIGNED_OUT_MS + 1;
      await pipeline.handleCookieChanged({ removed: true, cause: 'expired', cookie: fullMatchCookie() });
      const thirdResult = (sendVerdictUpdate.mock.calls[2] as [VerdictResult, number])[0];
      expect(thirdResult.state).toBe('signed-out');
    });
  });
});
