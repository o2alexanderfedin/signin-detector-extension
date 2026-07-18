---
phase: 1
status: passed
verified: 2026-07-17
tests: 72 passing
---

# Phase 1: Detection Core — Verification

**Result:** ✅ PASSED — all Phase 1 success criteria met, independently re-verified on the merged `develop` result.

## Success criteria (from ROADMAP)

1. ✅ Graceful degradation — engine returns weighted-mean verdict over observed signals only, ignoring silent classes. *(engine fixture tests)*
2. ✅ Strong-negative evidence decreases confidence (401/403; password form + no cookie override). *(engine tests)*
3. ✅ Hysteresis Unknown→SignedIn→SignedOut at 0.7/0.3 with hold band + asymmetric logout grace via injected clock. *(engine tests, deterministic clock)*
4. ✅ FP down-weighting for guest/anonymous JWT, stale token, GraphQL soft-200. *(engine + storage/network tests)*
5. ✅ Shape-only classifiers + stable branded `WebAppKey` across subdomains/SPA routes. *(classifier + appIdentity tests)*

## REQ-ID coverage (12/12)

| REQ | Covered by |
|-----|-----------|
| ENG-01..05 | `src/engine/confidenceEngine.test.ts` |
| SEN-01, SEN-02 | `src/sensors/cookie/classify.test.ts` |
| SEN-03 | `src/sensors/network/classify.test.ts` |
| SEN-04 | `src/sensors/storage/classify.test.ts` |
| SEN-05 | `src/sensors/dom/classify.test.ts` |
| IDN-01, IDN-02 | `src/identity/appIdentity.test.ts` |

## Gates

| Gate | Result |
|------|--------|
| Unit tests | 72 passing / 0 failing |
| `tsc --noEmit` (strict) | clean |
| `eslint .` (typed) | clean |
| `wxt build` | manifest_version 3 emitted |
| Purity (no chrome/wxt in pure modules) | clean |
| Privacy (no raw values in message types) | clean |

**Human verification needed:** none for this phase (pure logic, fully automated). Real-browser behavior is validated in Phase 5.
