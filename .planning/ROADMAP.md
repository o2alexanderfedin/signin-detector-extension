# Roadmap: Sign-In Detector Browser Extension

## Overview

The build follows a strict dependency chain forced by MV3's process split and by TDD-first process constraints: prove the detection logic (weighted-fusion engine, four signal classifiers, eTLD+1 identity) entirely in pure, Chrome-API-free TypeScript first, since that is where the actual product risk lives and it's 100% unit-testable without a browser; design in service-worker-restart-safe persistence before any Chrome sensor glue exists, since retrofitting persistence is the #1 MV3 migration bug; wrap the frozen classifiers in thin Chrome API glue (cookies, webRequest, storage, DOM) plus the border overlay; wire everything into a live end-to-end pipeline with correct listener registration and privacy enforcement; then validate against the specific real-world conditions (idle SW, CSP-strict sites, OAuth flows, tracking-cookie shapes) that make sign-in detection silently wrong. Five phases, each a coherent, independently verifiable delivery boundary.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Detection Core — Engine, Sensors & Identity** - Pure, Chrome-API-free fusion engine, four signal classifiers, and eTLD+1 identity, fully unit-tested ✅ (72 tests)
- [x] **Phase 2: State & Persistence** - Verdict/hysteresis state survives service-worker suspension via `chrome.storage.session` ✅ (86 tests)
- [ ] **Phase 3: Chrome Glue — Sensors, Messaging & Border Overlay** - Real cookies/network/storage/DOM sensors, one-shot messaging, and a tamper-resistant border render
- [ ] **Phase 4: Wiring & End-to-End Flow** - Live extension: event-driven recompute, restart-safe listeners, privacy-enforced messaging
- [ ] **Phase 5: Validation & Hardening** - Proven correct under idle-SW, CSP-strict, tracking-cookie, and real-OAuth conditions

## Phase Details

### Phase 1: Detection Core — Engine, Sensors & Identity
**Goal**: Given any combination of observed signals, the system computes a correct, flicker-resistant sign-in verdict — entirely in pure, Chrome-API-free TypeScript, before any browser integration exists.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: ENG-01, ENG-02, ENG-03, ENG-04, ENG-05, SEN-01, SEN-02, SEN-03, SEN-04, SEN-05, IDN-01, IDN-02
**Success Criteria** (what must be TRUE):
  1. Given a signal matrix where only a subset of signal classes is observed (e.g. cookie present, network/storage/DOM silent), the ConfidenceEngine returns a weighted-mean verdict over only the observed signals, ignoring the silent ones (graceful degradation).
  2. Given strong negative evidence (identity-endpoint 401/403, or a visible password form with no session cookie), the engine's confidence score decreases rather than being treated as neutral.
  3. Given a sequence of confidence scores crossing 0.7 then falling toward 0.3, the hysteresis state machine transitions Unknown → SignedIn → SignedOut only at the correct dual thresholds with no flicker inside the hold band, and SignedOut is entered only after an asymmetric grace delay while SignedIn is entered promptly.
  4. Given a guest/anonymous JWT, a stale storage token left after tab close, or a GraphQL soft-200 error shape, the relevant classifier down-weights it instead of counting it as a positive signed-in signal.
  5. Given raw cookie objects, storage entries, a DOM snapshot, and a URL as fixture input, each of the four `*.classify.ts` functions returns the correct shape-only classification (never reading values for meaning) and `appIdentity` returns a stable branded `WebAppKey` (registrable domain) that is unchanged across subdomains and SPA route changes on the same eTLD+1.
**Plans**: 3 plans

Plans:
- [ ] 01-01-PLAN.md — Scaffold WXT + TypeScript 6.0.3 toolchain and write the frozen shared contracts (types.ts, constants.ts)
- [ ] 01-02-PLAN.md — Identity resolver (eTLD+1 via tldts) + four pure signal classifiers (cookie, network, storage, DOM), test-first
- [ ] 01-03-PLAN.md — ConfidenceEngine: weighted fusion, dual-threshold hysteresis, asymmetric debounce with injected clock, test-first

### Phase 2: State & Persistence
**Goal**: Verdict and hysteresis state survives service-worker suspension and restart without loss or requiring recomputation from scratch.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: PLT-01
**Success Criteria** (what must be TRUE):
  1. Given verdict/hysteresis state written for a tab, then a simulated service-worker restart (storage-mocked test), the state rehydrates from `chrome.storage.session` with no data loss.
  2. Given a tab is closed, its persisted verdict state is cleared from `chrome.storage.session` — no stale state lingers for that tab.
  3. Given the service worker wakes with no prior state for a tab, the store returns a safe default (Unknown) rather than throwing.
**Plans**: TBD

### Phase 3: Chrome Glue — Sensors, Messaging & Border Overlay
**Goal**: The pure detection core and persisted state are connected to real Chrome APIs — cookies, network responses, storage, DOM — and a visible border renders reliably when the verdict says SignedIn.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: PLT-02, BDR-01, BDR-02, BDR-03, BDR-04
**Success Criteria** (what must be TRUE):
  1. Content-script sensors (storage, DOM) send their classified signal to the service worker via a single one-shot typed message per event — no long-lived port stays open — and the ConfidenceEngine in the service worker remains the sole fusion authority.
  2. When the verdict is SignedIn, a border renders around the top-frame viewport, built entirely with `document.createElement` + CSSOM property assignment (never `innerHTML`/`style.cssText`) inside a closed Shadow DOM.
  3. When the host page mutates the DOM (SPA re-render) or removes the border element, a MutationObserver re-asserts the border within one debounce cycle.
  4. When the verdict transitions away from SignedIn, the border is removed from the page promptly.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Wiring & End-to-End Flow
**Goal**: The full detection pipeline runs live inside a working extension — every sensor recomputes the verdict on real browser events (never navigation, never polling), every listener survives service-worker restarts, and no raw session material ever leaves the service worker or crosses a message boundary.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: RCT-01, PLT-03, PRV-01, PRV-02
**Success Criteria** (what must be TRUE):
  1. Interacting with a real webapp (e.g. logging in via a cookie-session app) triggers a verdict recompute from `cookies.onChanged`, `webRequest.onCompleted`, or a debounced `MutationObserver`/storage event — never from a navigation event, never from a poll timer.
  2. After a forced service-worker restart, all event listeners (`cookies.onChanged`, `webRequest.onCompleted`, `runtime.onMessage`) are still attached and firing, because they are registered synchronously at the top level of `background.ts`.
  3. Inspecting every message payload sent between content script and service worker shows only booleans/enums/numbers — never a raw cookie value, token string, or password field value.
  4. Inspecting network activity while the extension runs shows zero outbound requests initiated by the extension itself; only derived verdict/confidence values exist in `chrome.storage.session`, cleared when the tab closes.
**Plans**: TBD

### Phase 5: Validation & Hardening
**Goal**: The end-to-end pipeline is proven correct under the specific conditions that make sign-in detection silently fail in practice — idle SW suspension, CSP/Trusted-Types sites, tracking-cookie shapes, and a real OAuth flow — before calling the MVP done.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: None new — validates ENG-01..05, SEN-01..05, IDN-01..02, RCT-01, BDR-01..04, PLT-01..03, PRV-01..02 end-to-end
**Success Criteria** (what must be TRUE):
  1. A Playwright e2e test against a mock SPA proves the full loop: setting a session cookie flips the verdict to SignedIn and the border appears, including across an in-app route change on the same eTLD+1 with no verdict thrash.
  2. Manual testing against 3-4 real webapps (a Google property, GitHub, a plain cookie-session app) confirms the verdict survives 60+ seconds of SW idle with DevTools closed, and the border does not falsely trigger on a cookie-banner-only news site.
  3. Manual testing against a CSP/Trusted-Types-strict site (bank or enterprise SaaS) confirms the border still renders without a CSP violation, and testing against a fullscreen-capable app confirms the accepted Top-Layer limitation is documented rather than silently broken.
  4. A real OAuth flow ("Sign in with Google/GitHub") is exercised end-to-end and the verdict correctly settles to SignedIn after redirect, tolerating brief re-evaluation flicker without getting stuck.
  5. A grep-based privacy audit of all `console.*`/`chrome.storage.*`/`sendMessage` call sites confirms zero raw cookie/token values are logged, stored, or transmitted anywhere in the codebase.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Detection Core — Engine, Sensors & Identity | 3/3 | Complete ✅ | 2026-07-17 |
| 2. State & Persistence | 1/1 | Complete ✅ | 2026-07-17 |
| 3. Chrome Glue — Sensors, Messaging & Border Overlay | 0/TBD | Not started | - |
| 4. Wiring & End-to-End Flow | 0/TBD | Not started | - |
| 5. Validation & Hardening | 0/TBD | Not started | - |
