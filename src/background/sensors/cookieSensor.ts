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
  onChanged: Pick<typeof chrome.cookies.onChanged, 'addListener' | 'removeListener'>;
}

export interface CookieSensor {
  /**
   * One-shot: fetches every cookie for `webAppKey`'s registrable domain
   * (and its subdomains -- `chrome.cookies.getAll`'s `domain` filter
   * already implements IDN-01 collapsing) and hands them to the pure
   * `classifyCookie` classifier. This module never scores a cookie
   * itself -- it only adapts real Chrome data into the classifier's
   * input shape.
   */
  getEvidence(webAppKey: WebAppKey, now?: ClockFn): Promise<SignalEvidence>;
  /**
   * Subscribes to `chrome.cookies.onChanged`, re-running `getEvidence`
   * and invoking `onEvidence` whenever a cookie belonging to
   * `webAppKey`'s domain (or a subdomain) changes. Returns an
   * unsubscribe function.
   */
  watch(webAppKey: WebAppKey, onEvidence: (evidence: SignalEvidence) => void, now?: ClockFn): () => void;
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
 * True when `domain` (a raw `chrome.cookies` domain, possibly prefixed
 * with a leading `.` for domain-scoped cookies) is `webAppKey` itself or
 * a subdomain of it.
 */
function belongsToWebAppKey(domain: string, webAppKey: WebAppKey): boolean {
  const host = domain.replace(/^\./, '');
  return host === webAppKey || host.endsWith(`.${webAppKey}`);
}

/**
 * Creates a {@link CookieSensor}. `cookiesApi` defaults to the real
 * `chrome.cookies` and is injectable for testing.
 */
export function createCookieSensor(cookiesApi: CookiesApi = chrome.cookies): CookieSensor {
  async function getEvidence(webAppKey: WebAppKey, now: ClockFn = Date.now): Promise<SignalEvidence> {
    const cookies = await cookiesApi.getAll({ domain: webAppKey });
    return classifyCookie(cookies.map(toCookieInput), now());
  }

  function watch(
    webAppKey: WebAppKey,
    onEvidence: (evidence: SignalEvidence) => void,
    now: ClockFn = Date.now,
  ): () => void {
    const listener = (changeInfo: chrome.cookies.CookieChangeInfo): void => {
      if (!belongsToWebAppKey(changeInfo.cookie.domain, webAppKey)) {
        return;
      }
      void getEvidence(webAppKey, now).then(onEvidence);
    };

    cookiesApi.onChanged.addListener(listener);
    return () => cookiesApi.onChanged.removeListener(listener);
  }

  return { getEvidence, watch };
}
