import {
  GUEST_CLAIM_KEYS,
  GUEST_CLAIM_VALUE_PATTERN,
  JWT_SEGMENT_COUNT,
  STORAGE_GUEST_OR_STALE_VALUE,
  STORAGE_KEY_NAME_ONLY_VALUE,
  STORAGE_KEY_NAME_PATTERNS,
  STORAGE_POSITIVE_VALUE,
} from '../../shared/constants';
import type { SignalEvidence } from '../../shared/types';

/**
 * A single observed storage entry (e.g. localStorage/sessionStorage
 * key/value pair). Shape-only -- values are inspected only for
 * JWT-shape and claim structure, never trusted for arbitrary meaning.
 */
export interface StorageEntryInput {
  readonly key: string;
  readonly value: string;
}

/** Decodes a base64url string to its UTF-8 text form, or `null` on failure. */
function decodeBase64Url(segment: string): string | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    return atob(base64);
  } catch {
    return null;
  }
}

/** Decodes a base64url segment as JSON, or `null` on any failure. */
function decodeBase64UrlJson(segment: string): unknown {
  const decoded = decodeBase64Url(segment);
  if (decoded === null) {
    return null;
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True iff `value` splits into JWT_SEGMENT_COUNT segments and the header segment decodes to JSON with both `alg` and `typ`. */
function isJwtShaped(value: string): boolean {
  const segments = value.split('.');
  if (segments.length !== JWT_SEGMENT_COUNT) {
    return false;
  }

  const header = decodeBase64UrlJson(segments[0] ?? '');
  return isRecord(header) && 'alg' in header && 'typ' in header;
}

function matchesKeyNamePattern(key: string): boolean {
  return STORAGE_KEY_NAME_PATTERNS.some((pattern) => pattern.test(key));
}

function isGuestClaim(payload: Record<string, unknown>): boolean {
  return GUEST_CLAIM_KEYS.some((claimKey) => {
    const claimValue = payload[claimKey];
    return typeof claimValue === 'string' && GUEST_CLAIM_VALUE_PATTERN.test(claimValue);
  });
}

function isStaleClaim(payload: Record<string, unknown>, nowSeconds: number): boolean {
  const exp = payload['exp'];
  return typeof exp === 'number' && exp < nowSeconds;
}

/** Scores a single storage entry, or `null` if it contributes no evidence at all. */
function scoreEntry(entry: StorageEntryInput, nowSeconds: number): number | null {
  if (isJwtShaped(entry.value)) {
    const segments = entry.value.split('.');
    const payload = decodeBase64UrlJson(segments[1] ?? '');

    if (isRecord(payload) && (isStaleClaim(payload, nowSeconds) || isGuestClaim(payload))) {
      return STORAGE_GUEST_OR_STALE_VALUE;
    }

    return STORAGE_POSITIVE_VALUE;
  }

  if (matchesKeyNamePattern(entry.key)) {
    return STORAGE_KEY_NAME_ONLY_VALUE;
  }

  return null;
}

/**
 * Classifies a set of storage entries observed for one WebAppKey into a
 * single shape-only signed-in signal (SEN-04). Detects JWT-shaped values
 * (segment count + header `alg`/`typ`) and down-weights stale (`exp` in
 * the past) or guest/anonymous-claim tokens rather than counting either
 * as a full positive (ENG-05). Entries whose key matches a known
 * auth/session/token name pattern but whose value is not JWT-shaped
 * score a lower key-name-only value. Entries that match neither are
 * excluded entirely (not scored as 0). Multiple entries reduce via MAX.
 */
export function classifyStorage(
  entries: readonly StorageEntryInput[],
  nowSeconds: number = Date.now() / 1000,
): SignalEvidence {
  let best: number | null = null;

  for (const entry of entries) {
    const score = scoreEntry(entry, nowSeconds);
    if (score !== null && (best === null || score > best)) {
      best = score;
    }
  }

  if (best === null) {
    return { signal: 'storage', observed: false };
  }

  return { signal: 'storage', observed: true, value: best };
}
