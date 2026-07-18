# Phase 1: Detection Core — Summary

**Completed:** 2026-07-17
**Branch:** built on `feature/phase-1-detection-core-engine-sensors-identity` (worktree), merged `--no-ff` into `develop`
**Status:** ✅ Complete — verified green

## What was built

Pure, Chrome-API-free TypeScript detection core (100% unit-testable, zero browser integration), scaffolded on WXT 0.20.27 + TypeScript 6.0.3.

| Module | Delivers | REQ-IDs |
|--------|----------|---------|
| `src/shared/types.ts` | Discriminated-union `SignalEvidence`, `VerdictState`/`VerdictResult`, branded `WebAppKey`, boolean/enum-only message contracts (no raw-value fields) | (contracts) |
| `src/shared/constants.ts` | Named weights (cookie/network 1.0, storage 0.6, dom 0.3), thresholds (0.7/0.3), debounce (in 0ms / out 3000ms), tracking-cookie & identity-endpoint patterns | (contracts) |
| `src/engine/confidenceEngine.ts` | Observed-only weighted fusion, strong-negative override (password form + no cookie), 0.7/0.3 hysteresis + hold band, asymmetric logout debounce via **injected clock** (no `Date.now()`), FP down-weighting (guest JWT / stale token / GraphQL soft-200) | ENG-01..05 |
| `src/identity/appIdentity.ts` | `resolveWebAppKey` — eTLD+1 via `tldts` → branded `WebAppKey`; subdomain collapse; SPA route/hash stable; null for non-http(s)/IP/localhost | IDN-01, IDN-02 |
| `src/sensors/{cookie,network,storage,dom}/classify.ts` | Shape-only pure classifiers (cookie shape + denylist; network status/header-only; storage JWT-shape + stale/guest; DOM boolean-snapshot) | SEN-01..05 |

## Verification (independently re-run on the merge result)

- **72 tests passing** (7 files) — TDD: every test confirmed RED before implementation
- `tsc --noEmit` **clean** under strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- `eslint .` (typed) **clean**
- `wxt build` emits **`manifest_version: 3`**
- **Purity audit:** zero `chrome.*` / `wxt/browser` imports in `src/engine`, `src/identity`, `src/sensors`
- **Privacy audit:** message/verdict types carry only booleans/enums/numbers — no raw cookie/token/password fields

## Notable decisions / deviations

- ENG-02 cross-signal rule ("password form + no session cookie") resolved as a **fuse-level override** (a DOM-only classifier can't know cookie state) — documented in the plan.
- eslint flat-config self-linting needed `projectService.allowDefaultProject` for `eslint.config.mjs` (standard typescript-eslint pattern); does not touch any `src/shared` contract.
- All four signal classifiers import scoring constants by name (no magic numbers).

## Follow-ons for later phases

- Constants are **provisional** — weight/threshold calibration deferred to v1.x.
- Chrome glue (Phase 3) will wrap these pure classifiers; Phase 2 adds `chrome.storage.session` persistence.
