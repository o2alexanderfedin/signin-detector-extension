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
    initiator: 'https://example.com',
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

    it('fuses signals that arrive together for a tab the worker has not seen yet (none is dropped while its state loads)', async () => {
      // chrome.storage.session is asynchronous: while the first event for a
      // tab waits for its persisted snapshot, a second event for the same tab
      // can arrive. Hold the store read open until both are in flight.
      const store = createInMemoryStore();
      let releaseRead: () => void = () => {};
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const gatedStore: VerdictStore = {
        ...store,
        async get(tabId) {
          await readGate;
          return store.get(tabId);
        },
      };
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({ store: gatedStore, cookiesApi: createFakeCookiesApi().api, sendVerdictUpdate });

      const storageEvidence: SignalEvidence = { signal: 'storage', observed: true, value: STORAGE_POSITIVE_VALUE };
      const domEvidence: SignalEvidence = { signal: 'dom', observed: true, value: DOM_POSITIVE_VALUE, passwordFormVisible: false };
      const sender: MessageSenderLike = { tab: { id: 12 } };

      const first = pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'storage', evidence: storageEvidence }, sender);
      const second = pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'dom', evidence: domEvidence }, sender);
      releaseRead();
      await Promise.all([first, second]);

      expect(sendVerdictUpdate).toHaveBeenCalledTimes(2);
      const lastResult = (sendVerdictUpdate.mock.calls[1] as [VerdictResult, number])[0];
      const expected = (0.6 * STORAGE_POSITIVE_VALUE + 0.3 * DOM_POSITIVE_VALUE) / (0.6 + 0.3);
      expect(lastResult.confidence).toBeCloseTo(expected);

      // The persisted snapshot is the fused one too, so a worker restart resumes from it.
      await expect(store.get(12)).resolves.toMatchObject({ confidence: expect.closeTo(expected) as number });
    });

    it('a failed state read for a tab does not break that tab for good: its next event loads again', async () => {
      const store = createInMemoryStore();
      let failNextRead = true;
      const flakyStore: VerdictStore = {
        ...store,
        get(tabId) {
          if (failNextRead) {
            failNextRead = false;
            return Promise.reject(new Error('storage unavailable'));
          }
          return store.get(tabId);
        },
      };
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({ store: flakyStore, cookiesApi: createFakeCookiesApi().api, sendVerdictUpdate });

      const domEvidence: SignalEvidence = { signal: 'dom', observed: true, value: DOM_POSITIVE_VALUE, passwordFormVisible: false };
      const message: SensorSignalMessage = { type: 'SENSOR_SIGNAL', signal: 'dom', evidence: domEvidence };

      await expect(pipeline.handleSensorSignal(message, { tab: { id: 13 } })).rejects.toThrow('storage unavailable');
      await pipeline.handleSensorSignal(message, { tab: { id: 13 } });

      expect(sendVerdictUpdate).toHaveBeenCalledTimes(1);
      const [result] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(result.confidence).toBeCloseTo(DOM_POSITIVE_VALUE);
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

    it('a signed-out visitor on a login page that names an account page in its query string is not shown as signed in', async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId: 3, type: 'main_frame', url: 'https://example.com/login?next=/account', statusCode: 200 }),
      );

      const [result] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(result).toEqual({ state: 'unknown', confidence: 0 });
    });

    it("a signed-out visitor is not shown as signed in because a widget from another site gets its own user's identity", async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId: 3, url: 'https://widget.chat.io/api/me', initiator: 'https://example.com' }),
      );

      const [result] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(result).toEqual({ state: 'unknown', confidence: 0 });
    });

    it("a signed-in user's verdict is not pulled toward signed-out by another site's 401", async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      await pipeline.handleNetworkCompleted(networkCompletedDetails({ tabId: 3, url: 'https://example.com/api/me' }));
      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId: 3, url: 'https://ads.net/user', statusCode: 401, initiator: 'https://example.com' }),
      );

      const [result] = sendVerdictUpdate.mock.calls[1] as [VerdictResult, number];
      expect(result).toEqual({ state: 'signed-in', confidence: NETWORK_REST_IDENTITY_200_VALUE });
    });

    it("a request from an embedded frame is not counted while the tab's own site is not yet known", async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId: 3, frameId: 4, parentFrameId: 0, url: 'https://widget.chat.io/api/me', initiator: 'https://widget.chat.io' }),
      );

      const [result] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(result).toEqual({ state: 'unknown', confidence: 0 });
    });

    it('a request to a subdomain of the same site still counts (IDN-01)', async () => {
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi().api,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId: 3, url: 'https://api.example.com/v1/me', initiator: 'https://www.example.com' }),
      );

      const [result] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(result).toEqual({ state: 'signed-in', confidence: NETWORK_REST_IDENTITY_200_VALUE });
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

    /**
     * A cookie change waits twice before it touches a tab's state: for the tab list, then for the
     * tab's cookies. Closing the tab during either wait must leave nothing behind. `hold` picks
     * which wait is held open while the tab closes.
     */
    async function closeTabDuringCookieChange(hold: 'tab-list' | 'cookie-lookup'): Promise<void> {
      const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/dashboard' });
      const tabId = tab.id as number;
      const fakeCookies = createFakeCookiesApi([fullMatchCookie()]);

      let releaseWait: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      let markWaiting: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        markWaiting = resolve;
      });
      const heldCookiesApi: CookiesApi = {
        ...fakeCookies.api,
        getAll: async (details: chrome.cookies.GetAllDetails) => {
          if (hold === 'cookie-lookup') {
            markWaiting();
            await gate;
          }
          return fakeCookies.api.getAll(details);
        },
      };
      const heldTabsApi = {
        async query(): Promise<chrome.tabs.Tab[]> {
          const tabs = (await fakeBrowser.tabs.query({})) as chrome.tabs.Tab[];
          if (hold === 'tab-list') {
            markWaiting();
            await gate;
          }
          return tabs;
        },
      };

      const store = createInMemoryStore();
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store,
        cookiesApi: heldCookiesApi,
        tabsApi: heldTabsApi,
        sendVerdictUpdate,
        clock: () => NOW,
      });

      const lateEvent = pipeline.handleCookieChanged({ removed: false, cause: 'explicit', cookie: fullMatchCookie() });
      await waiting;
      await pipeline.handleTabRemoved(tabId);
      releaseWait();
      await lateEvent;

      // Nothing saved for the closed tab, and no verdict sent to it.
      await expect(store.get(tabId)).resolves.toBe(UNKNOWN_VERDICT_STATE);
      expect(sendVerdictUpdate).not.toHaveBeenCalled();

      // The same tab id used again starts clean: its verdict is the new signal alone, with no
      // cookie evidence carried over from the closed tab.
      const domEvidence: SignalEvidence = { signal: 'dom', observed: true, value: DOM_POSITIVE_VALUE, passwordFormVisible: false };
      await pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'dom', evidence: domEvidence }, { tab: { id: tabId } });
      expect(sendVerdictUpdate).toHaveBeenCalledTimes(1);
      const [reusedResult] = sendVerdictUpdate.mock.calls[0] as [VerdictResult, number];
      expect(reusedResult.confidence).toBeCloseTo(DOM_POSITIVE_VALUE);
    }

    it('a tab closed while the cookie lookup for it is still pending leaves nothing saved behind, and a reused tab id starts clean', async () => {
      await closeTabDuringCookieChange('cookie-lookup');
    });

    it('a tab closed while the tab list for a cookie change is still pending leaves nothing saved behind, and a reused tab id starts clean', async () => {
      await closeTabDuringCookieChange('tab-list');
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

    it('a tab closed while its first event is still loading state leaves nothing saved behind, and a reused tab id starts clean', async () => {
      // Hold the first read of the tab's snapshot open, close the tab, then let the read finish.
      const store = createInMemoryStore();
      let releaseRead: () => void = () => {};
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let gateReads = true;
      const readsSeen: PersistedVerdictState[] = [];
      const gatedStore: VerdictStore = {
        ...store,
        async get(tabId) {
          if (gateReads) {
            gateReads = false;
            await readGate;
          }
          const snapshot = await store.get(tabId);
          readsSeen.push(snapshot as PersistedVerdictState);
          return snapshot;
        },
      };
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({ store: gatedStore, cookiesApi: createFakeCookiesApi().api, sendVerdictUpdate });

      const domEvidence: SignalEvidence = { signal: 'dom', observed: true, value: DOM_POSITIVE_VALUE, passwordFormVisible: false };
      const lateEvent = pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'dom', evidence: domEvidence }, { tab: { id: 30 } });
      await pipeline.handleTabRemoved(30);
      releaseRead();
      await lateEvent;

      // Nothing saved for the closed tab, and no verdict sent to it.
      await expect(store.get(30)).resolves.toBe(UNKNOWN_VERDICT_STATE);
      expect(sendVerdictUpdate).not.toHaveBeenCalled();

      // The same tab id used again loads the empty default, not the closed tab's leftovers.
      await pipeline.handleSensorSignal({ type: 'SENSOR_SIGNAL', signal: 'dom', evidence: domEvidence }, { tab: { id: 30 } });
      expect(readsSeen).toHaveLength(2);
      expect(readsSeen[1]).toBe(UNKNOWN_VERDICT_STATE);
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

  describe('a tab that moves to a different web application starts over (IDN-01 / IDN-02)', () => {
    const domNotObserved: SignalEvidence = { signal: 'dom', observed: false };
    const domMessage: SensorSignalMessage = { type: 'SENSOR_SIGNAL', signal: 'dom', evidence: domNotObserved };

    async function signedInOnExample() {
      const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/dashboard' });
      const tabId = tab.id ?? -1;
      const sendVerdictUpdate = vi.fn().mockResolvedValue(undefined);
      const pipeline = createPipeline({
        store: createInMemoryStore(),
        cookiesApi: createFakeCookiesApi([fullMatchCookie()]).api,
        sendVerdictUpdate,
        clock: () => NOW,
      });
      await pipeline.handleCookieChanged({ removed: false, cause: 'explicit', cookie: fullMatchCookie() });
      expect(sendVerdictUpdate.mock.calls[0]).toEqual([{ state: 'signed-in', confidence: 1 }, tabId]);
      return { tabId, pipeline, sendVerdictUpdate };
    }

    function lastResult(sendVerdictUpdate: ReturnType<typeof vi.fn>): VerdictResult {
      return (sendVerdictUpdate.mock.calls.at(-1) as [VerdictResult, number])[0];
    }

    it("a page on another site does not inherit the previous site's signed-in verdict or its cookie evidence", async () => {
      const { tabId, pipeline, sendVerdictUpdate } = await signedInOnExample();

      await pipeline.handleSensorSignal(domMessage, { tab: { id: tabId, url: 'https://other.org/' } });

      expect(lastResult(sendVerdictUpdate)).toEqual({ state: 'unknown', confidence: 0 });
    });

    it("a request made by a page on another site does not inherit the previous site's verdict either", async () => {
      const { tabId, pipeline, sendVerdictUpdate } = await signedInOnExample();

      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId, type: 'script', url: 'https://cdn.other.org/app.js', initiator: 'https://other.org' }),
      );

      expect(lastResult(sendVerdictUpdate)).toEqual({ state: 'unknown', confidence: 0 });
    });

    it('a top-level load of another domain does not reset the tab by itself (it may be a download that leaves the page in place)', async () => {
      const { tabId, pipeline, sendVerdictUpdate } = await signedInOnExample();

      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId, type: 'main_frame', url: 'https://files.cdn.net/report.pdf', initiator: 'https://example.com' }),
      );

      expect(lastResult(sendVerdictUpdate)).toEqual({ state: 'signed-in', confidence: 1 });
    });

    it('a request from a sub-frame of another site does not reset the tab', async () => {
      const { tabId, pipeline, sendVerdictUpdate } = await signedInOnExample();

      await pipeline.handleNetworkCompleted(
        networkCompletedDetails({ tabId, frameId: 3, parentFrameId: 0, type: 'xmlhttprequest', url: 'https://ads.net/x', initiator: 'https://ads.net' }),
      );

      expect(lastResult(sendVerdictUpdate)).toEqual({ state: 'signed-in', confidence: 1 });
    });

    it('a route change within the same registrable domain keeps the evidence (no re-keying on SPA routes)', async () => {
      const { tabId, pipeline, sendVerdictUpdate } = await signedInOnExample();

      await pipeline.handleSensorSignal(domMessage, { tab: { id: tabId, url: 'https://www.example.com/settings' } });

      expect(lastResult(sendVerdictUpdate)).toEqual({ state: 'signed-in', confidence: 1 });
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
