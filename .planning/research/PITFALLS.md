# Pitfalls Research

**Domain:** Chrome MV3 extension — zero-config sign-in state detection via signal fusion (cookies + network + storage + DOM), border overlay rendering
**Researched:** 2026-07-17
**Confidence:** MEDIUM-HIGH (MV3 platform behavior verified against current Chrome docs/issue tracker; detection-heuristic pitfalls are MEDIUM — inferred from the design's own signal model plus documented browser platform constraints, not from an existing shipped competitor)

## Critical Pitfalls

### Pitfall 1: "Remember me" cookie survives a dead server session (false positive)

**What goes wrong:**
A long-lived, high-entropy cookie (the exact shape the cookie sensor is designed to trust) remains present after the server has expired/revoked the session. Cookie sensor alone would report "signed in" while the user is actually logged out.

**Why it happens:**
Cookie *shape* (HttpOnly+Secure, long expiry, high entropy) is a proxy for "this looks like a session token," not proof the server still honors it. Persistent "remember me" tokens are explicitly designed to outlive short sessions, which is exactly the pattern the backbone signal is tuned to reward.

**How to avoid:**
This is precisely why the design treats cookie as backbone-but-not-sole-signal and requires the network signal (401/403 on the identity endpoint) as a **strong negative** that can override cookie presence. The hysteresis band (0.3–0.7) is what prevents a single stale-cookie snapshot from flipping to SignedIn — confirm during implementation that a cookie-present + network-401 combination actually lands in "hold" or negative territory, not just "average toward middle." Also ensure the network sensor *fires* an identity-endpoint check reasonably soon after a cookie appears/tab becomes active — if the engine only reacts passively to whatever requests the page happens to make, an app that doesn't hit `/me` on load will leave the cookie signal unopposed indefinitely.

**Warning signs:**
- Manual test: expire/revoke a session server-side (or use an app with short server sessions + long cookie `Max-Age`) and confirm the border does NOT stay green.
- Verdict stays SignedIn for a tab with no observed network activity for a long period.

**Phase to address:** Confidence Engine (fusion + hysteresis) phase, verified in Integration/manual testing phase against a real short-session app.

---

### Pitfall 2: Logged-out landing page with "Login to X" / "Sign in" upsell copy confuses the DOM sensor

**What goes wrong:**
Marketing/landing pages for signed-out users routinely contain the strings "Sign out", "Account", "Profile", "Dashboard" (in nav links, footers, testimonials, or a preview screenshot's alt text) even though the user has no session. A naive keyword-matching DOM sensor scores this as positive evidence.

**Why it happens:**
DOM/UI is explicitly the lowest-weight, least-reliable signal in the design precisely because bag-of-words heuristics on arbitrary markup are trivially confused by unrelated occurrences of the same words. "Login to view your dashboard" contains "dashboard"; a "Sign out other devices" security-tips blog post contains "Sign out."

**How to avoid:**
Keep DOM sensor weight low (already specified) and require it to combine "logout/account/avatar surface present" **and** "no password/login form visible" as designed — a page with both a "Sign out" string and a visible email+password form should not score DOM positive. Prefer structural signals (an actual `<button>`/`<a>` matching logout patterns near account-menu affordances) over raw text search across the whole document. Never let DOM sensor alone cross the SignedIn threshold — verify in the fusion math that DOM's weight cannot single-handedly move confidence past 0.7 even when cookie/network are both "unknown" (unobserved).

**Warning signs:**
- Border appears green on a logged-out marketing/landing page.
- DOM sensor score is nonzero on pages with zero cookies present.

**Phase to address:** DOM Sensor implementation phase; regression-tested in Integration/manual testing phase with at least one marketing/landing page per test app (not just the signed-in and signed-out app screens).

---

### Pitfall 3: Cookie-consent / analytics cookies mistaken for session cookies

**What goes wrong:**
Cookies like `OptanonConsent`, `CookieConsent`, `_ga`, `_gid`, `_fbp`, `ajs_anonymous_id` are long-lived and can be high-entropy (GA client IDs, consent-tool UUIDs), matching the cookie sensor's "long-expiry, high-entropy" heuristic even though they carry zero authentication meaning.

**Why it happens:**
Entropy and expiry alone don't distinguish "session identifier" from "anonymous analytics identifier." Both look like random-looking persistent strings from the outside.

**How to avoid:**
Layer in the properties analytics cookies typically lack: `HttpOnly` (analytics cookies are almost always JS-set, so NOT HttpOnly, since GA/Segment/etc. need `document.cookie` access) and `Secure`+session-cookie-name conventions. Weighting HttpOnly heavily (the design already calls out HttpOnly+Secure as the qualifying shape) filters out the vast majority of consent/analytics cookies for free, since JS-based trackers cannot set HttpOnly. Additionally maintain a small denylist of well-known non-auth cookie name patterns (`_ga*`, `_fbp`, `_gcl*`, `*consent*`, `*optanon*`) as a cheap negative filter — this is a pragmatic exception to "zero per-app config" because these are cross-app *tracking infrastructure* names, not per-app rules.

**Warning signs:**
- Cookie sensor fires positive on a tab that has never authenticated, only accepted a cookie banner.
- Spot-check `chrome.cookies.getAll()` output on a fresh incognito-like session against a news site with a cookie banner — verify none of those cookies qualify as "session-shaped."

**Phase to address:** Cookie Sensor implementation phase.

---

### Pitfall 4: Third-party iframe sessions bleed into the top-frame verdict

**What goes wrong:**
A page embeds a third-party chat widget, payment iframe, ad, or SSO widget that itself has an authenticated session (its own cookies, its own "Sign out" DOM). If sensors run in `all_frames: true` mode or the cookie sensor queries cookies without a specific host filter, that unrelated iframe's session gets fused into the verdict for the host page's identity.

**Why it happens:**
`chrome.cookies.getAll()` can be called with a `domain` filter, but it's easy to under-scope this during implementation (e.g., filtering only by top-level eTLD+1 while a subordinate iframe cookie for an entirely different registrable domain gets attributed to the wrong WebAppKey via a shared tab-scoped message channel). Content-script DOM/storage sensors are the more direct risk: if `all_frames` isn't explicitly `false`, every iframe on the page — including cross-origin third-party ones the extension has host permission for — runs its own DOM/storage sensor and reports "signed in" up to the tab's engine.

**How to avoid:**
Design already scopes the content script to the top frame only ("Content Script (top frame)" in the architecture) — enforce this literally in the manifest/registration (`all_frames: false`, `match_about_blank: false`) and, critically, scope the cookie sensor's `chrome.cookies.getAll({domain})` calls strictly to the tab's own registrable domain (and its subdomains), never to the full set of cookies visible via `<all_urls>` host permission. Do not fuse iframe-origin signals into the top-frame's verdict for MVP — this is a deliberate simplification, document it as a known limitation (embedded-app auth state is invisible by design), not a bug to silently work around.

**Warning signs:**
- Border goes green on a page you've never logged into, when it embeds a widget you ARE logged into elsewhere (e.g., an embedded Intercom/Zendesk chat where you're a logged-in support agent).
- Cookie count returned for a WebAppKey includes domains unrelated to the tab's top URL.

**Phase to address:** Cookie Sensor + Content Script scoping phase (architecture-enforcement item), explicitly called out in the design's app-identity section.

---

### Pitfall 5: Service worker suspension silently resets in-memory verdict/hysteresis state

**What goes wrong:**
MV3 service workers are terminated after ~30 seconds of inactivity (any period with no pending events/API calls) even under Chrome 110+'s improved "event resets timer" model; global JS variables — including the ConfidenceEngine's per-tab confidence score and hysteresis state — are wiped on termination. If the engine's state lives only in a module-level `Map`, the next event after a suspend/wake sees a blank slate: hysteresis "hold" is lost, and a single new signal (e.g., one DOM mutation) can now swing straight to SignedIn/SignedOut without the dampening the design relies on to prevent flicker.

**Why it happens:**
This is the single most common MV3 migration bug: developers used to MV2's long-lived background page assume the service worker behaves the same way. It does not — Chrome explicitly documents that "any global variables you set will be lost if the service worker shuts down" and instructs developers to persist to storage instead.

**How to avoid:**
Persist per-tab `{WebAppKey: {confidence, state, lastSignals}}` to `chrome.storage.session` (in-memory-only storage API, survives SW restarts within the browser session but is cleared on browser close — matches the design's "no persistence of raw session material" requirement, since only the fused signal shape needs to persist, never raw cookie values) rather than a plain object/Map. Rehydrate on every SW startup (`chrome.runtime.onStartup` / top-of-script) before processing the first event. Because `chrome.storage.session` access itself resets the idle timer, this also keeps the SW alive slightly longer during active signal bursts.

**Warning signs:**
- Border flickers/flips inconsistently after the tab has been idle for 30+ seconds (a very common real usage pattern — user reads a page, comes back).
- Confidence resets to "Unknown" spontaneously with DevTools closed (DevTools open suppresses SW suspension, so this bug is invisible unless you test with DevTools closed).
- Verdict is correct in short manual tests but wrong in soak/idle tests.

**Phase to address:** Service Worker / Confidence Engine foundation phase. Explicitly test with the service worker inspector closed (open DevTools masks this bug) and with `chrome://serviceworker-internals` forced-stop.

---

### Pitfall 6: webRequest response-body assumption breaks the network sensor's design

**What goes wrong:**
A team member (or a future contributor) reaches for response-body inspection (e.g., checking a `/api/me` JSON body for `{"authenticated": false}` even on a 200) because some apps return 200 with an error payload instead of a proper 401/403. `chrome.webRequest` in MV3 cannot read response bodies at all (this was already effectively impractical in MV2 for encrypted/streamed bodies and is explicitly not part of the MV3 observational surface) — only headers and status codes are available via `onHeadersReceived`/`onCompleted`.

**Why it happens:**
Some real APIs (especially GraphQL endpoints, which almost always return HTTP 200 regardless of an internal "not authenticated" error) don't encode auth failure in the status code at all. A design that treats "200 on identity endpoint = signed in" will false-positive on these apps.

**How to avoid:**
Document explicitly (already partially done in PROJECT.md: "network detection is status-code/header based, not payload parsing") that GraphQL-style single-endpoint APIs with always-200 responses are a known blind spot for the network signal — the engine should degrade gracefully (network signal simply contributes nothing / stays "unobserved" for such apps) rather than a false "200 = signed in." Do not attempt response-body sniffing as a fix; it is not available via webRequest in MV3 and would require far riskier `fetch`/DOM-based interception. Rely on cookie + DOM signals to carry more weight for GraphQL-heavy apps.

**Warning signs:**
- False positive on apps that always return 200 for API calls (common with GraphQL, tRPC).
- A code review PR attempts to add response-body parsing to the network sensor — flag immediately, it's not supported in MV3 for general extensions.

**Phase to address:** Network Sensor implementation phase — write this constraint into the sensor's own module doc/tests, not just the design doc, so it survives contributor turnover.

---

### Pitfall 7: `<all_urls>` host permission triggers install friction and can be silently revoked per-site

**What goes wrong:**
Requesting `<all_urls>` (or equivalent broad `host_permissions`) shows Chrome's most severe install warning ("Read and change all your data on all websites"), which suppresses install/adoption. Separately, users can revoke host access for individual sites at any time via `chrome://extensions` → Site access, without uninstalling — the extension keeps running but silently stops receiving cookie/webRequest/content-script events for that origin, with no error surfaced to the extension unless it explicitly checks.

**Why it happens:**
MV3 made per-site host-access revocation a first-class, easily-discoverable user control (right-click the extension icon → "This can read and change site data" → per-site toggle). An extension that assumes host permission is a one-time grant will silently produce false "SignedOut" (Unknown, really) verdicts on sites the user revoked access to, which is indistinguishable from a real signed-out state without an explicit permission check.

**How to avoid:**
For MVP, accept the trust cost as already stated in PROJECT.md/design doc (least-privilege per-site mode explicitly deferred) — but still call `chrome.permissions.contains()` (or check for a thrown/silent failure) before trusting an absence of signals as "SignedOut" rather than "Unknown/no permission." Consider surfacing a distinct visual state (or at minimum a console warning in dev builds) when host permission is missing for the active tab's origin, so "no border because logged out" is never confused with "no border because we can't see this site." At minimum, this must be flagged as a known MVP limitation in user-facing docs/store listing.

**Warning signs:**
- Border never appears on any site — first check is always "did the user revoke host access," not "is the fusion logic broken."
- No signals of any kind (cookie, network, DOM) observed for a tab despite the app clearly having a session.

**Phase to address:** Permissions/manifest setup phase (early), with the "distinguish no-permission from signed-out" check ideally in the Confidence Engine phase.

---

### Pitfall 8: OAuth/IdP redirect resets app identity mid-flow, causing border flicker or wrong-app attribution

**What goes wrong:**
When a webapp redirects to `accounts.google.com`, `login.microsoftonline.com`, `github.com/login/oauth/authorize`, etc., the tab's top-frame registrable domain *changes* to the IdP's domain for the duration of the flow. The WebAppKey (keyed by eTLD+1) the engine has been tracking suddenly doesn't match the active tab, so: (a) the original app's border may disappear (correctly, since that tab is no longer showing the app), but (b) if the engine naively creates state for the IdP domain, DOM/cookie signals momentarily observed on `accounts.google.com` (which has ITS OWN "Sign out" UI and session cookies, since the user is very likely signed into their Google account there) could cause a **transient positive verdict for the IdP domain itself**, which then vanishes again when the redirect completes back to the original app. Result: visible flicker during every OAuth login flow.

**Why it happens:**
The design's own doc explicitly flags this ("OAuth-IdP grace rule" is deferred post-MVP; "MVP tolerates a brief re-evaluation during OAuth round-trips") — this is a known, accepted gap, not an oversight. It's listed here because "tolerates" needs a concrete verified behavior: does the border merely disappear-then-reappear (acceptable), or does it briefly show a wrong/misleading green border on the IdP's own domain (confusing — implies you're "signed in" to the IdP, not the app you started from)?

**How to avoid:**
For MVP, at minimum ensure the engine treats each tab-visit to a *new* eTLD+1 as starting from Unknown state (not carrying over the previous app's hysteresis/confidence), so there's no risk of the previous app's SignedIn state incorrectly painting the IdP's page green. Verify hysteresis alone doesn't accidentally suppress a legitimate transition back to the original app once redirect completes (i.e., the "hold" logic must be per-WebAppKey, not per-tab-across-key-changes). Document the accepted flicker behavior and test it against at least one real "Sign in with Google/GitHub/Microsoft" flow so the deferred decision is validated against reality, not just assumed.

**Warning signs:**
- Border flashes on/off rapidly during any "Sign in with X" flow.
- Border appears (green) while the address bar shows an IdP domain the user has no reason to think of as "the app."

**Phase to address:** App Identity (eTLD+1 keying) phase for the state-reset-on-key-change fix; explicit manual test in Integration/manual testing phase (this is exactly the kind of thing "3-4 real apps" manual testing should include — pick at least one app with third-party OAuth login).

---

### Pitfall 9: Apps split across genuinely separate registrable domains defeat the eTLD+1 identity model

**What goes wrong:**
The design's eTLD+1 collapsing (`api.` / `cdn.` / `www.` → one app) only handles the *subdomain* case. Many real apps are NOT subdomain-unified: `mail.google.com` and `accounts.google.com` are both `google.com` (fine, collapses correctly) — but plenty of products span truly distinct registrable domains: a marketing site on `example.com` backed by an app on a wholly different domain (`app.example-platform.io`), or products that use a CDN/API on a completely separate brand domain for legal/infra reasons. These are two different eTLD+1 values and the extension will treat them as two unrelated, independently-tracked apps — which is arguably correct per-tab, but breaks the "treat a webapp as one logical app" requirement if a user expects one continuous border experience while clicking between the marketing site and the actual app.

**Why it happens:**
Public Suffix List / eTLD+1 is a *syntactic* domain-ownership boundary, not a *product* boundary. There is no generic, zero-config way to know that `stripe.com` and `checkout.stripe.com` are related product surfaces vs. that `okta.com` and `some-customer.okta.com` are NOT the same tenant, or that a company's marketing site and product are unrelated domains by design.

**How to avoid:**
Accept this as a stated, documented limitation of the zero-config approach (do not attempt to solve with per-app rule packs — that's explicitly out of scope). Make sure the mental model communicated to users/stakeholders is "one border verdict per registrable domain visited," not "one border per company/product," so expectations match what eTLD+1 keying can actually deliver. This is a design-level tradeoff to surface early, not a bug to fix in code.

**Warning signs:**
- Stakeholder/user expectation mismatch during demo: "why did the border disappear when I clicked from the app to the docs site" (different eTLD+1, correct behavior, surprising UX).

**Phase to address:** App Identity phase — document as an explicit non-goal/known-limitation in that phase's spec, not deferred silently.

---

### Pitfall 10: SPA re-keying by full URL/path causes verdict thrashing

**What goes wrong:**
If the WebAppKey or any part of state gets accidentally derived from `location.href` or `location.pathname` (rather than strictly the tab's top-frame eTLD+1) anywhere in the implementation — e.g., a naive first pass that uses the full URL as a map key for convenience — every SPA client-side route change (`/dashboard` → `/settings`) creates what looks like a brand-new WebAppKey with no prior state, resetting confidence to Unknown and causing the border to drop and slowly re-earn its way back on every in-app navigation.

**Why it happens:**
It's a natural, easy mistake: `Map<url, state>` is simpler to write than `Map<eTLD+1, state>` plus an aggregation step, and it "looks like it works" in early manual testing if the tester doesn't specifically navigate within the SPA before checking persistence.

**How to avoid:**
Enforce the WebAppKey type as strictly `registrableDomain` (never full URL) at the type level (TypeScript strict mode should make this hard to get wrong if the key type is a branded/nominal type rather than a plain string alias of URL). Add an explicit test: simulate two different in-app route changes within the same eTLD+1 and assert state/confidence is preserved, not reset.

**Warning signs:**
- Border flickers off then back on every time the user clicks a nav link inside a signed-in SPA.
- Verdict "resets to Unknown" correlates with URL path changes rather than actual sign-out events.

**Phase to address:** App Identity / Confidence Engine phase; covered by the design's own "Integration: mock SPA" test category — make sure that test specifically includes a route change, not just a cookie set.

---

### Pitfall 11: Border overlay defeated by page stacking contexts, the CSS Top Layer, or Trusted Types/CSP

**What goes wrong:**
`z-index: 2147483647` inside a fixed-position element is the conventional "max it out" trick, but it only wins within its own stacking context. Native browser Top Layer content — `<dialog>` elements, the Popover API, `::backdrop`, and fullscreen elements — renders in a browser-level top layer that sits above *any* regular DOM z-index, including 2147483647. A page's own modal/paywall/cookie-banner implemented via `<dialog>` or Popover, or (most commonly) any page that calls `element.requestFullscreen()` (video players, presentation apps, image galleries), will render *above* the border overlay, or the fullscreened element's isolated top-layer subtree hides the extension's overlay entirely since it lives outside that subtree. Separately, if the target page ships a strict Content-Security-Policy with Trusted Types enabled, content-script DOM/style injection (creating the shadow host, setting inline styles) can throw if the injection path uses `innerHTML`/`style.cssText` assignment patterns that Trusted Types blocks.

**Why it happens:**
Extensions don't get elevated top-layer access by default; `2147483647` is a DOM stacking-context maximum, not a top-layer guarantee. CSP/Trusted Types are page-controlled and increasingly common on security-conscious apps (banks, enterprise SaaS) — exactly the kind of apps where a sign-in-state indicator matters most.

**How to avoid:**
Build the border overlay using the closed Shadow DOM approach already specified (isolates from page CSS reading/breaking it), but additionally: (1) test against at least one app that uses `requestFullscreen()` and explicitly decide/document the accepted behavior (border disappears during fullscreen — likely acceptable, since fullscreen apps intentionally hide all chrome); (2) avoid `innerHTML`/inline `style` string injection in the content script — construct DOM nodes via `document.createElement` + `element.style.property = value` (CSSOM property assignment) or `adoptedStyleSheets`, which are compatible with Trusted Types by default without requiring a policy; (3) do not rely on `<dialog>`/Popover clashes being solved — document as an accepted edge case rather than chasing perfect z-index supremacy.

**Warning signs:**
- Border invisible while the page shows a native `<dialog>` or is in fullscreen.
- Content script throws `TypeError: This document requires 'TrustedHTML' assignment` in the console on CSP-strict sites (banks, some enterprise tools).

**Phase to address:** Border Overlay rendering phase; explicit manual test against one fullscreen-capable app and one CSP/Trusted-Types-strict app (a bank or enterprise SaaS) in Integration/manual testing phase.

---

### Pitfall 12: SPA route re-render destroys the border's DOM node, and naive self-healing causes performance/loop issues

**What goes wrong:**
Many SPA frameworks (React especially, on full route-level component swaps) replace large subtrees of `document.body`, and some apps' root-level re-renders can remove and recreate `document.documentElement`'s children wholesale. If the border's shadow-host element was appended as a sibling inside a container the app fully re-renders, the app can unintentionally delete it. The design correctly anticipates this ("re-asserted by the MutationObserver, so it survives SPA re-renders") — but a MutationObserver watching the entire `document.body` subtree, that on every mutation event does a full "check if my node exists, if not re-append," can become a performance problem on apps with frequent legitimate DOM churn (chat apps, live dashboards, virtualized lists), since every mutation triggers a query + possible re-append.

**Why it happens:**
Debouncing/thresholds get added for the DOM *sensor's* mutation observer (explicitly mentioned: "debounced MutationObserver") but the border's *self-healing* re-assertion observer is a separate concern and needs its own cheap, targeted check — it's easy to conflate the two and either (a) skip debouncing on the self-healing observer because "it's just a presence check," which is fine functionally but can add up on very chatty pages, or (b) accidentally attach the border directly under a node the framework owns and re-renders wholesale, rather than appending it directly to `document.documentElement` (outside any framework-managed root), which minimizes collision risk in the first place.

**How to avoid:**
Append the border's shadow host as a direct child of `document.documentElement` (or `document.body` at the very end, sibling to the app's root `<div id="root">`/`<div id="app">`), never inside a framework-managed root node — this alone avoids the vast majority of "app wiped our node" cases, since frameworks typically only own their own mount point's subtree. For the self-healing check itself, use a cheap presence check (`!shadowHostRef.isConnected` or `document.contains(shadowHostRef)`) gated behind the same debounce/threshold as the DOM sensor rather than a separate always-on observer, or better, a lightweight dedicated MutationObserver scoped only to `documentElement`'s direct childList (not subtree: true) so it isn't woken by every unrelated deep DOM change on the page.

**Warning signs:**
- Border flickers rapidly (appears/disappears every few hundred ms) on apps with frequent DOM updates (chat, dashboards, live feeds).
- Noticeable CPU usage from the extension's content script on high-DOM-churn pages (check via Chrome Task Manager, Shift+Esc).

**Phase to address:** Border Overlay rendering phase.

---

### Pitfall 13: Accidentally logging or persisting raw cookie/token values during development

**What goes wrong:**
The most direct violation of the "local-only, never transmit or persist raw session material" requirement typically happens by accident during development/debugging: `console.log(cookie)` on the full `chrome.cookies.Cookie` object (which includes the raw `value` field) left in shipped code; passing the full cookie object (not just derived shape/booleans) through `chrome.runtime.sendMessage` between content script and service worker; writing raw signal objects to `chrome.storage.local`/`chrome.storage.session` for "debugging persistence" without stripping the token value first; or including a raw storage-sensor-read JWT string in an error report if error telemetry is ever added.

**Why it happens:**
It's the path of least resistance during debugging — logging the whole object is faster than extracting just the fields you need, and it's easy to forget to remove before merging. Message-passing boundaries (content script ↔ service worker) are also an easy place to over-share, since it's simpler to serialize "the whole sensor reading" than to define a narrow derived-signal-only message shape.

**How to avoid:**
Define the message/event shape between sensors and the ConfidenceEngine as strictly typed, minimal, non-reversible signal data from the start (e.g., `{hasHttpOnlySessionCookie: boolean, cookieEntropyBucket: 'high'|'low', ...}` — never `{cookieValue: string}`). Enforce with TypeScript types that simply don't have a `value`/`token` field, so leaking it is a type error, not just a code-review catch. Add an eslint rule or pre-commit grep check banning `console.log` of anything typed as `chrome.cookies.Cookie` or containing `.value`. Treat `chrome.storage` writes of anything sensor-derived as requiring explicit review — since `chrome.storage.session` persistence (needed for Pitfall 5) must only ever contain the *fused/derived* state, never raw signal inputs.

**Warning signs:**
- Any `console.log`/`console.debug` call with a `Cookie`, `Headers`, or raw storage-read object anywhere in content-script or service-worker code.
- `chrome.runtime.sendMessage` payloads that include a `value`, `token`, or full cookie/header object rather than derived booleans/enums.

**Phase to address:** This must be a standing constraint enforced from the Cookie Sensor / Network Sensor / Storage Sensor phases onward (define the narrow message-passing contract before writing sensor code), with a final privacy audit pass before MVP ship (grep the codebase for `.value` reaching `console.*` or `chrome.storage.*`/`chrome.runtime.sendMessage`).

---

### Pitfall 14: Partitioned cookies (CHIPS) cause false negatives for apps that partition their session cookie

**What goes wrong:**
Google reversed course on fully deprecating third-party cookies (Chrome keeps them on by default as of the 2025 announcement), but `CHIPS` (Cookies Having Independent Partitioned State) is a surviving, real, increasingly-used mechanism where a site opts a cookie into `Partitioned` storage — a separate cookie jar per top-level site. If a webapp's session cookie is set with the `Partitioned` attribute (common for embedded/iframe-based auth widgets, some SSO providers), `chrome.cookies.getAll()` calls that don't pass a `partitionKey` may not return it, causing the cookie sensor to report no session cookie present even though one exists.

**Why it happens:**
CHIPS is a relatively recent addition to the cookies platform surface, easy to miss if development/testing happens against apps that don't use it (most simple cookie-session apps still use ordinary unpartitioned cookies) — the gap only shows up against apps that specifically use partitioned cookies for cross-site-embed scenarios.

**How to avoid:**
Check `chrome.cookies.getAll()`'s current partition-key support in Chrome's cookies API reference before implementation (verify via Context7/official docs at build time, since this is an evolving area) and decide explicitly whether MVP scope includes querying partitioned cookie jars. Given the design's non-goal of "who is signed in" and its focus on top-frame same-site session cookies (the overwhelmingly common case), it is reasonable to explicitly scope CHIPS-partitioned cookies as out-of-scope for MVP — but this should be a documented decision, not a silent gap discovered later.

**Warning signs:**
- False negative (no border) on an app known to use an embedded/partitioned auth cookie despite the user being logged in (network/DOM signals may partially compensate, or may not).

**Phase to address:** Cookie Sensor phase — document as explicit scope decision; low priority for MVP given the design's stated focus on the common case.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| Keying WebApp state by raw URL instead of eTLD+1 | Faster to write initially | SPA thrashing (Pitfall 10), breaks "no navigation dependency" requirement | Never — this violates a core requirement, not just a nice-to-have |
| Skipping `chrome.storage.session` persistence, keeping state in module globals | Simpler code, no async storage calls | Silent state loss on SW suspension (Pitfall 5) — WILL happen in real usage, not a corner case | Only for a throwaway prototype/spike, never for anything demoed as "working" |
| Broad `all_frames: true` content script registration "to be safe" | Avoids worrying about frame scoping upfront | Iframe session bleed-through (Pitfall 4) | Never for MVP; revisit only if a validated need for iframe-aware detection emerges post-MVP |
| Hardcoding a denylist of known tracking-cookie name patterns (`_ga`, `_fbp`, etc.) | Meaningfully reduces false positives for near-zero engineering cost | Technically a tiny violation of "pure zero-config" (it's a shared infra denylist, not a per-app rule) | Acceptable — these are cross-app tracking/analytics infrastructure names, not app-specific rules; document the exception explicitly |
| No visual distinction between "Unknown/no-permission" and "confirmed SignedOut" | Simpler border logic (binary show/hide) | Confuses "extension can't see this site" (Pitfall 7) with "user really is logged out" — undermines trust in the tool | Acceptable for MVP given Unknown-state border treatment is explicitly deferred, but must be documented as a known limitation, not silently absorbed |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|--------------------|
| `chrome.webRequest` | Assuming response bodies are readable, or reaching for `declarativeNetRequest` (which can't report status back to JS) when observational status/headers were all that was needed | Use non-blocking `chrome.webRequest.onCompleted`/`onHeadersReceived` for status/header observation only; never attempt body parsing (Pitfall 6) |
| `chrome.cookies` | Calling `getAll()` unscoped (or scoped only to the literal tab URL) and fusing every returned cookie, including third-party/iframe-origin ones, into the tab's verdict | Scope `getAll({domain})` strictly to the tab's registrable domain and known subdomains (Pitfall 4) |
| `chrome.storage.session` | Treating it as a place to dump full sensor readings "for debugging," including raw cookie/token values | Store only derived/fused state; never raw signal inputs (Pitfall 13) |
| Public Suffix List / eTLD+1 | Hand-rolling domain-suffix logic (e.g., "strip everything before the second-to-last dot") instead of using a maintained PSL-based library | Use a maintained PSL library (e.g., `psl`, `tldts`) and keep it updated — PSL entries change over time |
| OAuth/IdP redirects | Assuming the IdP domain visit is invisible/inert to the engine, without verifying it doesn't create a stray positive verdict on the IdP's own domain | Explicitly test and document behavior during real OAuth flows (Pitfall 8) |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Un-debounced MutationObserver on `document.body` with `subtree: true` for both DOM sensor AND border self-healing | High CPU in content script, visible in Chrome Task Manager | Debounce/threshold both observers; scope the border's self-healing observer to `documentElement` childList only, not full subtree | Chat apps, live dashboards, virtualized/infinite-scroll UIs with constant DOM churn |
| Re-querying `chrome.cookies.getAll()` on every `cookies.onChanged` event without scoping/filtering | Excess service worker wake-ups, battery drain across many open tabs | Filter `onChanged` events by relevance (domain match to a tracked tab) before doing a full re-query | Users with many tabs (10+) open across different sites simultaneously |
| Network sensor firing an active identity-endpoint probe on a timer per tab | Extra network requests to third-party apps' `/me` endpoints the user didn't initiate — could trip rate limits or look like bot traffic | Rely on *observing* naturally-occurring requests via webRequest rather than actively probing endpoints (design already implies observation, not probing — confirm no "poll /me every N seconds" logic sneaks in) | Any app with aggressive rate-limiting on identity endpoints |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Raw cookie/token values crossing the content-script ↔ service-worker message boundary | HttpOnly session token exposed to a broader attack surface than necessary (any code with `chrome.runtime` message access) | Enforce derived-signal-only message contracts at the type level (Pitfall 13) |
| Logging cookie/storage values to console during development, left in shipped build | Leaks session material into DevTools console, screen recordings, bug reports | Lint rule banning `console.*` of typed cookie/token objects; pre-ship grep audit |
| `<all_urls>` host permission with no permission-state awareness | Extension silently loses visibility on revoked sites without distinguishing that from "signed out," undermining the tool's core promise | Check `chrome.permissions.contains()` before treating absence of signals as a confident SignedOut verdict (Pitfall 7) |
| Content script style/DOM injection incompatible with Trusted Types on CSP-strict sites (banks, enterprise SaaS) | Extension silently fails (throws) exactly on the security-conscious sites where accurate sign-in detection matters most | Use `createElement`/CSSOM property assignment, not `innerHTML`/`style.cssText` string injection (Pitfall 11) |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Border flickers on/off during normal SPA navigation | User loses trust in the signal ("is it broken?") | Key state strictly by eTLD+1, not URL; preserve hysteresis across in-app route changes (Pitfall 10) |
| Border vanishes with no explanation when user revokes/never grants host permission for a site | User assumes "signed out" when really "extension can't see this site" — misleading | At minimum, distinguish these states internally; consider a visible "unknown" indicator post-MVP (Pitfall 7) |
| Border disappears during video/presentation fullscreen | Momentarily confusing but likely acceptable since all browser chrome hides in fullscreen | Document as accepted behavior; don't over-invest in defeating the Top Layer for MVP (Pitfall 11) |
| Border briefly appears/flickers during OAuth "Sign in with Google" redirect bounce | Confusing, looks like a bug the first time a user notices it | Explicitly test and, if the flicker is on the IdP's own domain rather than a clean disappear/reappear, treat as a bug to fix even within the "deferred grace rule" scope (Pitfall 8) |

## "Looks Done But Isn't" Checklist

- [ ] **Hysteresis:** Looks correct in a single fast manual test, but verify it survives a 60+ second idle period with DevTools *closed* (service worker suspension, Pitfall 5) — testing with DevTools open hides this bug entirely.
- [ ] **Cookie sensor:** Looks correct on the 3-4 manual test apps, but verify it does NOT false-positive on a cookie-consent-banner-only site (news site, no login) and DOES correctly treat a `remember-me`-cookie-but-expired-session app as not-signed-in (Pitfalls 1, 3).
- [ ] **Border overlay:** Looks correct on static pages, but verify it survives (a) a full SPA route change, (b) the app entering `requestFullscreen()`, and (c) a CSP-strict site with Trusted Types (Pitfalls 11, 12).
- [ ] **App identity/eTLD+1:** Looks correct on `www.example.com` vs `app.example.com`, but verify behavior explicitly during a real third-party OAuth ("Sign in with Google/GitHub") flow, not just simple same-domain login (Pitfall 8).
- [ ] **Privacy guarantee ("never transmit or persist raw session material"):** Looks satisfied because there's no network code, but verify by grepping the actual message-passing and `chrome.storage` call sites for raw cookie/token values, not just trusting the absence of `fetch()` calls (Pitfall 13).
- [ ] **Iframe scoping:** Looks correct because the design says "top frame only," but verify the actual manifest content-script registration has `all_frames: false` and the cookie sensor's domain filter genuinely excludes iframe-origin cookies — a design intent isn't automatically an enforced constraint (Pitfall 4).

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|----------------|------------------|
| WebAppKey accidentally derived from URL instead of eTLD+1 (Pitfall 10) | LOW | Refactor the key type to a branded `RegistrableDomain` type; TypeScript will surface every call site that needs fixing |
| State loss on SW suspension (Pitfall 5) | LOW-MEDIUM | Swap in-memory `Map` for `chrome.storage.session` reads/writes at the few chokepoints where state is read/written; add a rehydration call at SW startup |
| Iframe session bleed (Pitfall 4) | LOW | Add `all_frames: false` to manifest content-script entry; add domain filter to `cookies.getAll()` calls |
| Raw token values found in messages/storage during audit (Pitfall 13) | MEDIUM | Redefine message/storage schemas to derived-signal-only types; this cascades through every sensor and the engine, but is mechanical (type errors guide the fix) |
| False positives from tracking-cookie confusion (Pitfall 3) | LOW | Add HttpOnly-weighting (if not already) and a small denylist of known tracking-cookie name patterns; unit-testable in isolation |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| 1. Remember-me cookie / dead session | Confidence Engine (fusion + hysteresis) | Manual test: revoke server session on a real app while cookie persists; border must not show SignedIn |
| 2. Landing-page DOM false positive | DOM Sensor | Manual test against marketing/landing pages of each test app, not just app screens |
| 3. Tracking-cookie false positive | Cookie Sensor | Unit test against captured cookie jars from a cookie-banner-only site |
| 4. Iframe session bleed | Cookie Sensor + Content Script scoping | Manual test: page embedding a widget the user is separately logged into |
| 5. SW suspension state loss | Service Worker / Confidence Engine foundation | Idle-then-resume test with DevTools closed |
| 6. webRequest body-read assumption | Network Sensor | Code review / module doc constraint; test against a GraphQL-style always-200 API |
| 7. Host permission revocation ambiguity | Permissions/manifest setup | Manual test: revoke site access via `chrome://extensions`, confirm distinguishable from SignedOut internally |
| 8. OAuth/IdP redirect flicker | App Identity (eTLD+1 keying) | Manual test: real "Sign in with Google/GitHub" flow |
| 9. Multi-domain app identity limitation | App Identity | Documented as known limitation, not code-fixed |
| 10. SPA URL re-keying thrash | App Identity / Confidence Engine | Integration test: in-app route change preserves state |
| 11. Stacking context / Top Layer / Trusted Types | Border Overlay rendering | Manual test: fullscreen app + CSP-strict app (bank/enterprise SaaS) |
| 12. Border node destroyed by re-render | Border Overlay rendering | Manual test on high-DOM-churn app (chat/dashboard); CPU check via Task Manager |
| 13. Raw session material leakage | All sensor phases + final privacy audit | Grep audit of `console.*`, `chrome.storage.*`, `chrome.runtime.sendMessage` call sites before ship |
| 14. Partitioned (CHIPS) cookies | Cookie Sensor | Explicit scope decision documented; low-priority test if time allows |

## Sources

- [The extension service worker lifecycle | Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) — HIGH confidence, official docs; 30s idle timeout, global-variable loss, Chrome 110+ event-reset behavior
- [Longer extension service worker lifetimes | Chrome for Developers](https://developer.chrome.com/blog/longer-esw-lifetimes) — HIGH confidence, official blog on SW lifetime improvements
- [Replace blocking web request listeners | Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests) — HIGH confidence, official migration guide; confirms non-blocking webRequest remains available for observation
- [chrome.webRequest | API | Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/webRequest) — HIGH confidence, official API reference
- [chrome.cookies | API | Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/cookies) — HIGH confidence, official API reference; session vs. persistent cookie detection via `expirationDate`
- [MDN: CHIPS / Partitioned cookies](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies) — HIGH confidence, official MDN reference
- [Third-Party Cookies in 2026: What Actually Happened After Google's Reversal](https://www.consenteo.com/knowledge-hub/cookies/third_party_cookies_2026_after_google_reversal) — MEDIUM confidence, industry blog; corroborates Chrome keeping 3P cookies on by default as of 2025/2026
- [MDN: Fullscreen API Guide](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API/Guide) — HIGH confidence, official MDN; Top Layer stacking behavior for fullscreen elements
- [Manifest V3 Migration Pitfalls — Lessons from 17 Chrome Extensions](https://dev.to/_350df62777eb55e1/manifest-v3-migration-pitfalls-lessons-from-17-chrome-extensions-2j3h) — MEDIUM confidence, aggregated community post-mortem, consistent with official docs
- [Chrome Extensions: eyeo's journey to testing service worker suspension | Chrome for Developers](https://developer.chrome.com/blog/eyeos-journey-to-testing-mv3-service%20worker-suspension) — HIGH confidence, official case study on SW suspension testing pitfalls
- Domain reasoning grounded directly in `.planning/PROJECT.md` and `docs/superpowers/specs/2026-07-17-signin-detector-extension-design.md` (this project's own stated design, constraints, and explicitly deferred items) — used to identify where the design's own accepted gaps (OAuth grace, multi-domain identity, Unknown-state treatment) need explicit verification rather than silent assumption

---
*Pitfalls research for: Chrome MV3 sign-in detector extension*
*Researched: 2026-07-17*
