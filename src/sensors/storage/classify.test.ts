import { describe, expect, it } from 'vitest';

import {
  STORAGE_GUEST_OR_STALE_VALUE,
  STORAGE_KEY_NAME_ONLY_VALUE,
  STORAGE_POSITIVE_VALUE,
} from '../../shared/constants';
import { classifyStorage, type StorageEntryInput } from './classify';

const NOW_SECONDS = 1_700_000_000;
const FUTURE_EXP = NOW_SECONDS + 3600;
const PAST_EXP = NOW_SECONDS - 3600;

function b64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(header: unknown, payload: unknown, signature = 'sig'): string {
  const headerSeg = b64url(JSON.stringify(header));
  const payloadSeg = typeof payload === 'string' ? payload : b64url(JSON.stringify(payload));
  return `${headerSeg}.${payloadSeg}.${signature}`;
}

const validHeader = { alg: 'HS256', typ: 'JWT' };

describe('classifyStorage', () => {
  it('returns observed:false for an empty entry array', () => {
    expect(classifyStorage([], NOW_SECONDS)).toEqual({ signal: 'storage', observed: false });
  });

  it('returns observed:false when no entries match JWT-shape or key patterns', () => {
    const entries: StorageEntryInput[] = [
      { key: 'theme', value: 'dark' },
      { key: 'locale', value: 'en-US' },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: false,
    });
  });

  it('returns STORAGE_KEY_NAME_ONLY_VALUE when key matches a pattern but value is not JWT-shaped', () => {
    const entries: StorageEntryInput[] = [{ key: 'authToken', value: 'plain-opaque-string' }];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: true,
      value: STORAGE_KEY_NAME_ONLY_VALUE,
    });
  });

  it('returns STORAGE_POSITIVE_VALUE for a JWT-shaped value with a future exp and no guest claim', () => {
    const entries: StorageEntryInput[] = [
      { key: 'session', value: makeJwt(validHeader, { sub: '123', exp: FUTURE_EXP }) },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: true,
      value: STORAGE_POSITIVE_VALUE,
    });
  });

  it('returns STORAGE_GUEST_OR_STALE_VALUE for a JWT-shaped value with exp in the past', () => {
    const entries: StorageEntryInput[] = [
      { key: 'session', value: makeJwt(validHeader, { sub: '123', exp: PAST_EXP }) },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: true,
      value: STORAGE_GUEST_OR_STALE_VALUE,
    });
  });

  it('returns STORAGE_GUEST_OR_STALE_VALUE for a JWT-shaped value with a future exp but a guest-claim match', () => {
    const entries: StorageEntryInput[] = [
      {
        key: 'session',
        value: makeJwt(validHeader, { sub: '123', exp: FUTURE_EXP, role: 'guest' }),
      },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: true,
      value: STORAGE_GUEST_OR_STALE_VALUE,
    });
  });

  it('treats a JWT-shaped value with an undecodable payload as a full positive (still JWT-shaped)', () => {
    const entries: StorageEntryInput[] = [
      { key: 'session', value: makeJwt(validHeader, 'not-valid-base64url-json!!!') },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: true,
      value: STORAGE_POSITIVE_VALUE,
    });
  });

  it('falls back to key-name-only scoring for a malformed "JWT" with the wrong segment count', () => {
    const entries: StorageEntryInput[] = [
      { key: 'authToken', value: 'only.two-segments' },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: true,
      value: STORAGE_KEY_NAME_ONLY_VALUE,
    });
  });

  it('falls back to unobserved for a malformed "JWT" with the wrong segment count and a non-matching key', () => {
    const entries: StorageEntryInput[] = [
      { key: 'theme', value: 'only.two-segments' },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: false,
    });
  });

  it('falls back to key-name-only scoring when the header segment is not valid base64url JSON', () => {
    const entries: StorageEntryInput[] = [
      { key: 'sessionToken', value: 'not-valid-header!!!.eyJhIjoxfQ.sig' },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: true,
      value: STORAGE_KEY_NAME_ONLY_VALUE,
    });
  });

  it('falls back to unobserved when the header segment is not valid base64url JSON and the key does not match', () => {
    const entries: StorageEntryInput[] = [
      { key: 'preferences', value: 'not-valid-header!!!.eyJhIjoxfQ.sig' },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: false,
    });
  });

  it('returns the MAX score across multiple entries, never averaging', () => {
    const entries: StorageEntryInput[] = [
      { key: 'authToken', value: 'plain-opaque-string' },
      { key: 'session', value: makeJwt(validHeader, { sub: '123', exp: FUTURE_EXP }) },
      { key: 'theme', value: 'dark' },
    ];
    expect(classifyStorage(entries, NOW_SECONDS)).toEqual({
      signal: 'storage',
      observed: true,
      value: STORAGE_POSITIVE_VALUE,
    });
  });

  it('defaults `nowSeconds` to Date.now() / 1000 when not provided', () => {
    expect(classifyStorage([])).toEqual({ signal: 'storage', observed: false });
  });
});
