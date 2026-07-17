# Requirements — Sign-In Detector Browser Extension

**Milestone:** v1 (MVP)
**Derived from:** `.planning/PROJECT.md`, approved design doc, `.planning/research/SUMMARY.md`
**Core value:** Correctly distinguish "signed in" from "not signed in" for any webapp — zero-config, no navigation dependency — and reflect it as a visible border.

---

## v1 Requirements

### Detection Engine (ENG)
- [ ] **ENG-01**: The ConfidenceEngine computes a verdict as a weighted mean over only the signals actually observed (graceful degradation when a signal class is silent).
- [ ] **ENG-02**: Strong negative evidence (e.g. identity endpoint 401/403, visible password form + no session cookie) subtracts from confidence.
- [ ] **ENG-03**: A hysteresis state machine maps confidence to Unknown / SignedIn / SignedOut using dual thresholds (0.7 up, 0.3 down) with a hold band to prevent flicker.
- [ ] **ENG-04**: Asymmetric debounce — SignedIn is entered promptly; SignedOut is delayed (grace window) so token-refresh blips don't flip the verdict. *(Google-consult refinement, adopted)*
- [ ] **ENG-05**: Explicit false-positive weighting — guest/anonymous JWTs, stale storage tokens, and GraphQL "soft-200" auth errors are down-weighted rather than counted as signed-in. *(Google-consult refinement, adopted)*

### Sensors (SEN)
- [ ] **SEN-01**: Cookie sensor classifies cookie *shape* (HttpOnly + Secure + high-entropy + long-expiry, scoped to the WebAppKey) and never reads cookie values for meaning.
- [ ] **SEN-02**: Cookie sensor down-weights known tracking/consent cookie name patterns via a small cross-app denylist (not per-app config).
- [ ] **SEN-03**: Network sensor observes identity-endpoint-shaped requests via `webRequest.onCompleted`, treating 200 as positive and 401/403 as strong negative (status/header only, no body parsing).
- [ ] **SEN-04**: Storage sensor detects JWT-shaped values and `auth`/`session`/`token`-style keys in local/sessionStorage (shape only, content-script scope).
- [ ] **SEN-05**: DOM sensor detects logout/account/avatar affordances present AND absence of a password login surface, as a low-weight corroborating signal.

### App Identity (IDN)
- [ ] **IDN-01**: Each tab's top frame is reduced to a WebAppKey = registrable domain (eTLD+1) via `tldts`, collapsing `api.`/`cdn.`/`www.` subdomains into one logical webapp.
- [ ] **IDN-02**: WebAppKey is a branded type (not a raw URL string) so SPA route changes within the same eTLD+1 do not re-key or thrash the verdict.

### Reactivity (RCT)
- [ ] **RCT-01**: The verdict recomputes on events — `cookies.onChanged`, `webRequest` identity-endpoint responses, debounced `MutationObserver`, and storage events — never on navigation and never by polling.

### Border Overlay (BDR)
- [ ] **BDR-01**: When the verdict is SignedIn, a visible border is drawn around the top-frame viewport.
- [ ] **BDR-02**: The overlay is rendered in a closed Shadow DOM using `createElement` + CSSOM only (no `innerHTML`/`style.cssText`), so it survives Trusted-Types/CSP-strict sites.
- [ ] **BDR-03**: The overlay is re-asserted via MutationObserver so it survives SPA re-renders and attempts by the page to detach it.
- [ ] **BDR-04**: The border clears promptly when the verdict leaves SignedIn.

### Platform / State (PLT)
- [ ] **PLT-01**: All per-tab verdict/hysteresis state is persisted to `chrome.storage.session` and rehydrated on service-worker wake, so SW suspension never wipes state.
- [ ] **PLT-02**: The ConfidenceEngine is the sole fusion authority in the service worker; content-script sensors feed it via one-shot typed messages (no long-lived ports).
- [ ] **PLT-03**: All event listeners are registered synchronously at the top level of the service worker (MV3 requirement) so they re-attach after SW restart.

### Privacy (PRV)
- [ ] **PRV-01**: Raw cookie/token values never cross the content-script ↔ service-worker message boundary and never enter `chrome.storage` — enforced by narrow typed message contracts (booleans/enums only).
- [ ] **PRV-02**: The extension makes no outbound network calls; only derived numbers/verdicts exist in memory/session storage, cleared on tab close.

---

## v2 Requirements (deferred — expected next, not in MVP)

- Unknown-state border treatment (dashed/amber)
- Cross-tab verdict sharing by WebAppKey
- Weight/threshold calibration pass against real usage data
- OAuth-IdP grace handling (redirect-chain mapping)
- Least-privilege / per-site permission mode
- Firefox port (Chrome MVP validates the approach first)

---

## Out of Scope (explicit exclusions)

- **Popup UI** — the border IS the UI by design; no core-value contribution.
- **Per-app rule packs / filter lists** — directly contradicts the zero-config core value.
- **Identifying WHO is signed in** — expands privacy surface for no core-value gain.
- **Modifying / blocking / proxying the webapp** — read-only observation is a hard trust boundary.
- **Multi-domain clustering** via CORS introspection / cross-tab sniffing / Related Website Sets — real but expensive; eTLD+1 handles the common case; deferred (Google-consult gaps a/c/d).
- **GraphQL body-aware network signal** (MAIN-world fetch/XHR hook) — added complexity/attack surface; backstopped by cookie+storage signals.
- **CHIPS / partitioned cookies** — documented known limitation for MVP.
- **Polling-based sensors** — violates the "recompute on events, not navigation" requirement.

---

## Traceability

Maps each v1 REQ-ID to the phase that delivers it. See `.planning/ROADMAP.md` for full phase details.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENG-01 | Phase 1 — Detection Core | Pending |
| ENG-02 | Phase 1 — Detection Core | Pending |
| ENG-03 | Phase 1 — Detection Core | Pending |
| ENG-04 | Phase 1 — Detection Core | Pending |
| ENG-05 | Phase 1 — Detection Core | Pending |
| SEN-01 | Phase 1 — Detection Core | Pending |
| SEN-02 | Phase 1 — Detection Core | Pending |
| SEN-03 | Phase 1 — Detection Core | Pending |
| SEN-04 | Phase 1 — Detection Core | Pending |
| SEN-05 | Phase 1 — Detection Core | Pending |
| IDN-01 | Phase 1 — Detection Core | Pending |
| IDN-02 | Phase 1 — Detection Core | Pending |
| PLT-01 | Phase 2 — State & Persistence | Pending |
| PLT-02 | Phase 3 — Chrome Glue | Pending |
| BDR-01 | Phase 3 — Chrome Glue | Pending |
| BDR-02 | Phase 3 — Chrome Glue | Pending |
| BDR-03 | Phase 3 — Chrome Glue | Pending |
| BDR-04 | Phase 3 — Chrome Glue | Pending |
| RCT-01 | Phase 4 — Wiring & E2E Flow | Pending |
| PLT-03 | Phase 4 — Wiring & E2E Flow | Pending |
| PRV-01 | Phase 4 — Wiring & E2E Flow | Pending |
| PRV-02 | Phase 4 — Wiring & E2E Flow | Pending |
| *(all above)* | Phase 5 — Validation & Hardening | Re-validated end-to-end, no new REQ-IDs |

**Coverage:** 22/22 v1 requirements mapped. No orphans, no duplicates.
