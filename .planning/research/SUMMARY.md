# Project Research Summary

**Project:** Sign-In Detector Browser Extension (Chrome MV3, Firefox-compatible)
**Domain:** Browser extension — cross-context signal fusion, zero-config auth-state detection
**Researched:** 2026-07-17
**Confidence:** HIGH (stack, architecture, MV3 platform behavior) / MEDIUM (detection-heuristic accuracy, multi-domain clustering)

## Executive Summary

This is a Chrome MV3 extension that fuses four weak, independently-observed signals — cookies (backbone), network status codes, storage tokens, DOM markers — into a single weighted-confidence verdict per tab, rendered as a border overlay. No single signal is trusted; the whole product is the fusion + hysteresis logic, not any one sensor. Research (stack, features, architecture, pitfalls, and an independent Google AI Mode consult) converges tightly: build the `ConfidenceEngine` (weighted mean over observed-only signals, dual-threshold hysteresis, 0.7/0.3) first and in isolation from any Chrome API — it is both the highest-value and highest-bug-risk component, and it is 100% unit-testable without a browser. Everything else (cookie/network/storage/DOM sensors, messaging, border rendering) is comparatively mechanical glue around that core.

The recommended approach is WXT (Vite-based extension framework) + TypeScript 6.0.3 (explicitly not 7.x — see Stack) + Vitest/fake-browser for the TDD inner loop + Playwright for the one true e2e path. Architecture is forced by MV3's process split: `cookies`/`webRequest` only exist in the service worker, `localStorage`/DOM only exist in the content script, so the engine lives in the SW as the sole fusion authority and the content script stays a thin sensor+renderer, connected by one-shot messaging (not long-lived ports). The single biggest platform trap is service-worker statelessness: the SW is routinely killed after ~30s idle and wipes any in-memory hysteresis state, so verdict state MUST live in `chrome.storage.session`, not a module-level `Map`, from day one — this is not an optimization, it is correctness.

Key risks: (1) false positives from "remember-me" cookies surviving dead sessions, tracking cookies mimicking session-cookie shape, and DOM keyword matches on marketing copy — all mitigated by the fusion weighting already in the design (HttpOnly filtering, 401/403 as strong negative, DOM as low-weight corroboration only); (2) MV3 platform gotchas (SW suspension, `<all_urls>` review friction, Top-Layer/Trusted-Types CSS conflicts) that are well-documented and testable, not open research questions; (3) an independent Google AI Mode consult converged almost exactly on the same weighted-fusion + hysteresis design, which raises confidence in the core approach, and additionally surfaced two cheap, high-value refinements (explicit false-positive weighting for guest JWTs/stale tokens/GraphQL soft-200s, and asymmetric login/logout debounce) that are worth folding into the MVP engine — see the Google AI section below. Everything else Google surfaced (multi-domain clustering via CORS/redirect-chains/cross-tab sniffing/Related Website Sets) is real but expensive, and should be deferred — it doesn't change what ships for MVP, only what ships after.

## Key Findings

### Recommended Stack

WXT is the clear 2026 default for cross-browser MV3 extensions (Vite-based, first-party Vitest+fake-browser test integration, manifest generation for both Chrome and Firefox from one codebase) — chosen over CRXJS (Chromium-only, fails the Firefox-compatible requirement) and Plasmo (Parcel-based, slower, community describes as maintenance-mode).

**Core technologies:**
- **WXT `0.20.27`** — extension framework/build tooling — de-facto standard, gives manifest generation + HMR + `wxt/browser` cross-browser API surface + built-in test mocking for free; avoids hand-rolling Chrome/Firefox manifest diffs.
- **TypeScript `6.0.3` — NOT `7.0.2`** — language/type-checker — TS 7.0 GA'd July 8, 2026 (9 days before this research) as a from-scratch Go-native compiler shipped **without a stable programmatic API** (deferred to 7.1); `typescript-eslint`'s type-aware rules crash under it and the project has closed TS7 support as "not planned," with peer-dep ranges (`typescript >=4.8.4 <6.1.0`) actively blocking clean installs of `typescript-eslint@8.x` alongside TS7. Pin `6.0.3` (latest 6.x, same strict defaults) until tooling certifies TS7 — this is a same-week landmine, not stale training data.
- **Vitest `4.1.10` + `@webext-core/fake-browser 1.5.2`** — unit/integration test runner + in-memory `chrome.*` mock — this is what makes the `ConfidenceEngine` and every sensor classifier TDD-able with zero real browser, matching the project's TDD-heavy process constraint.
- **happy-dom (default) / jsdom (per-file fallback)** — DOM test environment for content-script/border-overlay tests — happy-dom is 5-10x faster and implements `MutationObserver`, which the DOM sensor and border self-healing logic both depend on.
- **`@playwright/test 1.61.1`** — real-browser e2e — the only way to validate actual MV3 lifecycle behavior (SW suspend/wake, real `cookies.onChanged`, real content-script injection) that fake-browser cannot simulate; load `.output/chrome-mv3` directly, no packaging step.
- **`tldts 7.4.9`** — eTLD+1 (registrable-domain) resolution — Chrome has no built-in PSL API (unlike Firefox); `tldts` is ~1000x faster than `psl`, zero runtime deps, bundles PSL data inline (required since MV3 forbids fetching remote code).
- **`@webext-core/messaging 3.0.2`** — typed content-script ↔ service-worker messaging — replaces stringly-typed `sendMessage`/`onMessage` with a compile-time-checked protocol map, same maintainer family as WXT's own fake-browser.
- **Hand-rolled JWT-shape check (no library)** — storage-sensor token classification — the design only classifies shape (3 base64url segments, `alg`/`typ` in header), never validates; pulling in `jsonwebtoken`/`jose` (server-oriented, verify/sign machinery) would be scope creep and unnecessary attack surface in a content script.

### Expected Features

Feature research confirms the entire Table-Stakes list is the strict dependency chain: 4 sensors → ConfidenceEngine → hysteresis state machine → border overlay, all gated behind eTLD+1 identity and event-driven (never polling) recompute wiring. There is no meaningful "P1.5" — everything table-stakes is required for the core value claim to be true, and everything else is genuinely deferrable without breaking that claim.

**Must have (table stakes — P1, all required for MVP to do the one thing it claims):**
- Cookie sensor (`cookies` API + `onChanged`, shape classification only — HttpOnly+Secure+entropy+expiry, never raw value)
- Network sensor (`webRequest.onCompleted`, status/header heuristics on identity-endpoint-shaped URLs; 401/403 = strong negative)
- Storage sensor (localStorage/sessionStorage JWT-shape / auth-key-name heuristics, content-script scope)
- DOM sensor + debounced MutationObserver (logout/account UI present AND no password form — low weight, universal fallback)
- ConfidenceEngine (weighted fusion over observed-only signals, graceful degradation, strong-negative subtraction)
- Hysteresis state machine (Unknown/SignedIn/SignedOut, 0.7/0.3 thresholds, hold band — prevents flicker)
- Registrable-domain (eTLD+1) identity via `tldts` — collapses `api.`/`cdn.`/`www.` into one WebAppKey
- Event-driven recompute wiring across all sensors (no polling, no navigation dependency — cross-cutting, not a standalone item)
- Cross-context message transport (content script ↔ service worker), reconnect-safe across SW restarts
- Border overlay (closed Shadow DOM, top frame only, re-asserted on mutation)
- Local-only processing enforcement (derived numbers only in memory/session storage; never raw cookie/token values persisted or transmitted)

**Should have (differentiators — defer to v1.x, cheap once MVP core exists):**
- Unknown-state border treatment (dashed/amber) — pure rendering branch, reuses existing state machine
- Cross-tab verdict sharing by WebAppKey — optimization, not correctness (each tab already converges independently)
- Weight/threshold calibration pass — needs real usage data beyond the 3-4 MVP test apps, not a code feature
- OAuth-IdP grace handling — explicitly deferred in the approved design doc; MVP "tolerates a brief re-evaluation" instead

**Defer to v2+ / anti-features (explicitly out of scope, do not reintroduce in phases):**
- Popup UI — the border IS the UI by design; no core-value contribution
- Per-app rule packs — directly contradicts "zero per-app configuration" core value
- WHO is signed in (identity/avatar extraction) — expands privacy surface for no core-value gain
- Modifying/blocking/proxying the webapp — read-only observation is a hard trust boundary
- Least-privilege/per-site permission mode — architecturally in tension with always-on background detection; needs its own design pass + likely a popup prerequisite
- GraphQL body-aware network signal via MAIN-world fetch/XHR hook — real complexity/attack-surface increase, already backstopped by cookie+storage signals
- Polling-based sensors — directly violates the "recompute on events, not navigation" requirement
- Firefox port — parallel/later track; Chrome MVP validates the core approach first

### Architecture Approach

MV3's process model forces a specific shape: `cookies`/`webRequest` are service-worker-only APIs, `localStorage`/DOM are content-script-only, so the `ConfidenceEngine` must live in the SW as the single fusion authority, fed by two paths — direct in-process calls from Cookie/Network sensors (same context) and one-shot `runtime.sendMessage` from Storage/DOM sensors (cross-context). The SW itself is not a long-running process (~30s idle kill, routine restarts), so verdict/hysteresis state must be persisted to `chrome.storage.session` (in-memory, ~10MB quota, cleared on browser exit — satisfies the "no raw persistence" constraint since only derived numbers go in it) and rehydrated lazily on every SW wake, never assumed continuous.

**Major components:**
1. `shared/types.ts` + `shared/constants.ts` — message contracts and weights/thresholds; the seam between two independently-restarting runtimes, built first, blocks nothing else conceptually but everything depends on it.
2. `engine/confidenceEngine.ts` + `identity/appIdentity.ts` + four `*Sensor.classify.ts` pure classifiers — zero Chrome-API-surface, fixture/table-driven TDD, fully parallelizable across contributors — this is where the actual detection logic and risk live.
3. `background/state/verdictStore.ts` — `chrome.storage.session` adapter, SW-restart-safe.
4. `background/sensors/*.ts` (Chrome glue), `background/messaging/router.ts` — thin wrappers calling the Tier-1 classifiers/engine; narrowest, most sequential part of the build since it depends on frozen classifier signatures.
5. `background/background.ts` + `content/content.ts` (wiring) + `content/overlay/borderOverlay.ts` — top-level synchronous listener registration (a hard MV3 requirement, not optional), closed-Shadow-DOM rendering.

### Critical Pitfalls

1. **Service-worker suspension silently wipes in-memory verdict/hysteresis state** — the #1 MV3 migration bug; test idle-then-resume with DevTools *closed* (DevTools open masks this). Fix: `chrome.storage.session` for all verdict state from the first line of code, not an afterthought.
2. **`z-index: 2147483647` does not beat the CSS Top Layer** (`<dialog>`, Popover, `::backdrop`, fullscreen) — the border can be invisibly defeated by any page using native modals or `requestFullscreen()`. Additionally, `innerHTML`/`style.cssText` injection throws on Trusted-Types/CSP-strict sites (banks, enterprise SaaS — exactly where this signal matters most). Fix: `document.createElement` + CSSOM property assignment only, never string injection; document fullscreen/Top-Layer defeat as an accepted edge case rather than chasing it.
3. **Cookie-consent/analytics cookies (`_ga`, `OptanonConsent`, `_fbp`) mimic the "long-expiry, high-entropy" session-cookie shape** — mitigated almost entirely by weighting `HttpOnly` (JS-set trackers can never be HttpOnly), plus a small denylist of well-known tracking-cookie name patterns as a pragmatic, documented exception to "zero config" (cross-app infra names, not per-app rules).
4. **Raw cookie/token values must never cross the content-script ↔ service-worker message boundary or land in `chrome.storage`** — enforce via narrow, typed message contracts (booleans/enums only, no `.value`/`.token` fields) so a leak is a type error, not a code-review miss; add a pre-ship grep audit of `console.*`/`chrome.storage.*`/`sendMessage` call sites.
5. **SPA re-keying by URL instead of eTLD+1 causes verdict thrashing on every in-app route change** — enforce `WebAppKey` as a branded `RegistrableDomain` type at the TypeScript level, not a plain string alias of URL; test that route changes within the same eTLD+1 preserve state.

## Implications for Roadmap

### Phase 1: Foundation — Contracts + Pure Detection Logic
**Rationale:** Everything downstream depends on `shared/types.ts` and the four Chrome-API-free modules; this tier is 100% unit-testable without a browser and is where the actual product risk (fusion correctness) lives — build and prove it before touching any Chrome API.
**Delivers:** `shared/types.ts`/`constants.ts`, `engine/confidenceEngine.ts` (fusion + hysteresis + asymmetric debounce + explicit FP weighting — see Google AI section), `identity/appIdentity.ts` (eTLD+1 via tldts), four sensor `*.classify.ts` pure functions.
**Addresses:** ConfidenceEngine, Hysteresis, Registrable-domain identity, all four sensor classification heuristics (FEATURES.md P1).
**Avoids:** Pitfall 1 (remember-me/dead-session false positive — fusion math), Pitfall 3 (tracking-cookie confusion — HttpOnly weighting + denylist), Pitfall 10 (SPA URL re-keying — branded type).

### Phase 2: State & Persistence
**Rationale:** SW-restart-safety must be designed in from the start, not retrofitted; this is a small, isolated deliverable that everything Chrome-facing depends on.
**Delivers:** `background/state/verdictStore.ts` (`chrome.storage.session` adapter, rehydrate-on-demand, clear-on-tab-close).
**Uses:** `@webext-core/fake-browser` for storage-mocked unit tests.
**Implements:** Pattern 1 (SW-restart-safe verdict state) from ARCHITECTURE.md.
**Avoids:** Pitfall 5 (SW suspension wipes state) — the single most common MV3 migration bug.

### Phase 3: Chrome Glue — Sensors, Messaging, Overlay
**Rationale:** Now that classifier interfaces are frozen (Phase 1) and storage exists (Phase 2), wrap them in the thin, mostly-boilerplate Chrome API layer; narrowest/most sequential part of the tree, keep it small.
**Delivers:** `background/sensors/{cookie,network}Sensor.ts` (Chrome glue), `content/sensors/{storage,dom}Sensor.ts`, `background/messaging/router.ts` (one-shot messaging, not ports), `content/overlay/borderOverlay.ts` (closed Shadow DOM, createElement/CSSOM only).
**Addresses:** Cross-context message transport, Border overlay (FEATURES.md P1).
**Avoids:** Pitfall 11 (Top Layer/Trusted Types), Pitfall 4 (iframe session bleed — `all_frames: false`, domain-scoped `cookies.getAll`).

### Phase 4: Wiring & End-to-End Flow
**Rationale:** Final assembly — register every listener synchronously at top level (a structural MV3 requirement verified by code review, not a runtime test), wire content script entrypoint, produce the first working signal→verdict→border pipeline.
**Delivers:** `background/background.ts`, `content/content.ts`, working manifest with `cookies`/`webRequest`/`scripting`/`storage`/`<all_urls>` permissions.
**Addresses:** Event-driven recompute wiring, Local-only processing enforcement (FEATURES.md P1).
**Avoids:** Anti-Pattern 3 (conditional/deferred listener registration silently breaks re-attach after first SW restart).

### Phase 5: Validation & Hardening
**Rationale:** The design's own "looks done but isn't" risks (idle-SW flicker, iframe bleed, Trusted-Types sites, tracking-cookie false positives, OAuth flicker) only surface under specific test conditions that a fast manual smoke test won't hit — this phase exists specifically to force those conditions.
**Delivers:** Playwright integration test (mock SPA: set cookie → verdict flips → border appears, including a route-change case), manual pass against 3-4 real apps (Google property, GitHub, plain cookie-session app) covering: idle 60s+ with DevTools closed, a cookie-banner-only news site, a fullscreen-capable app, a CSP/Trusted-Types-strict site (bank/enterprise SaaS), one real OAuth ("Sign in with Google/GitHub") flow, a privacy-audit grep of message/storage call sites.
**Addresses:** Ship-readiness for all P1 features.
**Avoids:** Pitfalls 2, 5, 8, 11, 12, 13 (all "looks done but isn't" items) — this phase is the checklist from PITFALLS.md made executable.

### Phase Ordering Rationale

- Strict dependency chain (sensors → engine → hysteresis → border, per FEATURES.md's own dependency graph) maps directly onto ARCHITECTURE.md's 5-tier build order — phases 1-2 are Chrome-API-free and TDD-parallelizable across contributors (matches PROJECT.md's "favor parallel work streams" constraint), phases 3-4 narrow to sequential Chrome glue, phase 5 is validation-only.
- Persistence (Phase 2) is deliberately pulled forward, before any Chrome sensor glue, because Pitfall 5 (SW suspension) is a correctness bug, not a polish item — building sensors against an in-memory `Map` first and "adding persistence later" is exactly the technical-debt trap PITFALLS.md flags as unacceptable for anything demoed as working.
- Validation (Phase 5) is its own phase, not folded into Phase 4, because most of PITFALLS.md's critical items only reproduce under specific conditions (idle timers, particular site types) that require deliberate, separate test scenarios rather than incidental coverage during feature wiring.

### Research Flags

Phases likely needing deeper research during planning:
- **None mandatory.** All five phases rest on already-verified MV3 platform behavior (HIGH confidence, official Chrome docs) and an already-approved design doc. If time allows, a narrow spot-check on Phase 5 (real-app OAuth flow behavior, Trusted-Types site selection) could sharpen the manual test list, but it is not blocking.

Phases with standard patterns (skip research-phase):
- **Phase 1-4:** Well-documented MV3/WXT/Vitest patterns, verified against official Chrome for Developers docs and current library documentation. No open questions.

## Google AI Mode — Second Opinion: Adopt vs Defer

An independent Google AI Mode consult (6 questions, blind to our design until the final targeted follow-up) converged closely on our fusion+hysteresis architecture, which raises confidence in the core approach, and surfaced 6 gaps. Bias toward a small MVP: advanced multi-domain clustering defers; two cheap, high-leverage refinements to the engine adopt now.

| # | Gap | Verdict | Reason |
|---|-----|---------|--------|
| a | CORS header introspection (`Access-Control-Allow-Origin`/`-Credentials`) for multi-domain clustering | **Defer** | Real signal for apps spanning non-subdomain domains, but adds a new observation surface + trust-graph state (union-find in storage) for a case eTLD+1 already handles for the common (subdomain) case; already a documented, accepted MVP limitation, not a bug. |
| b | `declarativeNetRequest` cannot read header values back to the extension — confirms `webRequest` + `<all_urls>` tier and the Chrome Web Store deep-review consequence | **Adopt (confirms existing decision)** | Not new scope — independent confirmation that our locked choice (non-blocking `webRequest.onCompleted`, not DNR) is the only viable path to the network signal; document the Web-Store review-tier cost as a known ship-timeline risk. |
| c | Redirect-chain/OAuth mapping (`webNavigation`) + cross-tab `postMessage`/`BroadcastChannel` sniffing for domain clustering | **Defer** | Meaningful complexity (tracker-pattern filtering, new hook surface) for a case (OAuth-IdP grace, multi-domain suites) already explicitly deferred in the approved design doc; revisit post-MVP alongside OAuth-IdP grace handling. |
| d | Related Website Sets (formerly First-Party Sets) clustering | **Reject for MVP** | Only covers large registered brands, requires bundling a snapshot of the public registry (no MV3 query API), and is explicitly not useful for the small/custom-enterprise apps that are this extension's actual target — low ROI. |
| e | Explicit false-positive weighting: guest/anonymous JWTs, stale storage tokens left after tab close, GraphQL soft-200 errors | **Adopt-in-MVP** | Cheap — pure additions to the already-planned `*Sensor.classify.ts` heuristics (Phase 1), no new permissions, no new architecture. High value — directly hardens against false positives PITFALLS.md already flags; Google's independent framing sharpens exactly which fields to check. |
| f | Asymmetric debounce — instant login, delayed (3-5s) logout — layered on top of symmetric hysteresis | **Adopt-in-MVP** | Cheap — a single additional timer on the SignedIn→SignedOut transition inside the state machine we're already building in Phase 1; no new sensors, no new permissions. High value — an explicit logout-side grace period is a more robust, more explainable fix and directly reduces the "border flickers during normal use" UX pitfall. |

**Net effect on scope:** No new phases, no new permissions, no new Chrome APIs. Items (e) and (f) become explicit sub-requirements inside Phase 1's `ConfidenceEngine`/classifier work (add to that phase's test matrix); item (b) becomes a documentation/expectations note, not code; items (a), (c), (d) stay out of MVP scope entirely.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified same-day against Context7 (`/wxt-dev/wxt`), live npm registry, TypeScript devblog, and a live `typescript-eslint` GitHub issue — the TS 6-vs-7 pin is a same-week landmine caught in real time. |
| Features | HIGH | The approved design doc already specifies the architecture; feature research cross-verified against Chrome/MDN docs for MV3 API behavior. |
| Architecture | HIGH | All MV3 lifecycle/messaging/API claims verified against official Chrome for Developers docs. |
| Pitfalls | MEDIUM-HIGH | Platform-behavior pitfalls HIGH confidence (official docs); detection-heuristic pitfalls MEDIUM — that's what Phase 5's real-app manual testing is for. |
| Google AI second opinion | MEDIUM | Independent convergence on core architecture is a strong qualitative signal; AI Mode's numeric claims are approximate and treated as directional only. |

**Overall confidence:** HIGH — the core architecture and stack are well-verified; the only genuine open question is real-world detection accuracy, explicitly scoped into Phase 5.

### Gaps to Address

- **Detection-heuristic accuracy at scale**: deferred to v1.x weight/threshold calibration — ship with documented-as-provisional 0.7/0.3 values plus the two Google-sourced refinements (e, f), calibrate post-MVP.
- **Web Store review-tier timeline risk** (`<all_urls>` + `webRequest` triggers deep manual review): not a code gap but a ship-timeline risk — flag as an early, parallel-track action item.
- **CHIPS/partitioned cookies**: scoped out of MVP — document as a known limitation.

## Sources

### Primary (HIGH confidence)
- Context7 `/wxt-dev/wxt` — unit testing, manifest/tsconfig generation, browser API typing
- [Chrome for Developers — extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome for Developers — chrome.storage API reference](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome for Developers — chrome.webRequest API reference](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- [Chrome for Developers — chrome.cookies API reference](https://developer.chrome.com/docs/extensions/reference/api/cookies)
- [Chrome for Developers — Replace blocking web request listeners](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)
- [Announcing TypeScript 7.0 — devblogs.microsoft.com](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [typescript-eslint TS7 support issue #12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518)
- [MDN — publicSuffix WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/publicSuffix)
- [MDN — CHIPS / Partitioned cookies](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies)
- Project design doc: `docs/superpowers/specs/2026-07-17-signin-detector-extension-design.md` (approved MVP design)
- Project requirements: `.planning/PROJECT.md`

### Secondary (MEDIUM confidence)
- Google AI Mode consultation (real browser automation, 6-question blind consult) — `.planning/research/GOOGLE-AI-CONSULT.md` — independent architecture convergence + false-positive/debounce refinements
- [tldts GitHub benchmarks](https://github.com/remusao/tldts/blob/master/comparison/comparison.md) — performance vs `psl`
- Chromium extensions group discussion on port lifetime post-Chrome-110 (community/engineering, consistent across threads)
- happy-dom vs jsdom 2026 comparison — corroborated by Vitest's own docs

### Tertiary (LOW confidence)
- Google AI Mode's specific numeric claims (exact SW idle timeout, wake-latency ranges) — self-flagged as approximate, directional only

---
*Research completed: 2026-07-17*
*Ready for roadmap: yes*
