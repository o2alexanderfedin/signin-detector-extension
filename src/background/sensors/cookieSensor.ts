/// <reference types="chrome" />

import { classifyCookie, type CookieInput } from '../../sensors/cookie/classify';
import type { ClockFn, SignalEvidence, WebAppKey } from '../../shared/types';

/**
 * The subset of `chrome.cookies` this sensor depends on -- injectable so
 * it's unit-testable without a real browser. `@webext-core/fake-browser`
 * does not implement `chrome.cookies` (see `cookieSensor.test.ts`), so
 * this narrow shape is what test fakes need to satisfy -- the same
 * pattern `verdictStore.ts` uses for `chrome.storage.session`.
 */
export interface CookiesApi {
  getAll: typeof chrome.cookies.getAll;
  /** Which tabs use which cookie store: private windows and Firefox containers each keep their own cookies. */
  getAllCookieStores: typeof chrome.cookies.getAllCookieStores;
}

export interface CookieSensor {
  /**
   * One-shot: fetches every cookie for `webAppKey`'s registrable domain
   * (and its subdomains -- `chrome.cookies.getAll`'s `domain` filter
   * already implements IDN-01 collapsing) and hands them to the pure
   * `classifyCookie` classifier. This module never scores a cookie
   * itself -- it only adapts real Chrome data into the classifier's
   * input shape.
   *
   * `storeId` names the cookie store to read -- a private window or a Firefox container keeps its
   * own cookies, so a tab must be judged by its own store. Without it, the regular store is read.
   */
  getEvidence(webAppKey: WebAppKey, now?: ClockFn, storeId?: string): Promise<SignalEvidence>;
}

/**
 * Maps a real `chrome.cookies.Cookie` into the pure classifier's
 * `CookieInput` shape. `expirationDate` is Chrome's seconds-since-epoch;
 * `CookieInput.expirationDateMs` is milliseconds. `value` is forwarded
 * as-is -- `classifyCookie` only ever inspects its length, never its
 * content (PRV-01).
 */
function toCookieInput(cookie: chrome.cookies.Cookie): CookieInput {
  const base = {
    name: cookie.name,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    value: cookie.value,
  };
  // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
  // optional field -- the key must be entirely absent for a session
  // cookie (no expirationDate), not present-with-undefined.
  return cookie.expirationDate === undefined
    ? base
    : { ...base, expirationDateMs: cookie.expirationDate * 1000 };
}

/**
 * Creates a {@link CookieSensor}. `cookiesApi` defaults to the real
 * `chrome.cookies` and is injectable for testing.
 */
export function createCookieSensor(cookiesApi: CookiesApi = chrome.cookies): CookieSensor {
  async function getEvidence(webAppKey: WebAppKey, now: ClockFn = Date.now, storeId?: string): Promise<SignalEvidence> {
    const cookies = await cookiesApi.getAll(storeId === undefined ? { domain: webAppKey } : { domain: webAppKey, storeId });
    return classifyCookie(cookies.map(toCookieInput), now());
  }

  return { getEvidence };
}
