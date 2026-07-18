import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  STORAGE_GUEST_OR_STALE_VALUE,
  STORAGE_KEY_NAME_ONLY_VALUE,
  STORAGE_POSITIVE_VALUE,
} from '../../shared/constants';
import { createStorageSensor, type StorageLike } from './storageSensor';

/**
 * SEN-04 -- content-script storage sensor glue tests. `getEvidence()` is
 * tested against injected `StorageLike` fakes (a minimal in-memory
 * key/value store, not a real DOM `Storage`) for the bulk of the
 * classification-delegation coverage, plus a smaller pass against the
 * REAL global `localStorage`/`sessionStorage` (provided by happy-dom, per
 * vitest.config.ts) to prove the injectable-dependency default wiring.
 */

const NOW_SECONDS = 1_700_000_000;

function fakeStorage(entries: Record<string, string>): StorageLike {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (index) => keys[index] ?? null,
    getItem: (key) => entries[key] ?? null,
  };
}

function b64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(header: unknown, payload: unknown): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;
}

const VALID_HEADER = { alg: 'HS256', typ: 'JWT' };

describe('createStorageSensor (content glue, SEN-04)', () => {
  describe('getEvidence -- reuses the pure classifyStorage classifier', () => {
    it('returns observed:false when both storages are empty', () => {
      const sensor = createStorageSensor({ local: fakeStorage({}), session: fakeStorage({}) });
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({ signal: 'storage', observed: false });
    });

    it('classifies a JWT-shaped localStorage entry via the pure classifier', () => {
      const sensor = createStorageSensor({
        local: fakeStorage({ session: makeJwt(VALID_HEADER, { sub: '1', exp: NOW_SECONDS + 3600 }) }),
        session: fakeStorage({}),
      });
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({
        signal: 'storage',
        observed: true,
        value: STORAGE_POSITIVE_VALUE,
      });
    });

    it('classifies a sessionStorage-only entry the same way as localStorage', () => {
      const sensor = createStorageSensor({
        local: fakeStorage({}),
        session: fakeStorage({ authToken: 'opaque-value' }),
      });
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({
        signal: 'storage',
        observed: true,
        value: STORAGE_KEY_NAME_ONLY_VALUE,
      });
    });

    it('combines entries from BOTH storages and takes the MAX score across all of them', () => {
      const sensor = createStorageSensor({
        local: fakeStorage({ authToken: 'opaque' }),
        session: fakeStorage({ session: makeJwt(VALID_HEADER, { sub: '1', exp: NOW_SECONDS + 3600 }) }),
      });
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({
        signal: 'storage',
        observed: true,
        value: STORAGE_POSITIVE_VALUE,
      });
    });

    it('down-weights a guest-claim JWT the same way the pure classifier does', () => {
      const sensor = createStorageSensor({
        local: fakeStorage({
          session: makeJwt(VALID_HEADER, { sub: '1', exp: NOW_SECONDS + 3600, role: 'guest' }),
        }),
        session: fakeStorage({}),
      });
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({
        signal: 'storage',
        observed: true,
        value: STORAGE_GUEST_OR_STALE_VALUE,
      });
    });

    it('ignores entries with no key-pattern or JWT-shape match', () => {
      const sensor = createStorageSensor({
        local: fakeStorage({ theme: 'dark' }),
        session: fakeStorage({ locale: 'en' }),
      });
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({ signal: 'storage', observed: false });
    });

    it('skips a key() index that returns null without throwing (defensive against a shrinking live Storage)', () => {
      const sensor = createStorageSensor({
        local: {
          length: 2,
          key: (index) => (index === 0 ? 'authToken' : null),
          getItem: (key) => (key === 'authToken' ? 'plain-opaque-string' : null),
        },
        session: fakeStorage({}),
      });
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({
        signal: 'storage',
        observed: true,
        value: STORAGE_KEY_NAME_ONLY_VALUE,
      });
    });
  });

  describe('default sources (real global localStorage/sessionStorage)', () => {
    beforeEach(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    it('reads from the real global localStorage when no sources are injected', () => {
      localStorage.setItem('authToken', 'plain-opaque-string');
      const sensor = createStorageSensor();
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({
        signal: 'storage',
        observed: true,
        value: STORAGE_KEY_NAME_ONLY_VALUE,
      });
    });

    it('reads from the real global sessionStorage when no sources are injected', () => {
      sessionStorage.setItem('authToken', 'plain-opaque-string');
      const sensor = createStorageSensor();
      expect(sensor.getEvidence(NOW_SECONDS)).toEqual({
        signal: 'storage',
        observed: true,
        value: STORAGE_KEY_NAME_ONLY_VALUE,
      });
    });
  });

  it('defaults nowSeconds to Date.now()/1000 when not provided (delegates straight through to classifyStorage)', () => {
    const sensor = createStorageSensor({ local: fakeStorage({}), session: fakeStorage({}) });
    expect(sensor.getEvidence()).toEqual({ signal: 'storage', observed: false });
  });
});
