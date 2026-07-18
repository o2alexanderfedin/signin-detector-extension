import {
  COOKIE_DENYLISTED_VALUE,
  COOKIE_MIN_HIGH_ENTROPY_LENGTH,
  COOKIE_MIN_LONG_EXPIRY_MS,
  COOKIE_PARTIAL_VALUE,
  COOKIE_POSITIVE_VALUE,
  TRACKING_COOKIE_NAME_PATTERNS,
} from '../../shared/constants';
import type { SignalEvidence } from '../../shared/types';

/**
 * A single observed cookie descriptor. Shape-only -- `value` is inspected
 * only for its length (entropy proxy), never read for meaning.
 */
export interface CookieInput {
  readonly name: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly value: string;
  readonly expirationDateMs?: number;
}

function isDenylisted(name: string): boolean {
  return TRACKING_COOKIE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function scoreCookie(cookie: CookieInput, now: number): number {
  if (isDenylisted(cookie.name)) {
    return COOKIE_DENYLISTED_VALUE;
  }

  const isFullMatch =
    cookie.httpOnly &&
    cookie.secure &&
    cookie.value.length >= COOKIE_MIN_HIGH_ENTROPY_LENGTH &&
    cookie.expirationDateMs !== undefined &&
    cookie.expirationDateMs - now >= COOKIE_MIN_LONG_EXPIRY_MS;

  return isFullMatch ? COOKIE_POSITIVE_VALUE : COOKIE_PARTIAL_VALUE;
}

/**
 * Classifies a set of cookies observed for one WebAppKey into a single
 * shape-only signed-in signal (SEN-01, SEN-02). Never interprets cookie
 * value content -- only HttpOnly/Secure flags, value length, and expiry
 * distance are used. A denylisted tracking/consent cookie NAME short-
 * circuits to `COOKIE_DENYLISTED_VALUE` regardless of otherwise-strong
 * shape. Multiple cookies reduce via MAX, never averaged.
 */
export function classifyCookie(
  cookies: readonly CookieInput[],
  now: number = Date.now(),
): SignalEvidence {
  if (cookies.length === 0) {
    return { signal: 'cookie', observed: false };
  }

  const value = cookies.reduce(
    (max, cookie) => Math.max(max, scoreCookie(cookie, now)),
    -Infinity,
  );

  return { signal: 'cookie', observed: true, value };
}
