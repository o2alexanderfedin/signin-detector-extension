import type { SignalName } from './types';

/**
 * Frozen Tier-0 named constants for the Sign-In Detector detection core.
 *
 * No magic numbers live anywhere else in the codebase -- every
 * classifier/engine weight, threshold, debounce window, and denylist
 * pattern is declared here so it can be calibrated later without hunting
 * through implementation files.
 */

// ---------------------------------------------------------------------------
// Signal weights (ENG-01)
// Fusion formula: confidence = Σ(weightᵢ · valueᵢ) / Σ(weightᵢ for observed i)
// -- a weighted mean over OBSERVED signals only.
// ---------------------------------------------------------------------------

export const SIGNAL_WEIGHT_COOKIE = 1.0;
export const SIGNAL_WEIGHT_NETWORK = 1.0;
export const SIGNAL_WEIGHT_STORAGE = 0.6;
export const SIGNAL_WEIGHT_DOM = 0.3;

export const SIGNAL_WEIGHTS: Readonly<Record<SignalName, number>> = {
  cookie: SIGNAL_WEIGHT_COOKIE,
  network: SIGNAL_WEIGHT_NETWORK,
  storage: SIGNAL_WEIGHT_STORAGE,
  dom: SIGNAL_WEIGHT_DOM,
};

// ---------------------------------------------------------------------------
// Hysteresis thresholds (ENG-03)
// confidence >= THRESHOLD_SIGNED_IN -> SignedIn
// confidence <= THRESHOLD_SIGNED_OUT -> SignedOut
// middle band holds the previous state; initial state = Unknown.
// ---------------------------------------------------------------------------

export const THRESHOLD_SIGNED_IN = 0.7;
export const THRESHOLD_SIGNED_OUT = 0.3;

// ---------------------------------------------------------------------------
// Asymmetric debounce (ENG-04)
// SignedIn is entered promptly; SignedOut is delayed by a grace window so
// token-refresh blips don't flip the verdict. The engine is time-injectable
// (ClockFn) so this is deterministically unit-testable.
// ---------------------------------------------------------------------------

export const DEBOUNCE_SIGNED_IN_MS = 0;
export const DEBOUNCE_SIGNED_OUT_MS = 3000;

// ---------------------------------------------------------------------------
// Strong-negative magnitude (ENG-02)
// Reused by both the network classifier's 401/403 case and the engine's
// password-form-visible + no-session-cookie cross-signal override.
// ---------------------------------------------------------------------------

export const STRONG_NEGATIVE_VALUE = -1;

// ---------------------------------------------------------------------------
// Cookie sensor (SEN-01 / SEN-02)
// Shape-only: HttpOnly + Secure + high-entropy value + long expiry, scoped
// to the WebAppKey, is positive. Never read cookie value for meaning.
// ---------------------------------------------------------------------------

export const COOKIE_MIN_HIGH_ENTROPY_LENGTH = 24;
export const COOKIE_MIN_LONG_EXPIRY_MS = 24 * 60 * 60 * 1000;

export const COOKIE_POSITIVE_VALUE = 1;
export const COOKIE_PARTIAL_VALUE = 0.5;
export const COOKIE_DENYLISTED_VALUE = 0.1;

/**
 * Known tracking/consent cookie NAME patterns -- an infra-level denylist,
 * not per-app rules (SEN-02). Case-insensitive.
 */
export const TRACKING_COOKIE_NAME_PATTERNS: readonly RegExp[] = [
  /^_ga/i, // _ga, _ga_<container-id> (GA4)
  /^_gid$/i,
  /^_gat/i, // _gat, _gat_gtag_<id>
  /^_fbp$/i,
  /^_fbc$/i,
  /^OptanonConsent$/i,
  /^OptanonAlertBoxClosed$/i,
  /^__utm/i, // __utma, __utmb, __utmc, __utmz, ...
  /^_hjid$/i,
  /^_hjSession/i, // _hjSession, _hjSessionUser, ...
];

// ---------------------------------------------------------------------------
// Network sensor (SEN-03 / ENG-05)
// Identity-endpoint-shaped URL with 200 -> positive; 401/403 -> strong
// negative (STRONG_NEGATIVE_VALUE above). Status/header only, no body.
// ---------------------------------------------------------------------------

export const IDENTITY_ENDPOINT_PATH_PATTERNS: readonly RegExp[] = [
  /\/me\b/i,
  /\/session\b/i,
  /\/account\b/i,
  /\/user\b/i,
];

export const GRAPHQL_ENDPOINT_PATH_PATTERN = /\/graphql\b/i;

export const NETWORK_REST_IDENTITY_200_VALUE = 1;

/**
 * Down-weighted vs. a REST identity 200: a GraphQL 200 cannot be
 * distinguished from a "soft-200" auth-error shape without parsing the
 * response body, which is explicitly out of scope per REQUIREMENTS.md
 * (status/header only, no body inspection).
 */
export const NETWORK_GRAPHQL_200_VALUE = 0.5;

// ---------------------------------------------------------------------------
// Storage sensor (SEN-04 / ENG-05)
// Detect JWT-shaped values (3 base64url segments) and auth/session/token
// key names; down-weight guest/anonymous claims and stale (expired `exp`)
// tokens rather than counting them as signed-in.
// ---------------------------------------------------------------------------

export const JWT_SEGMENT_COUNT = 3;

export const STORAGE_KEY_NAME_PATTERNS: readonly RegExp[] = [/auth/i, /session/i, /token/i];

export const STORAGE_KEY_NAME_ONLY_VALUE = 0.5;
export const STORAGE_POSITIVE_VALUE = 1;
export const STORAGE_GUEST_OR_STALE_VALUE = 0.1;

/** Claim keys checked for guest/anonymous role markers in a decoded JWT payload. */
export const GUEST_CLAIM_KEYS: readonly string[] = ['role', 'scope', 'type', 'user_type'];

export const GUEST_CLAIM_VALUE_PATTERN = /guest|anonymous|^anon$/i;

// ---------------------------------------------------------------------------
// DOM sensor (SEN-05)
// Input is a normalized DOM snapshot (booleans/counts, not live DOM).
// Logout/account/avatar affordance present AND no password-login surface
// -> low-weight positive; otherwise ambiguous.
// ---------------------------------------------------------------------------

export const DOM_POSITIVE_VALUE = 0.6;
export const DOM_AMBIGUOUS_VALUE = 0.2;

// ---------------------------------------------------------------------------
// Border overlay (BDR-01..04)
// Viewport-edge border shown only while VerdictState === 'signed-in', built
// via createElement + CSSOM inside a closed Shadow DOM host attached to
// document.documentElement (top frame only).
// ---------------------------------------------------------------------------

/** `id` attribute of the shadow host, used both to mount it and to detect removal/reordering. */
export const BORDER_OVERLAY_HOST_ID = 'sign-in-detector-border-host';

export const BORDER_OVERLAY_WIDTH_PX = 4;
export const BORDER_OVERLAY_COLOR = '#16a34a';

/** DOM stacking-context maximum (does not defeat the CSS Top Layer -- see PITFALLS.md Pitfall 11, accepted MVP limitation). */
export const BORDER_OVERLAY_Z_INDEX = 2147483647;

/**
 * Self-healing re-assertion debounce (BDR-03). Deliberately separate from
 * (and scoped narrower than) the DOM sensor's own debounced observer --
 * PITFALLS.md Pitfall 12 calls for a *direct-childList-only* observer on
 * `documentElement` here, not a `subtree: true` watch, to avoid this
 * self-healing check firing on every unrelated deep DOM mutation on
 * high-churn pages (chat, live dashboards).
 */
export const BORDER_OVERLAY_REASSERT_DEBOUNCE_MS = 200;
