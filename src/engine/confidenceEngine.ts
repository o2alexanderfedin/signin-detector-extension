import type { ClockFn, SignalName, SignalVector, VerdictResult, VerdictState } from '../shared/types';
import {
  DEBOUNCE_SIGNED_OUT_MS,
  SIGNAL_WEIGHTS,
  STRONG_NEGATIVE_VALUE,
  THRESHOLD_SIGNED_IN,
  THRESHOLD_SIGNED_OUT,
} from '../shared/constants';

/**
 * Weighted-mean fusion over OBSERVED-ONLY signals (ENG-01), with one
 * pre-processing cross-signal override (ENG-02): a visible password form
 * with no positive cookie evidence overrides the DOM signal's contribution
 * to STRONG_NEGATIVE_VALUE. This override must live here (not in the DOM
 * classifier) because it needs cookie evidence to decide.
 *
 * Unobserved signals contribute to neither the numerator nor the
 * denominator -- a silent signal class is excluded from fusion entirely,
 * not treated as 0 (graceful degradation).
 *
 * An empty/all-unobserved vector returns 0 rather than dividing by zero.
 */
export function fuseConfidence(vector: SignalVector): number {
  const hasPositiveCookie = vector.cookie?.observed === true && vector.cookie.value > 0;

  let weightedSum = 0;
  let weightTotal = 0;

  for (const signal of Object.keys(vector) as SignalName[]) {
    const evidence = vector[signal];
    if (evidence === undefined || evidence.observed !== true) {
      continue;
    }

    const contributingValue =
      evidence.signal === 'dom' && evidence.passwordFormVisible === true && !hasPositiveCookie
        ? STRONG_NEGATIVE_VALUE
        : evidence.value;

    const weight = SIGNAL_WEIGHTS[signal];
    weightedSum += weight * contributingValue;
    weightTotal += weight;
  }

  if (weightTotal === 0) {
    return 0;
  }

  return weightedSum / weightTotal;
}

/**
 * Pure dual-threshold hysteresis (ENG-03), no time involved:
 *   - confidence >= THRESHOLD_SIGNED_IN  -> 'signed-in'
 *   - confidence <= THRESHOLD_SIGNED_OUT -> 'signed-out'
 *   - otherwise (hold band)              -> previousState unchanged (no flicker)
 */
export function nextVerdictState(confidence: number, previousState: VerdictState): VerdictState {
  if (confidence >= THRESHOLD_SIGNED_IN) {
    return 'signed-in';
  }
  if (confidence <= THRESHOLD_SIGNED_OUT) {
    return 'signed-out';
  }
  return previousState;
}

/**
 * Pure, serializable snapshot of a {@link ConfidenceEngine}'s internal
 * hysteresis + asymmetric-debounce bookkeeping (PLT-01 seam). Contains
 * ONLY derived numbers/enums -- never raw cookie/token/session material --
 * so it is safe for a storage adapter (see
 * `src/background/state/verdictStore.ts`) to persist verbatim in
 * `chrome.storage.session`. This module has no knowledge that storage
 * exists; it only produces/consumes plain data.
 */
export interface ConfidenceEngineSnapshot {
  readonly state: VerdictState;
  readonly confidence: number;
  readonly pendingSignedOutSince: number | null;
}

/** Stateful engine wrapper returned by {@link createConfidenceEngine}. */
export interface ConfidenceEngine {
  update(vector: SignalVector): VerdictResult;
  /** Pure: returns a plain-object snapshot of the engine's current state. */
  serialize(): ConfidenceEngineSnapshot;
}

/**
 * Stateful wrapper adding an asymmetric logout debounce (ENG-04) on top of
 * the pure fusion + hysteresis functions above:
 *   - SignedIn commits immediately on the same update() call that first
 *     crosses the upper threshold (DEBOUNCE_SIGNED_IN_MS exists as a named
 *     constant for symmetry/future tuning, but no delay is applied here).
 *   - SignedOut only commits after DEBOUNCE_SIGNED_OUT_MS of continuous
 *     below-threshold confidence, measured via the injected clock -- never
 *     a real timer.
 *   - A recovery out of 'signed-out' hysteresis before the grace window
 *     elapses cancels the pending SignedOut transition entirely.
 *
 * `clock` defaults to the global `Date.now` at this public API boundary
 * only; the `update()` body never invokes the system clock directly,
 * always going through the injected `clock` variable so debounce timing
 * is deterministically unit-testable.
 *
 * `restore`, if given, seeds the engine's internal state from a prior
 * {@link ConfidenceEngineSnapshot} instead of the 'unknown' default -- the
 * other half of the PLT-01 serialize/restore seam, letting a caller
 * (e.g. a `chrome.storage.session`-backed store on service-worker wake)
 * rehydrate a deterministic engine instance with zero knowledge of storage
 * living inside this pure module.
 */
export function createConfidenceEngine(
  clock: ClockFn = Date.now,
  restore?: ConfidenceEngineSnapshot,
): ConfidenceEngine {
  let committedState: VerdictState = restore?.state ?? 'unknown';
  let lastConfidence: number = restore?.confidence ?? 0;
  let pendingSignedOutSince: number | null = restore?.pendingSignedOutSince ?? null;

  return {
    update(vector: SignalVector): VerdictResult {
      const now = clock();
      const confidence = fuseConfidence(vector);
      lastConfidence = confidence;
      const rawState = nextVerdictState(confidence, committedState);

      if (rawState === committedState) {
        pendingSignedOutSince = null;
        return { state: committedState, confidence };
      }

      if (rawState === 'signed-in') {
        committedState = 'signed-in';
        pendingSignedOutSince = null;
        return { state: committedState, confidence };
      }

      // rawState === 'signed-out'
      if (pendingSignedOutSince === null) {
        pendingSignedOutSince = now;
      }
      if (now - pendingSignedOutSince >= DEBOUNCE_SIGNED_OUT_MS) {
        committedState = 'signed-out';
        pendingSignedOutSince = null;
      }
      return { state: committedState, confidence };
    },
    serialize(): ConfidenceEngineSnapshot {
      return { state: committedState, confidence: lastConfidence, pendingSignedOutSince };
    },
  };
}
