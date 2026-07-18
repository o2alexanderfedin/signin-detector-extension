import { describe, expect, it } from 'vitest';

import {
  COOKIE_DENYLISTED_VALUE,
  COOKIE_MIN_HIGH_ENTROPY_LENGTH,
  COOKIE_MIN_LONG_EXPIRY_MS,
  COOKIE_PARTIAL_VALUE,
  COOKIE_POSITIVE_VALUE,
} from '../../shared/constants';
import { classifyCookie, type CookieInput } from './classify';

const NOW = 1_700_000_000_000;

const longValue = 'a'.repeat(COOKIE_MIN_HIGH_ENTROPY_LENGTH);
const shortValue = 'a'.repeat(COOKIE_MIN_HIGH_ENTROPY_LENGTH - 1);
const longExpiry = NOW + COOKIE_MIN_LONG_EXPIRY_MS + 1000;
const shortExpiry = NOW + COOKIE_MIN_LONG_EXPIRY_MS - 1000;

function fullMatchCookie(overrides: Partial<CookieInput> = {}): CookieInput {
  return {
    name: 'session_id',
    httpOnly: true,
    secure: true,
    value: longValue,
    expirationDateMs: longExpiry,
    ...overrides,
  };
}

describe('classifyCookie', () => {
  it('returns observed:false for an empty cookie array', () => {
    expect(classifyCookie([], NOW)).toEqual({ signal: 'cookie', observed: false });
  });

  it('returns COOKIE_POSITIVE_VALUE for a full-match, non-denylisted cookie', () => {
    const result = classifyCookie([fullMatchCookie()], NOW);
    expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_POSITIVE_VALUE });
  });

  it('returns COOKIE_DENYLISTED_VALUE for a denylisted name even with otherwise-full-match shape (SEN-02)', () => {
    const result = classifyCookie([fullMatchCookie({ name: '_ga' })], NOW);
    expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_DENYLISTED_VALUE });
  });

  it('returns COOKIE_PARTIAL_VALUE when httpOnly is missing', () => {
    const result = classifyCookie([fullMatchCookie({ httpOnly: false })], NOW);
    expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_PARTIAL_VALUE });
  });

  it('returns COOKIE_PARTIAL_VALUE when secure is missing', () => {
    const result = classifyCookie([fullMatchCookie({ secure: false })], NOW);
    expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_PARTIAL_VALUE });
  });

  it('returns COOKIE_PARTIAL_VALUE when the value is short (low entropy)', () => {
    const result = classifyCookie([fullMatchCookie({ value: shortValue })], NOW);
    expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_PARTIAL_VALUE });
  });

  it('returns COOKIE_PARTIAL_VALUE when expiry is short', () => {
    const result = classifyCookie([fullMatchCookie({ expirationDateMs: shortExpiry })], NOW);
    expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_PARTIAL_VALUE });
  });

  it('returns COOKIE_PARTIAL_VALUE when expiry is absent (session cookie)', () => {
    const sessionCookie: CookieInput = {
      name: 'session_id',
      httpOnly: true,
      secure: true,
      value: longValue,
    };
    const result = classifyCookie([sessionCookie], NOW);
    expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_PARTIAL_VALUE });
  });

  it('returns the MAX score across multiple cookies, never averaging', () => {
    const result = classifyCookie(
      [fullMatchCookie({ httpOnly: false }), fullMatchCookie({ name: 'other_session' })],
      NOW,
    );
    expect(result).toEqual({ signal: 'cookie', observed: true, value: COOKIE_POSITIVE_VALUE });
  });

  it('defaults `now` to Date.now() when not provided', () => {
    const result = classifyCookie([]);
    expect(result).toEqual({ signal: 'cookie', observed: false });
  });
});
