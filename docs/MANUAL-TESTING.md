# Manual Testing Checklist (Phase 5: Validation & Hardening)

This is the human-verification checklist for the criteria that **cannot**
be automated inside an agent sandbox (no display, no real external
network egress, no real Google/GitHub/OAuth account). Everything else --
the extension loaded into a real Chromium against a LOCAL fixture app, and
the privacy audit -- is automated; see:

- `tests/e2e/playwright/` (`npm run test:e2e`) -- real built extension +
  real Chromium + a local loopback-only fixture app.
- `tests/e2e/fullLoop.test.ts` (`npm test`) -- the same signal-to-border
  loop, deterministically, in `@webext-core/fake-browser`.
- `npm run audit:privacy` / `src/shared/privacyAudit.test.ts` -- PRV-01/
  PRV-02 structural audit.

Run every item below against a real Chrome/Chromium profile with the
extension loaded unpacked, on a real display, with real network access.

## Prerequisites

1. `npm run build` (produces `.output/chrome-mv3`).
2. Chrome/Chromium -> `chrome://extensions` -> enable **Developer mode** ->
   **Load unpacked** -> select `.output/chrome-mv3`.
3. Confirm the extension loaded with no errors on the `chrome://extensions`
   card (click **Errors** if the button is present -- there should be
   none), and note its assigned extension id.
4. For each checklist item, watch the top-frame viewport edge for the
   **green 4px border** (`BORDER_OVERLAY_COLOR` / `BORDER_OVERLAY_WIDTH_PX`,
   `src/shared/constants.ts`) -- present while (and only while) the
   extension has classified the tab as signed-in.

---

## Criterion 2: Real apps, SW-idle survival, no false positives

### 2.1 A Google property (cookie + network identity endpoint signals)

1. Open a fresh tab to a Google property you have an account for (e.g.
   `myaccount.google.com` or `mail.google.com`).
2. **Signed out**: no border.
3. Sign in. **Expected**: border appears within a few seconds (cookie
   sensor's `chrome.cookies.onChanged` + network sensor's identity-shaped
   endpoint both fire promptly; `DEBOUNCE_SIGNED_IN_MS` is 0 -- no
   deliberate delay on the way *in*).
4. Sign out from the account menu. **Expected**: border remains for up to
   `DEBOUNCE_SIGNED_OUT_MS` (3s) after the signal actually flips negative
   (ENG-04's asymmetric logout debounce, so a transient token-refresh blip
   never flickers the border), then clears.

### 2.2 GitHub (cookie-session + DOM affordance signals)

1. Sign in to `github.com`.
2. **Expected**: border appears. Open DevTools -> Application -> Cookies
   and confirm `github.com`'s session cookie is `HttpOnly` + `Secure` (the
   shape SEN-01 keys off -- the extension never reads its value).
3. Navigate between a few GitHub pages (repo -> issues -> your profile --
   all same eTLD+1, some full navigations, some pjax/SPA-partial). **Expected**:
   border never flickers off during same-site navigation.
4. Sign out. **Expected**: border clears after the debounce window (~3s+).

### 2.3 A plain cookie-session app (no JS framework, no bearer tokens)

Use any classic server-rendered session-cookie app you have available
(e.g. a self-hosted admin panel, WordPress `wp-admin`, Django admin, or
any internal tool that sets a plain `HttpOnly; Secure` session cookie and
has no SPA routing).

1. Sign in. **Expected**: border appears (cookie signal alone, full-match
   shape, is enough to cross `THRESHOLD_SIGNED_IN` on its own -- weight
   1.0, `COOKIE_POSITIVE_VALUE` 1.0).
2. Sign out. **Expected**: border clears after the debounce window.

### 2.4 Verdict survives 60s+ of service-worker idle, DevTools CLOSED

This is the single most important MV3-specific regression to catch --
PLT-01/PLT-03 exist specifically because an MV3 service worker is
routinely suspended by Chrome after ~30s of inactivity, and any state
held only in memory (not persisted + rehydrated) silently reverts to
"unknown" on the next event.

1. Sign in to any app from 2.1-2.3 above; confirm the border is showing.
2. **Close DevTools entirely** (including the extension's own service
   worker DevTools window/panel, if one is open -- an *attached* DevTools
   instance keeps the service worker alive indefinitely, which would mask
   the very failure mode this test exists to catch).
3. Do not interact with the tab or the extension for **at least 60
   seconds**. (Optional stronger check: `chrome://extensions` -> the
   extension's card -> click **service worker** link if shown as
   "inactive"/greyed out, confirming Chrome actually suspended it -- or
   inspect `chrome://inspect/#service-workers` for its absence.)
4. After the idle period, interact with the page in a way that produces a
   new signal (e.g. reload the tab, or trigger any network request the
   app makes). **Expected**: the border is still showing (or reappears
   within a couple seconds), reflecting the SAME signed-in verdict as
   before the idle period -- not a flash of "unknown"/no border followed
   by a fresh detection. This proves the `chrome.storage.session`-backed
   `verdictStore` snapshot (state + confidence + `pendingSignedOutSince`)
   correctly rehydrated the `ConfidenceEngine` on SW wake.

### 2.5 No false border on a cookie-banner-only news site

Open any news/media site that shows a GDPR/CCPA cookie-consent banner
(OneTrust, Cookiebot, or similar) but where you are **not** logging in.

1. Accept (or dismiss) the cookie banner -- this sets consent cookies
   (typically named like `OptanonConsent`, `OptanonAlertBoxClosed`,
   `_ga*`, `__utm*`, etc.).
2. **Expected**: **no border appears**, despite a fresh, often
   high-entropy-looking cookie having just been set. This exercises
   SEN-02's `TRACKING_COOKIE_NAME_PATTERNS` denylist
   (`src/shared/constants.ts`) -- a denylisted cookie NAME short-circuits
   to `COOKIE_DENYLISTED_VALUE` (0.1) regardless of otherwise-strong
   shape, and the site's marketing copy (which may itself contain words
   like "Account" or "Sign out" in nav/footer links unrelated to any real
   session) must not trip the DOM sensor's affordance patterns either.

---

## Criterion 3: CSP/Trusted-Types-strict site + fullscreen (Top Layer) limitation

### 3.1 CSP + Trusted-Types-strict site renders the border without a CSP violation

Use a site with a strict CSP (banks, many enterprise SaaS products, and
`accounts.google.com` itself are good candidates -- check
DevTools -> Network -> the document response's `content-security-policy`
header, or look for `require-trusted-types-for 'script'`).

1. Sign in (or land on any page where the extension would otherwise show
   the border).
2. Open DevTools -> **Console**. **Expected**: **zero** CSP violation
   reports (`Refused to ...` / `This document requires 'TrustedScript'
   assignment` messages) attributable to the extension. `borderOverlay.ts`
   builds every node via `document.createElement` +
   `element.style.setProperty` only -- never `innerHTML`/`style.cssText`
   -- specifically so Trusted-Types-strict pages can't block it (BDR-02).
3. **Expected**: the border still renders correctly (visible green edge
   border) despite the page's CSP.

### 3.2 Fullscreen app -- accepted Top-Layer limitation

1. Open any app with a native Fullscreen API surface (a video player's
   fullscreen button, a presentation tool, an image gallery lightbox) while
   signed in, so the border is showing.
2. Enter fullscreen.
3. **Expected (accepted, documented limitation, not a bug)**: the border
   is **not visible** while the page occupies the browser's Fullscreen /
   CSS Top Layer. The Top Layer is a separate paint stack that sits above
   *any* regular DOM stacking context regardless of z-index (including
   `BORDER_OVERLAY_Z_INDEX`'s `2147483647` maximum) -- see
   `.planning/research/PITFALLS.md` Pitfall 11. This is intentionally not
   defeated in the MVP.
4. Exit fullscreen. **Expected**: the border reappears (the shadow host
   was never removed -- it was simply painted under the fullscreen
   element's isolated top-layer subtree the whole time; BDR-03's
   MutationObserver self-heal is not even needed here since nothing
   detached the host).

---

## Criterion 4: Real OAuth flow settles to signed-in after redirect

1. Find a third-party site with "Sign in with Google" / "Sign in with
   GitHub" (or similar OAuth/OIDC) as an available login option.
2. Start signed out on that site. Click the OAuth sign-in button.
3. Complete the provider's real consent/redirect flow (this necessarily
   navigates away to `accounts.google.com`/`github.com` and back --a
   real cross-origin redirect chain, not a same-eTLD+1 SPA route change).
4. **Expected**: once the flow redirects back and the site's own session
   cookie / identity-endpoint response settles, the border appears on the
   third-party site's origin -- i.e. the *third-party app's* WebAppKey
   (its own eTLD+1), not the OAuth provider's, ends up signed-in. Some
   latency after the final redirect is expected and fine (the network/
   cookie signals need to actually fire); this should settle within a few
   seconds, not require a manual reload to "catch up".

---

## Known, accepted limitations

These are deliberate MVP scope decisions, not defects. Do not file a bug
for any of the following without first checking this list.

| Limitation | Why | Reference |
|---|---|---|
| **CSS Top Layer** (`<dialog>`, Popover API, fullscreen) can render above the border regardless of z-index | The Top Layer is a separate browser-level paint stack outside normal stacking-context ordering; no DOM z-index value can out-rank it | `.planning/research/PITFALLS.md` Pitfall 11; `borderOverlay.ts` doc comment; criterion 3.2 above |
| **CHIPS / partitioned cookies** (`Partitioned` attribute) may not be returned by `chrome.cookies.getAll()` without an explicit partition key, causing a false negative for apps that partition their session cookie (common for embedded/iframe SSO widgets) | Out of scope for MVP; the design targets the overwhelmingly common top-frame, same-site, unpartitioned session cookie case | `.planning/research/PITFALLS.md` Pitfall 14; `.planning/REQUIREMENTS.md` |
| `<all_urls>` host permission combined with `webRequest` is one of the Chrome Web Store review patterns that triggers **mandatory manual/deep review** (rather than automated review) at publish time, which can add days-to-weeks to the review timeline | The detector must be able to observe cookies/network/DOM on *any* site the user signs into -- a fixed allowlist would defeat the "zero per-app configuration" design goal | `wxt.config.ts`'s `host_permissions` comment; https://developer.chrome.com/docs/webstore/review-process |
| GraphQL identity-endpoint 200s are scored lower (`NETWORK_GRAPHQL_200_VALUE` 0.5) than REST identity-endpoint 200s (`NETWORK_REST_IDENTITY_200_VALUE` 1.0) | A GraphQL 200 cannot be distinguished from a "soft-200" auth-error response shape without parsing the response body, which is explicitly out of scope (status/header only, SEN-03/PRV-02) | `src/sensors/network/classify.ts` |
| Weight/threshold calibration (`SIGNAL_WEIGHTS`, `THRESHOLD_SIGNED_IN`/`_OUT`) is fixed at MVP defaults, not tuned against real-world usage data | Deferred to v1.x | `.planning/phases/05-validation-hardening/05-CONTEXT.md` |

---

## Hardening: `npm audit` summary (this run)

Captured `2026-07-17` against `package-lock.json` as committed on
`feature/phase-5-validation-hardening`, via `npm audit` / `npm audit fix
--dry-run` (read-only; **no `npm audit fix --force` was run**, per this
phase's explicit instruction not to accept breaking changes here).

**10 vulnerabilities: 3 critical, 4 high, 2 moderate, 1 low.**

| Package | Severity | Advisory | Pulled in by |
|---|---|---|---|
| `shell-quote` | critical | [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p) | `fx-runner` (Firefox dev-run tooling) |
| `adm-zip` | high | [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) | `firefox-profile` (Firefox dev-run tooling) |
| `tmp` | high | [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) | `web-ext-run` -> `wxt` |
| `esbuild` | (moderate/high range, 0.27.3-0.28.0) | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | `wxt`'s dev server |
| `uuid` | moderate | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `node-notifier` (via `wxt`/`web-ext-run` tooling) |

**Every one of these is a transitive devDependency of `wxt`'s own build/
dev tooling** (Firefox `web-ext`-style dev-run packaging and the Vite/
esbuild dev server) -- reachable only via `npm run dev`/`dev:firefox`, not
via `npm run build`/`zip`. **Neither is a dependency of the two actual
shipped runtime packages** (`@webext-core/messaging`, `tldts` --
`package.json`'s `dependencies`), and none of these package names appear
anywhere inside the built `.output/chrome-mv3` bundle -- they never ship
to end users.

**`npm audit fix` (non-force, dry-run) fixes 0 of the 10.** All ten are
transitively locked to the currently-pinned `wxt@0.20.27`'s own dependency
tree; npm can only move them by also moving `wxt` itself. The only path
`npm audit` offers is `npm audit fix --force`, which it reports would
**install `wxt@0.3.2`** -- a large breaking downgrade of the exact pinned
build tool version this entire codebase (and its `wxt.config.ts` /
`wxt/testing/vitest-plugin` integration) is built against. **Not run**,
per this phase's explicit instruction.

**Recommendation**: accept these as a documented, monitored risk for now
(dev-tooling-only, no shipped-code exposure); revisit when `wxt` publishes
a newer 0.x/1.x release that resolves its own transitive tree without
requiring a downgrade -- re-run `npm audit` after any future `wxt` version
bump.
