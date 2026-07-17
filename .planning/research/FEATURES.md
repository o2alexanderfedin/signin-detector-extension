# Feature Research

**Domain:** Chrome MV3 extension — zero-config sign-in detection + visible border overlay
**Researched:** 2026-07-17
**Confidence:** HIGH (design doc already specifies architecture; verified against Chrome docs/MDN for MV3 API behavior)

## Feature Landscape

### Table Stakes (Users Expect These)

These are the features required for the MVP to satisfy its stated core value: "detect signed-in vs not + draw border across a variety of webapps without relying on navigation." Missing any of these means the product doesn't do the one thing it claims to do.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Cookie sensor (chrome.cookies + onChanged) | Backbone signal; only an extension (not page JS) can read HttpOnly session cookies — this is the entire premise of the product | MEDIUM | Classify cookie **shape** (HttpOnly+Secure, name pattern like `session`/`sid`/`auth`/`token`, entropy/length, expiry horizon), never raw value. `cookies.onChanged` fires on set/remove — no polling needed. Requires `cookies` permission + host access. |
| Network sensor (webRequest onCompleted, status/headers) | Second-strongest signal; 200 vs 401/403 on identity-shaped endpoints is a near-binary tell; `Authorization: Bearer` header presence is a direct positive | MEDIUM | Verified: non-blocking `onCompleted` observation (statusCode, headers) still works fully in MV3 without `webRequestBlocking`. Must pattern-match URL paths (`/me`, `/session`, `/user`, `/account`, GraphQL POST bodies with `viewer`/`me` — body inspection is NOT available via webRequest in MV3, so GraphQL detection is path/method heuristic only, weakening this sub-case). 401/403 is a **strong negative**, not just absence of positive. |
| Storage sensor (localStorage/sessionStorage token heuristics) | Many SPA auth libraries (Auth0, Firebase, custom JWT flows) store tokens client-side, not in cookies; without this sensor those apps are invisible to cookie/network signals | LOW–MEDIUM | Content script runs in isolated JS world but shares the page's storage (same-origin) — direct `localStorage`/`sessionStorage` read, no extra permission beyond content-script injection. Heuristic: key name matches `auth`/`session`/`token`/`jwt`, or value is JWT-shaped (three base64url segments separated by `.`). Medium weight because many apps store non-auth data under similar-sounding keys (false-positive risk). |
| DOM sensor + MutationObserver | Weak but universal fallback signal for apps where cookie/network/storage all read ambiguous (e.g., session cookie present but no identity endpoint ever called) | MEDIUM | Look for logout/account/avatar affordances AND absence of a password/login form. Debounced MutationObserver required because SPAs re-render constantly — undebounced observation is a perf/battery risk. Low weight: DOM text/structure heuristics are the least reliable signal (i18n, custom markup, false "Sign in" ghost text, etc.). |
| ConfidenceEngine — weighted fusion over observed signals | Core logic: no single signal is trusted; this is what makes "zero-config, works across arbitrary webapps" true instead of aspirational | MEDIUM | Weighted mean formula `Σ(weightᵢ·valueᵢ)/Σ(weightᵢ observed)` with graceful degradation (signals that never fire, e.g. no identity endpoint on this app, are simply excluded from the denominator — not treated as zero). Strong negatives (401/403) must subtract, not just fail to add. This is the highest-risk-of-bugs component; needs the most unit test coverage. |
| Hysteresis / state machine (Unknown → SignedIn/SignedOut with thresholds) | Prevents border flicker as signals arrive asynchronously and independently; also correctly represents "cookie present but session expired" as Unknown rather than a false positive | LOW–MEDIUM | Simple 3-state machine with two thresholds (0.7 up, 0.3 down) and a hold band. Thresholds are provisional (explicitly flagged for later calibration in the design doc) but the *mechanism* is required for MVP — without hysteresis the border would flicker on every ambiguous signal update. |
| Event-driven recompute (no navigation dependency) | Explicit hard requirement: "cannot rely on navigation" because a webapp spans many domains/URLs and SPAs don't navigate on login | MEDIUM | Recompute triggers: `cookies.onChanged`, `webRequest` completion matching identity patterns, debounced `MutationObserver` callback, storage `change`/write detection. This is a cross-cutting requirement touching every sensor, not a standalone feature — verify each sensor is push-based, not poll-based. |
| Registrable-domain (eTLD+1) app identity | Requirement: treat a webapp as one logical app across `api.`/`cdn.`/`www.`/etc. subdomains, not per-URL or per-origin | MEDIUM | Chrome has **no built-in PSL API** (Firefox's `browser.tld.getPublicSuffix` doesn't exist in Chrome/MV3) — confirmed via MDN. Requires bundling a PSL-backed library (`tldts` recommended: dependency-free, ships PSL inline, no runtime fetch needed — good fit for MV3's no-remote-code policy). This is a real dependency, not a one-liner. |
| Border overlay (closed Shadow DOM, top frame only) | The entire observable output of the product; without it there is no product | LOW–MEDIUM | `position:fixed; inset:0; pointer-events:none; z-index:2147483647` inside a **closed** Shadow DOM (host page CSS can't style it, host page JS can't query into it). Must be re-asserted by the same debounced MutationObserver used for DOM sensing (SPA re-renders can wipe injected DOM). Injected only in the top frame — iframes are out of scope for the border itself (though cookies/DOM in iframes may still feed signals depending on host permission scope). |
| Cross-context signal transport (content script → service worker) | Storage and DOM sensors run in content-script scope; cookie/network sensors and the fusion engine run in service-worker scope; verdict must reach the content script to render | LOW–MEDIUM | `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` round trip, keyed by tab ID and WebAppKey (eTLD+1). Straightforward MV3 message-passing pattern but must be reconnection-safe (service worker can be evicted/restarted; content script must re-request current state on load, not only listen for pushes). |
| Local-only processing / no persistence of raw values | Explicit privacy constraint, not negotiable, and a stated trust cost the extension has to justify (`<all_urls>` host access) | LOW | Store only derived numbers (per-signal confidence, 0–1) and `{WebAppKey → verdict}` in memory; clear on tab close. No `chrome.storage` persistence of cookie/token values, no network calls out of the extension at all. This is more a constraint enforced across other features than a feature in itself, but must be explicitly tested (e.g., grep for accidental `chrome.storage.local.set` of raw cookie data). |

### Differentiators (Competitive Advantage / Accuracy & UX Polish)

Not required to satisfy the core requirement; improve accuracy, resilience, or trust, and are natural v1.x additions once the MVP fusion engine is validated against real apps.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| OAuth-IdP grace handling | During an OAuth redirect round-trip (app → IdP → app), signals briefly look contradictory (cookie clears on old domain, new domain not yet issued session) — a grace window avoids a flicker to SignedOut mid-flow | MEDIUM | Explicitly deferred in the design doc. Requires detecting redirect chains (`webRequest.onBeforeRedirect`) and suppressing hysteresis-state transitions for a short window during a recognized auth-redirect pattern. Real accuracy win for apps using Google/Microsoft/Okta SSO, but adds a temporal state machine on top of the existing one — meaningful complexity for a signal affecting a minority of transitions (login moment only, not steady-state). |
| Least-privilege / per-site permission mode (`activeTab`-style opt-in instead of `<all_urls>`) | Reduces the extension's biggest trust cost; lets users grant per-site rather than blanket access | MEDIUM–HIGH | Deferred. Requires either `optional_host_permissions` + a permission-request UX (which needs a popup — see anti-features) or `activeTab`, which is incompatible with background `cookies`/`webRequest` sensing on tabs the user hasn't actively clicked into. Real architectural tension with "zero-config, works everywhere automatically" — worth flagging for later design discussion, not a quick bolt-on. |
| Unknown-state border treatment (e.g., dashed/amber border instead of no border) | Gives the user positive feedback that detection is *running* but inconclusive, vs. silently doing nothing | LOW | Deferred per design doc. Cheap to add once the state machine exists — mostly a rendering branch. Good candidate for first post-MVP iteration since it reuses 100% of existing infrastructure. |
| Weight/threshold calibration (tuning 0.7/0.3 and per-signal weights against real-app telemetry or expanded manual test corpus) | The MVP thresholds/weights are estimates; real accuracy tuning needs a broader test corpus than the 3–4 apps in MVP manual testing | MEDIUM | Not buildable meaningfully until the MVP is exercised against more real apps — this is a data-driven follow-up, not a code feature per se. Track as a v1.x activity, not a v1.x code branch. |
| GraphQL body-aware network signal (via `declarativeNetRequest` response header rules or a lightweight fetch/XHR page-context hook) | webRequest in MV3 cannot read response bodies, so GraphQL `viewer`/`me` query detection is currently path/method heuristic only (weak); a body-aware signal would meaningfully strengthen the network sensor for GraphQL-heavy apps (GitHub, Shopify admin, many modern SPAs) | HIGH | Would likely require a page-context script (`MAIN` world content script) hooking `fetch`/`XHR` to inspect request/response bodies in-page, since `webRequest` genuinely cannot see bodies in MV3. Significant additional attack surface/complexity for a signal that's already backstopped by cookie + storage signals — good v2 candidate, not MVP. |
| Multi-tab / cross-tab verdict sharing for the same WebAppKey | If a user has the same webapp open in two tabs, computing the verdict independently per tab is redundant and can transiently disagree (one tab's border shows green a beat before the other) | LOW–MEDIUM | Natural optimization once WebAppKey-based identity exists — cache verdict by WebAppKey in the service worker and broadcast to all tabs sharing that key. Not required for correctness in MVP (each tab converges to the same verdict independently, just not simultaneously), so it's a UX polish item, not table stakes. |
| Firefox port | PROJECT.md states "Firefox-compatible" as an eventual goal | MEDIUM | MV3 Chrome architecture (service worker, `chrome.*` namespace) needs a `browser.*`/webextension-polyfill shim and MV3-in-Firefox has some behavioral differences (event page vs. persistent background, some `webRequest` blocking differences). Treat as parallel/later track, not required for the Chrome MVP to ship. |

### Anti-Features (Explicitly Out of Scope for MVP — Confirmed by PROJECT.md)

These appear in the design doc's "Deferred" list or PROJECT.md's "Out of Scope" and are called out here so roadmap phases don't accidentally reintroduce them.

| Feature | Why Requested | Why Problematic (for MVP) | Alternative |
|---------|---------------|--------------------------|-------------|
| Popup UI | Natural expectation for a browser extension — most extensions have a toolbar popup showing status/settings | Adds a whole surface (UI framework, state sync, testing) for zero core-value gain; the border itself IS the UI, by design | Rely on the border as the sole UI signal for MVP; add popup later if users want a details/debug view |
| Per-app rule packs / filter lists | Would improve accuracy for well-known apps (Gmail, GitHub, etc. could have hand-tuned selectors) | Directly contradicts the stated core value ("zero per-app configuration... work for a variety of webapps"); becomes an unbounded maintenance burden (every app changes its DOM/API over time) | Zero-config heuristic fusion only; if accuracy is insufficient for specific apps, that's a signal to improve the *generic* heuristics, not to special-case |
| WHO is signed in (account identity, avatar/name extraction) | Seems like a small addition once you're already reading DOM avatar/account elements for the DOM sensor | Expands privacy surface significantly (extracting/handling PII) for a feature not needed by the stated goal (border only signals signed-in/not, not identity); also re-opens the "never persist/transmit" constraint to a much riskier data class | DOM sensor only checks for *presence* of account-shaped UI, never extracts or stores its content |
| Modifying, blocking, or proxying the webapp | Once you have `webRequest`/`cookies` access, blocking/redirecting is a small permission delta away and sometimes looks useful (e.g., "log me out" button) | Read-only observation is a hard privacy/trust boundary the whole design rests on; adding write/block capability changes the extension's risk profile entirely and is unrelated to detection | Strictly observational sensors; no `webRequestBlocking`, no cookie writes, no DOM mutation of the host page beyond the border overlay itself |
| Least-privilege / OAuth-grace / Unknown-border (deferred items) | All three are genuinely good ideas that a thorough build would include | Each adds real complexity (permission UX, temporal state handling, new render branch) without being required to prove the core hypothesis; MVP is time-boxed | Ship MVP with `<all_urls>`, plain hysteresis, and no-border-when-Unknown; revisit in v1.x once the core fusion engine is validated against real usage |
| Polling-based sensors (setInterval checks of cookies/DOM/storage) | Simple to implement, tempting shortcut vs. wiring up `onChanged`/`MutationObserver`/message events | Directly violates "recompute on events, not navigation/polling" intent, wastes battery/CPU, and introduces detection latency | Push-based sensors only: `cookies.onChanged`, `webRequest.onCompleted`, debounced `MutationObserver`, `storage` event listener |

## Feature Dependencies

```
Cookie Sensor ─┐
Network Sensor ─┼──requires──> ConfidenceEngine (fusion) ──requires──> Hysteresis State Machine ──requires──> Border Overlay (render verdict)
Storage Sensor ─┤
DOM Sensor ─────┘

Registrable-Domain (eTLD+1) Identity ──required by──> ConfidenceEngine (keys verdict per WebAppKey, not per URL)
Registrable-Domain (eTLD+1) Identity ──required by──> Cross-Tab Verdict Sharing (differentiator)

Event-Driven Recompute (cookies.onChanged / webRequest / MutationObserver / storage event) ──required by──> every Sensor
   (this is a cross-cutting constraint on each sensor's implementation, not a separate build step)

Cross-Context Message Transport (content script <-> service worker) ──required by──> ConfidenceEngine
   (Storage Sensor and DOM Sensor live in content-script scope; Cookie/Network Sensors and fusion live in service-worker scope)

MutationObserver (debounced) ──enhances──> Border Overlay (re-asserts border after SPA re-render)
MutationObserver (debounced) ──enhances──> DOM Sensor (detects re-renders that change login/logout affordances)

OAuth-IdP Grace Handling ──requires──> Hysteresis State Machine (extends it with a temporal suppression window)
Least-Privilege Permission Mode ──conflicts──> Zero-Config "works everywhere automatically" (background sensing needs standing host access; per-site opt-in needs either a popup or activeTab, which breaks passive background detection)
GraphQL Body-Aware Network Signal ──requires──> MAIN-world content script (new capability, not present in MVP architecture at all)
```

### Dependency Notes

- **All four sensors require the ConfidenceEngine, which requires the Hysteresis State Machine, which requires the Border Overlay:** this is a strict linear pipeline — none of the later stages can be meaningfully tested end-to-end without the earlier stages existing, but each stage CAN be unit-tested in isolation (sensors with mocked events, engine with synthetic signal vectors, state machine with synthetic confidence sequences). This suggests a roadmap where sensors + engine + state machine are built and unit-tested in parallel workstreams, then integrated with the border overlay as a final wiring phase.
- **Registrable-domain identity is a prerequisite for the engine's data model, not an add-on:** the ConfidenceEngine's state is keyed by WebAppKey (eTLD+1), so the `tldts`-based identity resolution needs to exist before the engine's storage/lookup logic is written, even though it's conceptually a small, separable utility.
- **Event-driven recompute is not a standalone feature — it's an implementation constraint on every sensor.** Each sensor's design must be reviewed against "does this fire on events or does it poll/depend on navigation?" This should be a checklist item at sensor-review time, not a separate roadmap phase.
- **Cross-context transport is required because of MV3's process model, not because of product requirements:** storage/DOM sensing must happen in page-scoped content-script context; cookie/network sensing must happen in the privileged service-worker context. This split is forced by the Chrome extension platform, and the message-passing layer between them is genuinely load-bearing infrastructure — treat it as its own small deliverable with its own tests (especially service-worker-eviction/reconnect behavior), not an afterthought of "just send a message."
- **Least-privilege mode conflicts with the zero-config value proposition as currently scoped:** flagging this explicitly because it's likely to surface again post-MVP. Background, always-on detection across "arbitrary webapps... zero per-app config" fundamentally wants broad standing permissions; a per-site consent model wants the opposite (narrow, user-initiated grants). Reconciling them (e.g., "detect broadly, only render border on sites the user has granted") is a real design problem for later, not a checkbox.

## MVP Definition

### Launch With (v1)

Minimum viable product — every item in the Table Stakes table above. Restated as a build checklist:

- [ ] Cookie sensor (`cookies` API + `onChanged`, shape classification only) — backbone signal, nothing else works without it
- [ ] Network sensor (`webRequest.onCompleted`, status/header heuristics, path-based identity-endpoint matching) — second-strongest signal
- [ ] Storage sensor (content-script `localStorage`/`sessionStorage` heuristics) — covers client-side-token SPAs cookie sensor misses
- [ ] DOM sensor + debounced `MutationObserver` — weak fallback signal, universal applicability
- [ ] ConfidenceEngine (weighted fusion, graceful degradation over observed-only signals, strong-negative subtraction) — the actual "intelligence" of the product
- [ ] Hysteresis state machine (Unknown/SignedIn/SignedOut, 0.7/0.3 thresholds, hold band) — prevents flicker, correctly models ambiguous states
- [ ] Registrable-domain (eTLD+1) identity via `tldts` — required for "one app across many domains" requirement
- [ ] Event-driven recompute wiring across all sensors — required for "no navigation dependency"
- [ ] Cross-context message transport (content script ↔ service worker), reconnect-safe — required by MV3's architecture
- [ ] Border overlay (closed Shadow DOM, top frame, re-asserted on mutation) — the entire visible output
- [ ] Local-only processing enforcement (no raw-value persistence/transmission) — non-negotiable privacy constraint

### Add After Validation (v1.x)

- [ ] Unknown-state border treatment — trigger: MVP manual testing shows users confused by "no border" during ambiguous states
- [ ] Cross-tab verdict sharing by WebAppKey — trigger: multi-tab usage becomes common in dogfooding and independent-per-tab convergence lag is noticeable
- [ ] Weight/threshold calibration pass — trigger: MVP tested against >3-4 apps reveals systematic false positive/negative patterns
- [ ] OAuth-IdP grace handling — trigger: dogfooding against SSO-heavy apps (Google Workspace, Okta-backed apps) shows visible flicker during login redirects

### Future Consideration (v2+)

- [ ] Least-privilege / per-site permission mode — defer: architecturally in tension with zero-config background detection; needs its own design pass, likely needs a popup as a prerequisite
- [ ] GraphQL body-aware network signal (MAIN-world fetch/XHR hook) — defer: meaningful complexity/attack-surface increase for a signal already backstopped by cookie+storage; only worth it if GraphQL-heavy apps prove to be a systematic blind spot
- [ ] Firefox port — defer: parallel track once Chrome MVP validates the core detection approach; `browser.*` polyfill and MV3-in-Firefox event-page differences are non-trivial but well-trodden
- [ ] Popup UI (status/debug view) — defer: no core-value contribution; only justified if users want visibility into per-signal breakdown or manual override

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Cookie sensor | HIGH | MEDIUM | P1 |
| Network sensor | HIGH | MEDIUM | P1 |
| Storage sensor | MEDIUM | LOW-MEDIUM | P1 |
| DOM sensor + MutationObserver | MEDIUM | MEDIUM | P1 |
| ConfidenceEngine (fusion) | HIGH | MEDIUM | P1 |
| Hysteresis state machine | HIGH | LOW-MEDIUM | P1 |
| Registrable-domain identity (tldts) | HIGH | MEDIUM | P1 |
| Event-driven recompute wiring | HIGH | MEDIUM | P1 |
| Cross-context message transport | HIGH | LOW-MEDIUM | P1 |
| Border overlay (closed Shadow DOM) | HIGH | LOW-MEDIUM | P1 |
| Local-only processing enforcement | HIGH | LOW | P1 |
| Unknown-state border treatment | MEDIUM | LOW | P2 |
| Cross-tab verdict sharing | LOW | LOW-MEDIUM | P2 |
| Weight/threshold calibration | MEDIUM | MEDIUM | P2 |
| OAuth-IdP grace handling | MEDIUM | MEDIUM | P2 |
| Least-privilege permission mode | MEDIUM | HIGH | P3 |
| GraphQL body-aware network signal | LOW-MEDIUM | HIGH | P3 |
| Firefox port | LOW (MVP is Chrome-scoped) | MEDIUM | P3 |
| Popup UI | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch (Table Stakes)
- P2: Should have, add when possible (Differentiators, high-value)
- P3: Nice to have, future consideration (Differentiators, lower urgency, or explicitly deferred in design doc)

## Signal Reliability Summary

Consolidated view of the four signal classes' strength and failure modes (referenced across the tables above; repeated here for quick roadmap/risk reference).

| Signal | Reliability | Strong Case | Failure Modes |
|--------|-------------|--------------|----------------|
| Cookie (backbone) | HIGH | HttpOnly+Secure, long-expiry, high-entropy session cookie present | False positive: "remember-me" cookie survives after server-side session expiry (mitigated by hysteresis + network 401 pulling confidence back down, not eliminated by cookie sensor alone). False negative: apps using pure token-in-header auth with no session cookie at all (relies on storage/network signals instead). |
| Network | HIGH | Identity endpoint (`/me`, `/session`) returns 200; `Authorization: Bearer` header present. 401/403 = strong negative | False negative: app never calls an identity-shaped endpoint after initial load (signal simply never observed — engine must treat "not observed" as excluded, not as negative, per design). Blind spot: cannot inspect response bodies in MV3 `webRequest`, so GraphQL single-endpoint APIs (`POST /graphql` for everything) are hard to distinguish by URL pattern alone — weakens this signal specifically for GraphQL-heavy apps. |
| Storage | MEDIUM | JWT-shaped or `auth`/`session`/`token`-named key in local/sessionStorage | False positive: non-auth data stored under similarly-named keys (e.g., `session_id` for analytics, not auth). False negative: apps that only use cookies (no client-readable storage at all) — signal never fires, correctly excluded by graceful degradation. |
| DOM/UI | LOW | Logout/account/avatar element present AND no password-login form visible | Highest false-positive/false-negative surface of the four: i18n text variance, custom component libraries with no semantic markup, marketing pages showing a "Sign in" link inside an otherwise-authenticated app shell, SPA loading states where neither login nor account UI is rendered yet. Debounce is required or MutationObserver fires on every micro re-render (perf + noisy-signal risk). |

## Sources

- Project design doc: `docs/superpowers/specs/2026-07-17-signin-detector-extension-design.md` (approved MVP design, primary source for architecture/scope)
- Project requirements: `.planning/PROJECT.md` (Active requirements, Out of Scope, constraints)
- [chrome.webRequest API reference](https://developer.chrome.com/docs/extensions/reference/api/webRequest) — confirms non-blocking `onCompleted` status/header observation works fully in MV3
- [Replace blocking web request listeners — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests) — confirms MV3 blocking-vs-observation distinction
- [MDN: publicSuffix WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/publicSuffix) — confirms this API is Firefox-only, not available in Chrome MV3, justifying the `tldts` dependency
- [MDN: Registrable domain glossary](https://developer.mozilla.org/en-US/docs/Glossary/Registrable_domain)
- [tldts — GitHub](https://github.com/remusao/tldts) / [tldts — npm](https://www.npmjs.com/package/tldts) — recommended PSL-backed library: dependency-free, ships PSL inline, no runtime fetch (fits MV3 no-remote-code policy)

---
*Feature research for: Chrome MV3 sign-in detector extension*
*Researched: 2026-07-17*
