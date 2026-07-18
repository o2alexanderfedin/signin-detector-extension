/// <reference types="chrome" />

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COOKIE_DENYLISTED_VALUE,
  COOKIE_MIN_HIGH_ENTROPY_LENGTH,
  COOKIE_MIN_LONG_EXPIRY_MS,
  COOKIE_PARTIAL_VALUE,
  COOKIE_POSITIVE_VALUE,
} from '../../shared/constants';
import type { WebAppKey } from '../../shared/types';
import { createCookieSensor, type CookiesApi } from './cookieSensor';

/**
 * Background cookie sensor glue (Phase 3, workstream 1).
 *
 * `@webext-core/fake-browser` does not implement `chrome.cookies` (it's
 * not in its `BrowserOverrides` list), so we hand-roll a minimal fake for
 * exactly the `CookiesApi` subset (`getAll` + `onChanged.addListener` /
 * `removeListener`) this sensor depends on -- the same "inject the chrome
 * namespace" approach `verdictStore.ts` uses for `chrome.storage.session`.
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

/** A session cookie has no `expirationDate` at all -- not `expirationDate: undefined`. */
function sessionCookie(overrides: Partial<chrome.cookies.Cookie> = {}): chrome.cookies.Cookie {
  return {
    domain: WEB_APP_KEY,
    name: 'session_id',
    httpOnly: true,
    secure: true,
    value: longValue,
    session: true,
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
  triggerChanged(changeInfo: chrome.cookies.CookieChangeInfo): void;
  listenerCount(): number;
}

function createFakeCookiesApi(initial: readonly chrome.cookies.Cookie[] = []): FakeCookiesApi {
  let cookies = [...initial];
  const listeners: Array<(changeInfo: chrome.cookies.CookieChangeInfo) => void> = [];

  const getAll = vi.fn((details: chrome.cookies.GetAllDetails) => {
    if (details.domain === undefined) {
      return Promise.resolve(cookies);
    }
    return Promise.resolve(
      cookies.filter(
        (cookie) => cookie.domain === details.domain || cookie.domain.endsWith(`.${details.domain}`),
      ),
    );
  }) as unknown as CookiesApi['getAll'];

  return {
    api: {
      getAll,
      onChanged: {
        addListener: (callback) => listeners.push(callback),
        removeListener: (callback) => {
          const index = listeners.indexOf(callback);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        },
      },
    },
    setCookies(next) {
      cookies = [...next];
    },
    triggerChanged(changeInfo) {
      listeners.forEach((listener) => listener(changeInfo));
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

describe('createCookieSensor (background glue)', () => {
  let fake: FakeCookiesApi;

  beforeEach(() => {
    fake = createFakeCookiesApi();
  });

  describe('getEvidence -- reuses the pure classifyCookie classifier', () => {
    it('calls chrome.cookies.getAll scoped to the WebAppKey domain', async () => {
      fake.setCookies([fullMatchCookie()]);
      const sensor = createCookieSensor(fake.api);

      await sensor.getEvidence(WEB_APP_KEY, () => NOW);

      expect(fake.api.getAll).toHaveBeenCalledWith({ domain: WEB_APP_KEY });
    });

    it('returns observed:false when no cookies exist for the WebAppKey', async () => {
      const sensor = createCookieSensor(fake.api);

      const result = await sensor.getEvidence(WEB_APP_KEY, () => NOW);

      expect(result).toEqual({ signal: 'cookie', observed: false });
    });

    it('maps a full-match chrome.cookies.Cookie into classifyCookie input and returns COOKIE_POSITIVE_VALUE', async () => {
      fake.setCookies([fullMatchCookie()]);
      const sensor = createCookieSensor(fake.api);

      const result = await sensor.getEvidence(WEB_APP_KEY, () => NOW);

      expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_POSITIVE_VALUE });
    });

    it('converts expirationDate from seconds (chrome) to milliseconds (CookieInput)', async () => {
      // A cookie with a long expiry in *seconds* form should still classify
      // as a full match once correctly converted to ms -- proving the unit
      // conversion, not just pass-through.
      fake.setCookies([fullMatchCookie({ expirationDate: longExpirySeconds })]);
      const sensor = createCookieSensor(fake.api);

      const result = await sensor.getEvidence(WEB_APP_KEY, () => NOW);

      expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_POSITIVE_VALUE });
    });

    it('treats a session cookie (no expirationDate) as short-expiry -- COOKIE_PARTIAL_VALUE', async () => {
      fake.setCookies([sessionCookie()]);
      const sensor = createCookieSensor(fake.api);

      const result = await sensor.getEvidence(WEB_APP_KEY, () => NOW);

      expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_PARTIAL_VALUE });
    });

    it('returns COOKIE_DENYLISTED_VALUE for a denylisted tracking cookie name (delegates to classifyCookie, SEN-02)', async () => {
      fake.setCookies([fullMatchCookie({ name: '_ga' })]);
      const sensor = createCookieSensor(fake.api);

      const result = await sensor.getEvidence(WEB_APP_KEY, () => NOW);

      expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_DENYLISTED_VALUE });
    });

    it('defaults `now` to Date.now when not provided', async () => {
      const sensor = createCookieSensor(fake.api);
      await expect(sensor.getEvidence(WEB_APP_KEY)).resolves.toEqual({
        signal: 'cookie',
        observed: false,
      });
    });
  });

  describe('watch -- subscribes to chrome.cookies.onChanged', () => {
    it('registers a listener on cookiesApi.onChanged', () => {
      const sensor = createCookieSensor(fake.api);
      sensor.watch(WEB_APP_KEY, () => {});

      expect(fake.listenerCount()).toBe(1);
    });

    it('re-classifies and invokes onEvidence when a cookie for the watched WebAppKey changes', async () => {
      fake.setCookies([fullMatchCookie()]);
      const sensor = createCookieSensor(fake.api);
      const onEvidence = vi.fn();
      sensor.watch(WEB_APP_KEY, onEvidence, () => NOW);

      fake.triggerChanged({ removed: false, cause: 'explicit', cookie: fullMatchCookie() });
      await Promise.resolve();
      await Promise.resolve();

      expect(onEvidence).toHaveBeenCalledWith({
        signal: 'cookie',
        observed: true,
        value: COOKIE_POSITIVE_VALUE,
      });
    });

    it('ignores a changed cookie belonging to a different domain', async () => {
      const sensor = createCookieSensor(fake.api);
      const onEvidence = vi.fn();
      sensor.watch(WEB_APP_KEY, onEvidence);

      fake.triggerChanged({
        removed: false,
        cause: 'explicit',
        cookie: fullMatchCookie({ domain: 'other.com' }),
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(onEvidence).not.toHaveBeenCalled();
    });

    it('treats a subdomain cookie (e.g. .example.com / login.example.com) as belonging to the WebAppKey (IDN-01 domain collapsing)', async () => {
      fake.setCookies([fullMatchCookie({ domain: 'login.example.com' })]);
      const sensor = createCookieSensor(fake.api);
      const onEvidence = vi.fn();
      sensor.watch(WEB_APP_KEY, onEvidence, () => NOW);

      fake.triggerChanged({
        removed: false,
        cause: 'explicit',
        cookie: fullMatchCookie({ domain: 'login.example.com' }),
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(onEvidence).toHaveBeenCalledWith({
        signal: 'cookie',
        observed: true,
        value: COOKIE_POSITIVE_VALUE,
      });
    });

    it('returns an unsubscribe function that removes the listener', () => {
      const sensor = createCookieSensor(fake.api);
      const unsubscribe = sensor.watch(WEB_APP_KEY, () => {});
      expect(fake.listenerCount()).toBe(1);

      unsubscribe();

      expect(fake.listenerCount()).toBe(0);
    });

    it('no longer invokes onEvidence after unsubscribe', async () => {
      const sensor = createCookieSensor(fake.api);
      const onEvidence = vi.fn();
      const unsubscribe = sensor.watch(WEB_APP_KEY, onEvidence);
      unsubscribe();

      fake.triggerChanged({ removed: false, cause: 'explicit', cookie: fullMatchCookie() });
      await Promise.resolve();
      await Promise.resolve();

      expect(onEvidence).not.toHaveBeenCalled();
    });
  });

  describe('privacy boundary (PRV-01): never reads cookie value for meaning', () => {
    it('only forwards name/httpOnly/secure/value(length)/expirationDateMs -- classifyCookie result is shape-derived, not content-derived', async () => {
      fake.setCookies([fullMatchCookie({ value: 'totally-different-but-same-length-' + 'x'.repeat(10) })]);
      const sensor = createCookieSensor(fake.api);

      const result = await sensor.getEvidence(WEB_APP_KEY, () => NOW);

      // Same shape (httpOnly/secure/long-enough value/long expiry) -> same
      // classification regardless of the actual value content.
      expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_POSITIVE_VALUE });
    });
  });
});
