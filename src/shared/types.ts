/**
 * Frozen Tier-0 contracts for the Sign-In Detector detection core.
 *
 * These types are the shared seam between the pure detection modules
 * (src/engine, src/identity, src/sensors) and are intentionally
 * Chrome-API-free. Do not import `chrome.*` or `wxt/browser` here.
 *
 * This file is FROZEN for Phase 1 Plan 02/03: neither plan modifies this
 * file, they only import from it.
 */

/**
 * A registrable-domain (eTLD+1) identity key for a web application,
 * resolved via `tldts` from the top-frame URL (see IDN-01/IDN-02).
 *
 * Modeled as a branded type so a raw string/URL cannot be passed where a
 * WebAppKey is expected -- this structurally prevents SPA-route re-keying
 * thrash: only the identity module's smart constructor can mint one.
 */
export type WebAppKey = string & { readonly __brand: 'WebAppKey' };

/** The four independent detection signals fused by the confidence engine. */
export type SignalName = 'cookie' | 'network' | 'storage' | 'dom';

/** The hysteresis state machine's possible verdict states (ENG-03). */
export type VerdictState = 'unknown' | 'signed-in' | 'signed-out';

/**
 * Normalized, shape-only evidence produced by a single classifier for a
 * single signal. Discriminated on `signal` and `observed` so that:
 *   - a signal that was never observed carries no stale/default value
 *     (a silent signal class must be excluded from fusion, not treated
 *     as 0 -- see ENG-01's fusion formula), and
 *   - only the `dom` signal's observed variant carries
 *     `passwordFormVisible`, because only the engine (not a DOM-only
 *     classifier) can combine it with cookie evidence for the ENG-02
 *     cross-signal strong-negative rule.
 *
 * All fields are readonly: evidence objects are immutable snapshots.
 */
export type SignalEvidence =
  | { readonly signal: 'cookie'; readonly observed: true; readonly value: number }
  | { readonly signal: 'cookie'; readonly observed: false }
  | { readonly signal: 'network'; readonly observed: true; readonly value: number }
  | { readonly signal: 'network'; readonly observed: false }
  | { readonly signal: 'storage'; readonly observed: true; readonly value: number }
  | { readonly signal: 'storage'; readonly observed: false }
  | {
      readonly signal: 'dom';
      readonly observed: true;
      readonly value: number;
      readonly passwordFormVisible: boolean;
    }
  | { readonly signal: 'dom'; readonly observed: false };

/**
 * A snapshot of currently-known evidence per signal for one
 * WebAppKey/tab. A missing key means "no evidence collected yet" --
 * distinct from an evidence object with `observed: false`.
 */
export type SignalVector = {
  readonly [K in SignalName]?: SignalEvidence;
};

/** The confidence engine's fused output for one WebAppKey/tab. */
export interface VerdictResult {
  readonly state: VerdictState;
  readonly confidence: number;
}

/**
 * An injectable clock. Engine logic (asymmetric debounce, ENG-04) must
 * never call `Date.now()` directly -- always thread a `ClockFn` through
 * so debounce timing is deterministically unit-testable.
 */
export type ClockFn = () => number;

/**
 * Message contracts for the (future, Phase 3/4) extension messaging
 * seam between content scripts and the background service worker.
 * Payloads are booleans/enums/numbers only -- never a raw cookie/token
 * value -- so the detection core's privacy boundary is enforced at the
 * type level, not just by convention.
 */
export interface SensorSignalMessage {
  readonly type: 'SENSOR_SIGNAL';
  readonly signal: Extract<SignalName, 'storage' | 'dom'>;
  readonly evidence: SignalEvidence;
}

export interface GetVerdictMessage {
  readonly type: 'GET_VERDICT';
}

export interface VerdictUpdateMessage {
  readonly type: 'VERDICT_UPDATE';
  readonly result: VerdictResult;
}

export type ExtensionMessage = SensorSignalMessage | GetVerdictMessage;
