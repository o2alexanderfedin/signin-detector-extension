# Phase 1: Detection Core — Engine, Sensors & Identity - Context

**Gathered:** 2026-07-17
**Status:** Ready for planning
**Mode:** Auto-accepted from research (autonomous mode — decisions locked by SUMMARY.md/REQUIREMENTS.md, no open grey areas)

<domain>
## Phase Boundary

Build the entire detection brain as **pure, Chrome-API-free TypeScript**, fully unit-tested, before any browser integration exists:

- `engine/confidenceEngine.ts` — weighted fusion over observed-only signals + hysteresis state machine + asymmetric logout debounce.
- `identity/appIdentity.ts` — eTLD+1 (registrable-domain) resolution via `tldts`, returning a branded `WebAppKey`.
- Four pure classifiers — `cookieSensor.classify.ts`, `networkSensor.classify.ts`, `storageSensor.classify.ts`, `domSensor.classify.ts` — each mapping raw observed input to a normalized `{signal, value∈[0,1], observed}` evidence object (shape-only; never interpret raw values).
- `shared/types.ts` + `shared/constants.ts` — signal/verdict/message types and the weight/threshold constants.

**In scope:** ENG-01..05, SEN-01..05, IDN-01..02 (12 requirements).
**Out of scope for this phase:** any `chrome.*` API call, messaging, persistence, DOM rendering, wiring. Those are Phases 2–4. This phase must have zero import of Chrome/WXT runtime APIs.
</domain>

<decisions>
## Implementation Decisions

These are locked by `.planning/research/SUMMARY.md` and `REQUIREMENTS.md`; recorded here so planning/execution need not re-derive them. Anything not listed is **Claude's discretion**, guided by TDD + SOLID/KISS/DRY/YAGNI.

### Fusion & state machine (ENG-01..05)
- **Fusion formula:** `confidence = Σ(weightᵢ · valueᵢ) / Σ(weightᵢ for observed i)` — weighted mean over **observed signals only** (a silent signal class is excluded from both numerator and denominator, not treated as 0).
- **Signal weights (provisional, from research — expose as named constants for later calibration):** Cookie = HIGH, Network = HIGH, Storage = MEDIUM, DOM = LOW. Concrete starting values at Claude's discretion (e.g. 1.0 / 1.0 / 0.6 / 0.3) but MUST be named constants in `shared/constants.ts`, not magic numbers.
- **Strong negatives subtract:** identity-endpoint 401/403, or (visible password form AND no session cookie) push confidence down rather than being neutral.
- **Thresholds:** ≥ 0.7 → SignedIn, ≤ 0.3 → SignedOut, middle band holds previous state; initial state = Unknown. Values are named constants.
- **Asymmetric debounce (ENG-04):** SignedIn is entered promptly (no/low delay); SignedOut transition is delayed by a grace window (default ~3s, named constant) so token-refresh blips don't flip the verdict. The engine must be **time-injectable** (pass a clock/`now` function) so the debounce is deterministically unit-testable — do NOT call `Date.now()` directly.
- **False-positive weighting (ENG-05):** guest/anonymous JWTs (e.g. claims indicating anonymous/guest), stale storage tokens (expired `exp`), and GraphQL "soft-200" auth-error shapes are down-weighted / not counted as signed-in. Detection is shape/claim-based, still never trusting a single signal.

### Sensors / classifiers (SEN-01..05) — all pure, shape-only
- **Cookie:** classify shape — HttpOnly + Secure + high-entropy value + long expiry, scoped to the WebAppKey → positive; never read value for meaning. Down-weight known tracking/consent cookie **name** patterns via a small cross-app denylist constant (`_ga`, `_gid`, `_fbp`, `OptanonConsent`, `__utm*`, etc.) — infra names, not per-app rules (SEN-02).
- **Network:** input is an observed request/response descriptor (URL, method, status, presence of `Authorization: Bearer`); identity-endpoint-shaped URL (`/me`, `/session`, `/account`, `/user`, GraphQL `viewer`) with 200 → positive, 401/403 → strong negative. Status/header only — no body.
- **Storage:** detect JWT-shaped values (3 base64url segments, header has `alg`/`typ`) and `auth`/`session`/`token`-style key names; check `exp` for staleness. Shape only.
- **DOM:** input is a normalized DOM snapshot (booleans/counts, not live DOM) — logout/account/avatar affordance present AND no password-login surface → low-weight positive.

### Identity (IDN-01..02)
- **WebAppKey** = registrable domain (eTLD+1) from the top-frame URL via `tldts`. Model as a **branded type** (`type WebAppKey = string & { readonly __brand: 'WebAppKey' }`) so a raw URL/string can't be passed where a key is expected — this structurally prevents SPA-route re-keying thrash (IDN-02).

### Testing
- **TDD, test-first**, table/fixture-driven. Vitest. Each classifier + the engine gets a fixtures table (input matrix → expected output). Cover: graceful degradation (subset of signals), strong-negative subtraction, hysteresis transitions + hold band, asymmetric debounce timing (via injected clock), FP down-weighting cases, and identity stability across subdomains/routes.
</decisions>

<code_context>
## Existing Code Insights

Greenfield — no source code yet. The repo currently holds only `.planning/` docs and the approved design spec. The project skeleton (WXT + TypeScript 6.0.3 + Vitest + happy-dom + tldts + @webext-core/*) does not exist yet, so Phase 1 planning must include **scaffolding the project** (package.json, WXT config, tsconfig with strict flags incl. `noUncheckedIndexedAccess`, Vitest config) before/as part of writing the pure modules. Stack + versions are pinned in `.planning/research/STACK.md` (note: **TypeScript 6.0.3, NOT 7.x**).

Directory layout to follow (from ARCHITECTURE.md): `src/shared/`, `src/engine/`, `src/identity/`, `src/sensors/*/` (classifiers here; Chrome glue added in Phase 3).
</code_context>

<specifics>
## Specific Ideas

- Keep every Phase-1 module free of `chrome.*` / `wxt/browser` imports so the whole phase runs under plain Vitest with zero browser mocks — this is the point of building the core first.
- Prefer pure functions + small classes; inject time and any nondeterminism.
- Model signal evidence and verdicts as discriminated unions / ADTs; make invalid states unrepresentable.
</specifics>

<deferred>
## Deferred Ideas

- Weight/threshold **calibration** against real usage data → v1.x (ship provisional constants now).
- OAuth-IdP grace, multi-domain clustering (CORS/cross-tab), Unknown-state border styling, cross-tab verdict sharing → later phases / v1.x per ROADMAP.
</deferred>
