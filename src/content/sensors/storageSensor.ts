import { classifyStorage, type StorageEntryInput } from '../../sensors/storage/classify';
import type { SignalEvidence } from '../../shared/types';

/**
 * Evidence shape this sensor can ever return. `classifyStorage`'s
 * DECLARED return type is the full `SignalEvidence` union (shared by all
 * four Phase-1 classifiers), but its implementation only ever constructs
 * the `signal: 'storage'` variant. Narrowing it here lets this sensor's
 * output flow directly into `content/messaging.ts#sendSensorSignal`
 * (which only accepts `storage`/`dom` evidence) with no cast at the call
 * site -- see the cast note on {@link createStorageSensor.getEvidence}.
 */
export type StorageSensorEvidence = Extract<SignalEvidence, { readonly signal: 'storage' }>;

/**
 * The minimal `Storage`-shaped dependency this sensor reads from -- a
 * structural subset of the real DOM `Storage` interface (which
 * `localStorage`/`sessionStorage` already satisfy) so tests can inject a
 * trivial in-memory fake instead of a full `Storage` implementation. Same
 * "inject the browser dependency" pattern `verdictStore.ts` uses for
 * `chrome.storage.session` and `cookieSensor.ts` uses for `chrome.cookies`.
 */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

/** Injectable storage sources for {@link createStorageSensor}. */
export interface StorageSensorSources {
  readonly local: StorageLike;
  readonly session: StorageLike;
}

/** Reads every key/value pair currently in `storage` into the classifier's input shape. */
function readEntries(storage: StorageLike): StorageEntryInput[] {
  const entries: StorageEntryInput[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null) {
      continue;
    }
    const value = storage.getItem(key);
    if (value === null) {
      continue;
    }
    entries.push({ key, value });
  }
  return entries;
}

export interface StorageSensor {
  /**
   * One-shot: reads every entry currently in local + session storage and
   * hands them to the pure `classifyStorage` classifier (SEN-04). This
   * module never scores an entry itself -- it only adapts real
   * `localStorage`/`sessionStorage` data into the classifier's input
   * shape. `nowSeconds` is forwarded straight through to `classifyStorage`
   * (defaults to `Date.now() / 1000` there when omitted).
   */
  getEvidence(nowSeconds?: number): StorageSensorEvidence;
}

/**
 * Creates a {@link StorageSensor}. `sources` defaults to the real global
 * `localStorage`/`sessionStorage` and is injectable for testing.
 */
export function createStorageSensor(
  sources: StorageSensorSources = { local: localStorage, session: sessionStorage },
): StorageSensor {
  return {
    getEvidence(nowSeconds?: number): StorageSensorEvidence {
      const entries = [...readEntries(sources.local), ...readEntries(sources.session)];
      // Safe narrowing cast -- see the module doc comment on
      // `StorageSensorEvidence` for why this is provably correct.
      return classifyStorage(entries, nowSeconds) as StorageSensorEvidence;
    },
  };
}
