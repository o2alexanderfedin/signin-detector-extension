import { describe, expect, it } from 'vitest';
import { createConfidenceEngine, fuseConfidence, nextVerdictState } from './confidenceEngine';
import type { SignalVector, VerdictState } from '../shared/types';
import { DEBOUNCE_SIGNED_OUT_MS, STRONG_NEGATIVE_VALUE } from '../shared/constants';

// ---------------------------------------------------------------------------
// Task 1: fuseConfidence -- weighted mean over observed-only signals (ENG-01),
// with the password-form + no-positive-cookie cross-signal strong-negative
// override (ENG-02).
// ---------------------------------------------------------------------------

describe('fuseConfidence (ENG-01, ENG-02)', () => {
  it('returns 0 for a fully empty/unobserved vector (avoids division by zero)', () => {
    const vector: SignalVector = {};
    expect(fuseConfidence(vector)).toBe(0);
  });

  it('ENG-01: graceful degradation -- a single observed cookie signal returns exactly that value, not diluted by unobserved signals', () => {
    const vector: SignalVector = {
      cookie: { signal: 'cookie', observed: true, value: 1 },
    };
    expect(fuseConfidence(vector)).toBe(1);
  });

  it('ENG-02: a network strong-negative as the sole observed signal returns a negative confidence, not 0/neutral (plain signed weighted-mean arithmetic, no special case)', () => {
    const vector: SignalVector = {
      network: { signal: 'network', observed: true, value: -1 },
    };
    expect(fuseConfidence(vector)).toBe(-1);
  });

  it('ENG-02: visible password form with NO positive cookie evidence overrides the DOM contribution to STRONG_NEGATIVE_VALUE', () => {
    const vector: SignalVector = {
      dom: { signal: 'dom', observed: true, value: 0, passwordFormVisible: true },
    };
    // dom is the only observed signal, so the fused result equals the
    // override value exactly (weight cancels out in a single-signal mean).
    expect(fuseConfidence(vector)).toBe(STRONG_NEGATIVE_VALUE);
  });

  it('ENG-02: the identical password-form snapshot WITH a positive cookie signal does NOT trigger the override', () => {
    const vector: SignalVector = {
      cookie: { signal: 'cookie', observed: true, value: 1 },
      dom: { signal: 'dom', observed: true, value: 0, passwordFormVisible: true },
    };
    // hasPositiveCookie === true, so dom contributes its own value (0), not
    // STRONG_NEGATIVE_VALUE. weights: cookie=1.0, dom=0.3.
    // (1.0*1 + 0.3*0) / (1.0 + 0.3) = 1 / 1.3
    expect(fuseConfidence(vector)).toBeCloseTo(1 / 1.3, 5);
  });

  it('combines all four signals with a hand-computed weighted mean', () => {
    // weights: cookie=1.0, network=1.0, storage=0.6, dom=0.3
    // values:  cookie=1,   network=0.5, storage=0.5, dom=0.6 (no password form)
    // numerator   = 1.0*1 + 1.0*0.5 + 0.6*0.5 + 0.3*0.6 = 1 + 0.5 + 0.3 + 0.18 = 1.98
    // denominator = 1.0 + 1.0 + 0.6 + 0.3 = 2.9
    // expected = 1.98 / 2.9 = 0.6827586...
    const vector: SignalVector = {
      cookie: { signal: 'cookie', observed: true, value: 1 },
      network: { signal: 'network', observed: true, value: 0.5 },
      storage: { signal: 'storage', observed: true, value: 0.5 },
      dom: { signal: 'dom', observed: true, value: 0.6, passwordFormVisible: false },
    };
    expect(fuseConfidence(vector)).toBeCloseTo(1.98 / 2.9, 5);
  });

  it('unobserved signals (observed: false) are excluded from both numerator and denominator', () => {
    const vector: SignalVector = {
      cookie: { signal: 'cookie', observed: true, value: 1 },
      network: { signal: 'network', observed: false },
      storage: { signal: 'storage', observed: false },
      dom: { signal: 'dom', observed: false },
    };
    expect(fuseConfidence(vector)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 1: nextVerdictState -- pure dual-threshold hysteresis with hold band
// (ENG-03). No time involved.
// ---------------------------------------------------------------------------

describe('nextVerdictState (ENG-03)', () => {
  const fixtures: Array<[number, VerdictState, VerdictState]> = [
    [0.5, 'unknown', 'unknown'],
    [0.5, 'signed-in', 'signed-in'],
    [0.5, 'signed-out', 'signed-out'],
    [0.8, 'unknown', 'signed-in'],
    [0.2, 'signed-in', 'signed-out'],
    // Boundaries: inclusive upper / inclusive lower.
    [0.7, 'unknown', 'signed-in'],
    [0.3, 'unknown', 'signed-out'],
  ];

  it.each(fixtures)(
    'nextVerdictState(%p, %p) -> %p',
    (confidence, previousState, expected) => {
      expect(nextVerdictState(confidence, previousState)).toBe(expected);
    },
  );

  it('mid-band (0.3, 0.7) always preserves previous state -- no flicker', () => {
    expect(nextVerdictState(0.31, 'signed-in')).toBe('signed-in');
    expect(nextVerdictState(0.69, 'signed-out')).toBe('signed-out');
    expect(nextVerdictState(0.45, 'unknown')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Task 2: createConfidenceEngine -- stateful wrapper with injected clock and
// asymmetric debounce (ENG-04).
// ---------------------------------------------------------------------------

describe('createConfidenceEngine (ENG-04)', () => {
  const highConfidenceVector: SignalVector = {
    cookie: { signal: 'cookie', observed: true, value: 1 },
  };
  const lowConfidenceVector: SignalVector = {
    cookie: { signal: 'cookie', observed: true, value: 0 },
  };
  const holdBandVector: SignalVector = {
    cookie: { signal: 'cookie', observed: true, value: 0.5 },
  };

  it('SignedIn commits immediately on the same update() call that first crosses the upper threshold (no delay)', () => {
    let t = 0;
    const engine = createConfidenceEngine(() => t);

    t = 0;
    const result = engine.update(highConfidenceVector);
    expect(result.state).toBe('signed-in');
  });

  it('SignedOut only commits after DEBOUNCE_SIGNED_OUT_MS of continuous below-threshold confidence, measured via the injected clock', () => {
    let t = 0;
    const engine = createConfidenceEngine(() => t);

    t = 0;
    expect(engine.update(highConfidenceVector).state).toBe('signed-in');

    t = 1000;
    // pending timer just started at 1000 -- well within the 3000ms grace window
    expect(engine.update(lowConfidenceVector).state).toBe('signed-in');

    t = 3999;
    // 2999ms elapsed since pending started (1000 -> 3999), < DEBOUNCE_SIGNED_OUT_MS
    expect(engine.update(lowConfidenceVector).state).toBe('signed-in');

    t = 4000;
    // 3000ms elapsed since pending started (1000 -> 4000), >= DEBOUNCE_SIGNED_OUT_MS
    expect(engine.update(lowConfidenceVector).state).toBe('signed-out');
  });

  it('a recovery above the hold band before the grace window elapses cancels the pending SignedOut transition entirely', () => {
    let t = 0;
    const engine = createConfidenceEngine(() => t);

    t = 0;
    expect(engine.update(highConfidenceVector).state).toBe('signed-in');

    t = 1000;
    // pending starts at 1000
    expect(engine.update(lowConfidenceVector).state).toBe('signed-in');

    t = 2000;
    // recovery -- pending is canceled per the "rawState === committedState" branch
    expect(engine.update(highConfidenceVector).state).toBe('signed-in');

    t = 5000;
    // a NEW pending window has just started at t=5000. If the implementation
    // incorrectly reused the original t=1000 pending timestamp, this call
    // would incorrectly already read 'signed-out' since 5000-1000=4000 >= 3000.
    expect(engine.update(lowConfidenceVector).state).toBe('signed-in');
  });

  it('initial state before any update() call is "unknown" by construction (first update with a hold-band confidence returns unknown)', () => {
    const t = 0;
    const engine = createConfidenceEngine(() => t);

    const result = engine.update(holdBandVector);
    expect(result.state).toBe('unknown');
  });

  it('exposes DEBOUNCE_SIGNED_OUT_MS as the grace window used (sanity check against the imported constant, not a hardcoded literal)', () => {
    expect(DEBOUNCE_SIGNED_OUT_MS).toBe(3000);
  });

  it('the default clock parameter falls back to Date.now (constructed with no arguments)', () => {
    const engine = createConfidenceEngine();
    const result = engine.update(holdBandVector);
    expect(result.state).toBe('unknown');
    expect(typeof result.confidence).toBe('number');
  });
});
