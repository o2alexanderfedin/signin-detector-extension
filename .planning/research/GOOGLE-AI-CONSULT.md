# Google AI Mode Consultation — Auth-Detection Browser Extension Architecture

**Purpose:** Get an unbiased second opinion from Google's AI Mode (Search) on the architecture for a Chrome MV3 extension that detects sign-in state on arbitrary webapps with zero per-app configuration, without relying on navigation events, and draws a persistent border when signed in.

**Method:** Real browser automation via Playwright MCP against `https://www.google.com/` → AI Mode (`udm=50`), single continuous conversation thread, 6 questions (5 planned + 1 targeted follow-up). Questions were phrased openly and did not reveal our proposed "weighted fusion + hysteresis" design, so the convergence documented below is an independent validation, not a leading response.

**Automation status:** ✅ **Real AI Mode succeeded** — no fallback was needed. All six turns rendered full AI Mode answers with citations, tables, and code samples inside the same conversation thread.

**Screenshots (evidence):**
- `.planning/research/evidence/google-ai-mode-q1-detection-methods.png` — full-page capture of Q1 answer (detection methods trade-off matrix)
- `.planning/research/evidence/google-ai-mode-q4-border-overlay.png` — viewport capture of Q4 answer (border overlay techniques + code blueprint)
- `.planning/research/evidence/google-ai-mode-q6-fusion-hysteresis.png` — viewport capture of Q6 answer (weighted score + dual-threshold hysteresis, independently proposed)

Raw accessibility-tree snapshots of every turn were also saved during the session (`.planning/research/evidence/raw-snapshots/snapshot-q3.md` … `snapshot-q6.md`) if a full re-read of the verbatim DOM text is ever needed.

---

## Exact questions asked (in order, same conversation thread)

1. "What are the possible ways a browser extension could detect whether a user is signed into an arbitrary web application, without per-site configuration and without relying on page navigations? What are the trade-offs of each approach?"
2. "What are the most reliable universal signals that indicate an authenticated session in a modern web app, and what are their failure modes / false positives?"
3. "What are the known hard problems and gotchas with Chrome Manifest V3 for reading cookies, observing network requests, and running persistent logic in the service worker?"
4. "How can a browser extension reliably draw a persistent border overlay on arbitrary web pages, including SPAs and pages with aggressive CSS? What techniques survive re-renders and avoid breakage?"
5. "Are there approaches we might be missing for grouping multiple domains into one logical 'web application' for the purpose of tracking auth state, when a webapp legitimately spans many different domains (e.g. app.example.com, api.example.com, cdn used, auth.example.net, related-brand.com)?"
6. (Targeted follow-up) "When no single signal (cookies, network status codes, storage tokens, DOM markers) is 100% reliable on its own, what are recommended patterns for combining multiple imperfect signals into one overall confidence decision about auth state, and how do you avoid the UI flickering or flapping rapidly between states as individual signals change?"

---

## Faithful summary of Google AI Mode's answers

### Q1 — Detection methods & trade-offs
Four primary approaches, each with a trade-off matrix:
1. **Cookie change monitoring** (`chrome.cookies.onChanged`) — very low performance cost, `cookies` permission only, but **low accuracy / high false positives** (can't distinguish tracking cookies from auth cookies without site knowledge).
2. **Network request interception** (`webRequest`/`declarativeNetRequest`) — watches for `Authorization: Bearer` headers or `401/403 → 200` transitions — **high accuracy**, but heavy permission footprint (`<all_urls>` + `webRequest` triggers Chrome Web Store "high-risk" deep review) and CPU overhead.
3. **DOM MutationObserver heuristics** — scans for "Sign out"/"Log out"/"My Account" strings or elements — catches SPA state changes, but **highly fragile**: breaks on UI redesigns and non-English locales.
4. **Credential Management API hooking** (`navigator.credentials`) — zero-config, catches the exact login moment, but **very low coverage** since most apps still use form POSTs or custom OAuth flows rather than this native API.

### Q2 — Most reliable universal signals & failure modes
Ranked by accuracy:
1. **`Authorization` header presence** — high reliability; false positive = anonymous/guest JWTs issued to unauthenticated users (carts, public APIs); fails entirely on cookie-based SPAs that never expose the header.
2. **Storage token keys** (`localStorage`/`sessionStorage`: `id_token`, `access_token`, `auth_token`, `jwt`, vendor-specific keys like `firebase:authUser`, `supabase.auth.token`) — medium reliability; false positive = **stale tokens left behind after tab close without explicit logout**; fails on XSS-hardened apps that deliberately avoid client-accessible storage.
3. **401/403 → 200 transitions** — high reliability but high detection complexity (needs state tracking); false positive = user merely switching to a different public endpoint; failure mode = **GraphQL/REST APIs that always return `200 OK` and bury the real auth error inside the JSON body**.
4. **OAuth/OIDC callback URL parameters** (`?code=`, `&id_token=`, `&state=`) — medium reliability; false positive = failed/aborted handshakes; fails on custom enterprise auth protocols that don't follow OAuth conventions.

### Q3 — MV3 hard problems and gotchas
1. **Service worker ephemerality** — SW is killed after ~30s idle (up to 5 min active). No in-memory global state survives; every listener must rehydrate from `chrome.storage` before acting. "Keep-alive" tricks get actively patched by Chrome.
2. **`webRequest` vs `declarativeNetRequest`** — `webRequest` is read-only in MV3 for most cases and requires `<all_urls>` + high-risk permissions, subjecting the extension to a slow, manual Chrome Web Store review. `declarativeNetRequest` avoids that review tier but **cannot read header values back to the extension** — it can only apply rules, not inspect content. This is a fundamental architecture-shaping constraint.
3. **Cookie monitoring race condition** — if the SW is asleep when a cookie changes, waking it takes 50ms–1000ms+, and by the time it wakes, the triggering network request/DOM mutation may already be finished — creating a race between signal arrival and correlated context. Also flagged: **CHIPS/partitioned cookies** complicate cross-origin state sharing even though `chrome.cookies` itself bypasses partitioning for reads.
4. **Asynchronous storage bottleneck** — `chrome.storage.local` is async-only in MV3 (no more synchronous global-variable checks like MV2); checking auth state inside a hot `webRequest` listener on every request can trigger Chrome's internal performance throttling, which **silently drops your listeners**.

### Q4 — Persistent border overlay techniques
Ranked most → least robust:
1. **Closed Shadow DOM attached to `<html>` (not `<body>`)** — most reliable; survives SPA body wipes; use `all: initial` + `!important` inside the shadow root to resist host CSS; pair with a `MutationObserver` on `document.documentElement` that re-appends the container if removed. Google provided a full working code blueprint combining this with technique 2.
2. **Visual Viewport API-based fixed positioning** — use `window.visualViewport` instead of `innerWidth/innerHeight` so the overlay tracks pinch-zoom, on-screen keyboards, and dynamic mobile chrome correctly.
3. **`box-shadow: inset` on `<html>` via injected stylesheet** — zero DOM footprint (nothing for a SPA to delete), but can be overridden by the host page's own unstyled/`!important` rules or clipped by `overflow: hidden` wrapper layouts.
4. **Pointer-events-passthrough `<iframe>`** — maximum isolation from host CSS/JS, but can be blocked by strict page CSP (`frame-src`) unless MV3 `declarativeNetRequest` rules strip those CSP headers from the response.

### Q5 — Grouping domains into one logical "web application"
Four behavioral clustering approaches, explicitly framed as inference-based (no hardcoded site list):
1. **Redirect-chain mapping** via `chrome.webNavigation.onBeforeRedirect`/`onCommitted` — if domain A→B→C redirect during a login sequence, treat them as linked (union-find / directed graph in `chrome.storage.session`). Gotcha: ad/analytics redirect chains create false clustering; must filter known tracker patterns.
2. **CORS header introspection** — watch `Access-Control-Allow-Origin` + `Access-Control-Allow-Credentials: true` on background XHR/fetch responses. An explicit (non-wildcard) allow-origin with credentials is proof of a trust relationship between the calling page's domain and the API/CDN domain — **strong, verifiable signal** for clustering `api.example.com` with `app.example.com`.
3. **Cross-tab/BroadcastChannel/postMessage sniffing** — many multi-domain suites (Google's own products cited as an example) silently sync auth state across origins via hidden iframes using `postMessage`/`BroadcastChannel`. A content script hooking these constructors can observe the sender/receiver origin pair even if payloads are encrypted, since the origin handshake alone is a useful grouping signal.
4. **Public Suffix List / Related Website Sets (formerly First-Party Sets)** — Chrome's own native mechanism for large organizations to declare associated domains (Google's example: `google.com`, `youtube.com`, `gstatic.com`) so they can share cookies across contexts. Caveat: MV3 extensions can't query this registry via a simple API call yet; you'd need to bundle a compressed copy of the open registry, and it only covers large/established brands that bothered to register — **not useful for small or custom enterprise apps**.

Suggested hybrid: combine redirect-chain mapping (catches user-facing login handshakes) + CORS sniffing (catches background API/CDN relationships) inside a **Union-Find (disjoint-set) structure** persisted in `chrome.storage.session`.

### Q6 — Combining imperfect signals / anti-flapping (targeted follow-up)
Google AI Mode **independently proposed an architecture nearly identical to ours**, without being shown our design:
1. **Weighted score pipeline** — maintain a 0–100 confidence score per domain cluster in `chrome.storage.session`; assign each signal a weight (e.g. `+60` fresh `Authorization` header, `+30` storage tokens present, `+20` DOM "Log out" marker, `-50` hard `401/403`).
2. **Dual-threshold hysteresis** — cross `>70` to flip Logged-Out → Logged-In; must drop `<30` to flip back Logged-In → Logged-Out. A score oscillating between 40–60 is absorbed with no UI change. Google even drew this as an ASCII state diagram.
3. **Asymmetric debounce** — treat logins as instantaneous (update UI immediately on a strong signal) but logouts as lazy/debounced (3–5 second grace period before tearing down the overlay, to survive token-refresh windows where storage/headers blink out momentarily).
4. Provided a full MV3 code blueprint: `chrome.webRequest` listeners feeding a centralized `updateAuthSignal()` scorer in the service worker, writing to `chrome.storage.session`, with the content script listening via `chrome.storage.onChanged` and applying its own local debounce before hiding the border.

---

## Options / risks we may have MISSED

These surfaced from Google AI Mode and are **not currently reflected** (or only partially reflected) in our four-signal design:

1. **CORS header introspection as a domain-clustering signal (Q5).** Watching `Access-Control-Allow-Origin` (non-wildcard) + `Access-Control-Allow-Credentials: true` on background requests is a genuinely strong, verifiable trust signal between an app's frontend domain and its API/CDN domains — arguably more reliable than eTLD+1 alone for apps that legitimately span multiple registrable domains (e.g. `app.example.com` calling `api.example-cdn.net`). Worth evaluating as a domain-clustering enhancement, since our current identity model is pure eTLD+1 and would treat `api.example-cdn.net` as a separate app.
2. **Redirect-chain / OAuth handshake mapping via `webNavigation`** as a second, independent domain-clustering signal (with tracker-pattern filtering to avoid false links through ad redirects). Also useful as an additional *positive* auth signal in its own right (an OIDC `?code=`/`&id_token=` callback firing is a strong "something just authenticated" event) — currently outside our four signal categories.
3. **Cross-tab `postMessage`/`BroadcastChannel` sniffing** — multi-domain product suites silently propagate auth state between origins this way; even encrypted payloads leak a useful origin-pair signal. Not in our current signal set at all.
4. **Chrome's Related Website Sets (formerly First-Party Sets)** as a native, zero-maintenance domain-grouping mechanism for large/established brands — free signal for the subset of apps that have registered, though not a general solution (small/custom enterprise apps won't be in it, and MV3 has no direct query API — would need a bundled snapshot of the public registry).
5. **`declarativeNetRequest`'s header-visibility gap** — Google flagged clearly that DNR (the "safer", non-deep-review network API) **cannot read header values back to the extension**, only apply rules. If our plan assumed DNR could be used for the network-status-code signal while staying out of the high-risk permission tier, this is a hard blocker worth explicitly confirming against: reading `Authorization` headers or distinguishing 401/403/200 status content really does require the heavier `webRequest` + `<all_urls>` combination, with the Web Store review consequences that come with it.
6. **CHIPS / partitioned cookies** as a complication for cross-origin state correlation — worth a explicit note even though `chrome.cookies` read access itself bypasses partitioning.
7. **Guest/anonymous JWT false positive** for the `Authorization` header signal specifically (not just generic "false positives" — many e-commerce/public-API apps issue a JWT to *unauthenticated* users for cart/session tracking). This is a concrete failure mode to add to the storage/header signal weighting logic, not just cookies.
8. **GraphQL "soft errors"** — APIs that always return `200 OK` and bury the real 401 inside the JSON body defeat a naive status-code signal. Worth a explicit mitigation note (e.g. shallow JSON-body sniffing for `"errors"`/`"unauthorized"` patterns as a secondary confirmation, with appropriate low weight).
9. **Asymmetric debounce (fast login / slow logout)** — Google's answer treats login and logout asymmetrically (immediate vs. 3–5s grace period) rather than applying symmetric hysteresis bounds alone. This is a refinement layered *on top of* hysteresis, not a replacement — worth considering whether our hysteresis thresholds alone (0.7/0.3) sufficiently cover the "token refresh blip" case, or whether an explicit debounce timer on the logout transition specifically would harden it further.

---

## Where Google AGREES vs DISAGREES with our fusion approach

### Agrees (strong independent convergence)
- **Core architecture pattern**: Google independently proposed the same shape — per-app-domain numeric confidence score, weighted contributions from cookie/network/storage/DOM signals, evaluated against thresholds — arrived at *without* being shown our design.
- **Hysteresis with two thresholds**: Google's proposed 70/(rising) and 30/(falling) on a 0–100 scale is essentially identical in shape to our 0.7/0.3 thresholds on a 0–1 scale. This is a near-exact match and a meaningful validation signal.
- **Weighting network signals highest, DOM signals lowest**: Google's example weights (`+60` header token, `+30` storage, `+20` DOM marker, `-50` hard 401/403) match the general reliability ranking implied in our design (network/cookie signals as strong positive/negative evidence, DOM as corroborating-only, given how fragile string/selector heuristics are).
- **eTLD+1 as app identity boundary**: not contradicted — Google's Q5 answer treats domain clustering as an *addition on top of* a per-domain baseline, not a replacement for it, consistent with our eTLD+1-first model.
- **Persistent-state-in-storage requirement**: Google's MV3 gotchas answer (Q3) independently reinforces that any confidence state (including hysteresis state) must live in `chrome.storage.session`/`local`, not SW memory — consistent with our design's stated reliance on storage for cross-restart survival.
- **Shadow DOM attached to `<html>` with a MutationObserver re-append guard** for the border overlay matches best current practice for the rendering side of the extension (not itself part of the fusion approach, but validates the broader architecture).

### Disagrees / tension points
- **Network signal acquisition path**: Google's blueprint code (Q6) uses `chrome.webRequest.onBeforeSendHeaders`/`onHeadersReceived` with `<all_urls>` directly — i.e., it defaults to the **heavy, Web-Store-deep-review-triggering** approach rather than `declarativeNetRequest`. If our plan intended to minimize permission footprint via DNR, Google's answer (reinforced by its explicit Q3 statement that DNR cannot read header values) suggests that goal may be **incompatible** with reading `Authorization` headers or precise status codes — this is a real architectural tension to resolve explicitly (accept the review tier, or drop header/status-code granularity and rely more on cookies + storage + DOM).
- **Domain identity model**: our approach fixes app identity at eTLD+1; Google's Q5 answer suggests eTLD+1 alone under-covers real multi-domain apps (CDN/API subdomains-of-different-registrable-domains, or fully separate brand domains under one company) and recommends *dynamically inferred* clustering (redirect chains + CORS trust) as a necessary supplement, not an edge case to ignore. This isn't a contradiction of eTLD+1 as the *base unit*, but it does push back on treating eTLD+1 as sufficient on its own for "one logical web application."
- **Debounce asymmetry**: Google's answer layers an explicit 3–5s logout-only debounce on top of hysteresis, implying that pure hysteresis (symmetric score-crossing logic) may not be sufficient on its own to fully suppress flicker during common transient events like token-refresh windows. Worth deciding whether this is redundant with a sufficiently wide hysteresis band or a genuinely necessary additional layer.

---

## Confidence & caveats

- **Automation succeeded with real browser interaction** — all six answers came from Google's live AI Mode product (`google.com/search?...&udm=50`), not a simulated or memory-based fallback. Screenshots and saved snapshot files are direct evidence.
- AI Mode answers include their own disclaimer ("AI can make mistakes, so double-check responses") and cited third-party sources (Medium posts, Stack Exchange, vendor docs, Hacker News, Dynatrace docs) of mixed authority — treat specific numeric claims (e.g. exact SW idle timeout of "30 seconds," specific wake-up latency ranges "50ms–1000ms+") as approximate/anecdotal rather than verified against Chromium source, though they're broadly consistent with publicly known MV3 behavior.
- The `declarativeNetRequest` header-visibility limitation Google stated (cannot read header values back to the extension) is a load-bearing claim for point 5 in "Options we may have missed" above — this matches current public MV3 documentation but is worth a final spot-check against the latest `chrome.declarativeNetRequest` docs before treating it as a hard architectural constraint, since Chrome extension APIs evolve.
- Because this was one continuous AI Mode conversation thread, later answers had implicit context from earlier turns (it referenced "your extension architecture" by Q3 onward) — this likely improved coherence and relevance without introducing bias toward our specific design, since we never described our fusion/hysteresis approach to it before Q6 elicited it independently.
- No consent/cookie dialog appeared during navigation (search was performed logged-out); no login/paywall blocked AI Mode access.
