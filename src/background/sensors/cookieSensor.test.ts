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
 * exactly the `CookiesApi` subset this sensor depends on -- the same "inject the chrome
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
}

function createFakeCookiesApi(initial: readonly chrome.cookies.Cookie[] = []): FakeCookiesApi {
  let cookies = [...initial];

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
      getAllCookieStores: vi.fn().mockResolvedValue([]),
    },
    setCookies(next) {
      cookies = [...next];
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

    it("reads the named cookie store when given one (a private window's or a container's own cookies)", async () => {
      const sensor = createCookieSensor(fake.api);

      await sensor.getEvidence(WEB_APP_KEY, () => NOW, '1');

      expect(fake.api.getAll).toHaveBeenCalledWith({ domain: WEB_APP_KEY, storeId: '1' });
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
