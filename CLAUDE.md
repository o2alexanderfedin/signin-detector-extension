<!-- GSD:project-start source:PROJECT.md -->
## Project

**Sign-In Detector Browser Extension**

A browser extension (Chrome MV3, Firefox-compatible) that continuously determines, per browser tab, whether the user is **signed in** to the webapp occupying that tab, and draws a **visible border** around the viewport when they are. It works across arbitrary webapps with zero per-app configuration, and does not rely on navigation events to make the determination.

**Core Value:** Correctly distinguish "signed in" from "not signed in" for **any** webapp — without per-app rules and without depending on navigations — and reflect that state as a visible border.

### Constraints

- **Tech stack**: Chrome MV3 extension (service worker + content script), Firefox-compatible. TypeScript, strongly typed, strict.
- **Timeline**: Limited — MVP-sized scope, delivered on time. Favor parallel work streams.
- **Privacy/Security**: Local-only processing; raw cookie/token values never leave the service worker, never persisted, never transmitted. No outbound network calls from the extension.
- **Permissions**: `cookies`, `webRequest`, `scripting`, `storage`, host access (`<all_urls>` for MVP). Broad host access is the main trust cost — stated up front.
- **Process**: TDD, SOLID, KISS, DRY, YAGNI, TRIZ. Rival subagents, Google AI mode consults, worktree isolation, workflow orchestration.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Framework / Build Tooling
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **WXT** | `0.20.27` | Extension framework (Vite-based): manifest generation, dev server with HMR, multi-browser build targets, file-based entrypoints | The de-facto 2026 standard for new extension projects. Built on Vite (same engine as CRXJS) but adds manifest generation, cross-browser output (Chrome/Firefox/Edge/Safari, MV2/MV3), built-in `storage`/`messaging` wrappers, and a first-party Vitest integration that fakes the whole extension API. Actively maintained (~9.5k GitHub stars, releases every few days), used in production by extensions with 1M+ users. HIGH confidence — verified via Context7 (`/wxt-dev/wxt`) and current npm metadata. |
| **TypeScript** | `6.0.3` (NOT `7.0.2`) | Language / type checker | See "What NOT to Use" — TS 7.0 GA'd July 8, 2026 (9 days before this research) with a from-scratch Go-native compiler that ships **without a stable programmatic API** (lands in 7.1). `typescript-eslint` closed TS7 support as "not planned" for now and its type-aware rules crash under TS7; peer-dep ranges block install. Pin `typescript@6.0.3` (latest 6.x, matches TS7's semantics/strictness) until the ecosystem (typescript-eslint, ts-based Vite plugins) certifies TS7. HIGH confidence, verified same-day against the TypeScript blog and the typescript-eslint issue tracker. |
| **Vite** | (bundled via WXT, currently Vite 6.x) | Bundler underneath WXT | Not installed directly — WXT manages its own Vite version/config. Don't hand-roll a separate Vite config; use `wxt.config.ts` and the `vite` hook inside it for anything custom (e.g. adding `WebWorker` lib types for the service worker). |
### Testing
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **Vitest** | `4.1.10` | Unit + integration test runner | WXT's official, documented test integration (`wxt/testing/vitest-plugin`). Fast (esbuild/Vite-native), TS-first, no separate ts-jest transform step needed. Do not use Jest here (see below). |
| **@webext-core/fake-browser** | `1.5.2` | In-memory fake of the `browser`/`chrome` extension API (storage, cookies, runtime messaging, etc.) for unit tests | WXT's `WxtVitest()` Vitest plugin wires this in automatically — `chrome.cookies`, `chrome.storage`, `chrome.runtime.sendMessage` etc. all work in-memory with zero manual mocking. This is how you unit-test the **service worker's** cookie sensor, network sensor, and `ConfidenceEngine` without a real browser: import your sensor/engine modules directly in a Vitest file, seed `fakeBrowser.cookies`/`fakeBrowser.storage`, assert on the emitted verdict. Call `fakeBrowser.reset()` in `beforeEach`. |
| **happy-dom** | (bundled, Vitest default DOM env) | DOM environment for content-script unit tests | Vitest's recommended default DOM environment in 2026: 5–10x faster than jsdom and implements `MutationObserver`, which is exactly what the DOM Sensor / border overlay code needs to be tested against. Use it as the global `test.environment`. |
| **jsdom** | `27.x` (fallback only, per-file) | DOM environment for edge cases happy-dom doesn't fully cover | Keep as a devDependency and override per-file with `// @vitest-environment jsdom` only if a specific Shadow DOM / CSSOM edge case in the border-overlay test needs jsdom's more complete spec coverage. Don't make it the default — it's markedly slower. |
| **@playwright/test** | `1.61.1` | End-to-end tests against a real loaded extension | Vitest + fake-browser cannot validate the *actual* MV3 lifecycle (service worker suspend/wake, real `cookies.onChanged` firing, a real content script injected into a real page). For the MVP's "3–4 real apps" manual test pass, at least automate one: `chromium.launchPersistentContext(userDataDir, { headless: false, args: ['--disable-extensions-except=<path>', '--load-extension=<path>'] })`, then grab `context.serviceWorkers()` (or `waitForEvent('serviceworker')`) and drive a mock login page to assert the border appears. Playwright in 2026 only loads MV3 extensions (MV2 support was dropped), which is a non-issue here. Load WXT's build output directory (`.output/chrome-mv3`) directly — no separate packaging step needed for e2e. |
| **@vitest/eslint-plugin** | latest (`^1.x`) | Lint test files | Optional but recommended alongside the ESLint setup below; catches disabled/empty tests, `.only` left in, etc. |
### TypeScript Configuration for Extension APIs
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **@types/chrome** | `0.2.2` | Type definitions for `chrome.*` APIs | WXT 0.20+ derives its own `Browser` namespace (`wxt/browser`) from `@types/chrome` (WXT dropped `webextension-polyfill` as a runtime dependency — it wasn't adding value once Firefox ships promise-based `browser.*` natively). Install `@types/chrome` as a devDependency; **do not** use the global `chrome` object directly — import `{ browser }` from `wxt/browser` (or rely on WXT's auto-import) so the same code compiles and runs against both Chrome's callback-derived promise surface and Firefox's native `browser.*`, satisfying the Firefox-compatibility requirement without an `if (chrome) / if (browser)` branch anywhere in the codebase. |
| WXT-generated `.wxt/tsconfig.json` | n/a | Base tsconfig with extension globals, path aliases (`@/*`, `@@/*`), `import.meta.env.BROWSER` etc. | Generated by `wxt prepare`. Your root `tsconfig.json` should `"extends": "./.wxt/tsconfig.json"`. For the service worker entrypoint specifically, add `"lib": ["ESNext", "DOM", "WebWorker"]` (service workers don't have `DOM` but do have `WebWorker` globals like `self`, `fetch`) — WXT's docs call this out explicitly as a common gap. |
| `strict: true` (inherited/confirmed) | — | Type safety | Non-negotiable per project constraint ("strongly typed, strict"). WXT's generated base config already sets this; don't loosen it in your override. |
### Domain-Identity Library — eTLD+1 / Public Suffix List
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **tldts** | `7.4.9` | Compute the registrable domain (eTLD+1) from a hostname/URL, per the Public Suffix List, to collapse `api.`, `cdn.`, `www.` subdomains into one logical webapp identity | Recommended over `psl` (see below). Benchmarked ~1000x faster than `psl` (parses 1–2M domains/sec), accepts raw hostnames *or* full URLs (no need to pre-parse with `new URL()` first), and has built-in IP-address / invalid-hostname detection — useful because tabs will include `localhost`, IP-addressed dev servers, and non-HTTP URLs that must be excluded from the identity logic without throwing. Use `tldts.getDomain(hostname)` for the eTLD+1 (their term for "domain", i.e. eTLD+1) and `tldts.parse(hostname)` when you need the full breakdown (subdomain, publicSuffix, isIp, isIcann, etc.) for the "many domains → one app" grouping. Actively maintained (weekly npm downloads in the tens of millions), MIT licensed, zero runtime dependencies (self-contained PSL data compiled in). Confidence: HIGH, cross-verified via GitHub benchmark writeup + npm registry. |
| `tldts-experimental` | — | NOT for this project | A separate experimental variant of tldts with a different (non-default) private-suffix policy; skip it — the stable `tldts` package's default ICANN-only suffix handling is correct for "webapp identity" (you generally do *not* want to treat e.g. `github.io` subdomains as separate apps the way the Private section would, but do want normal `.com`/`.co.uk` handling — verify this default against a couple of real target domains during implementation, MEDIUM confidence on which PSL section is right for every edge case). |
### Storage/JWT-Shape Analysis
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| No dependency — hand-rolled shape check | — | Detect "this storage value/cookie *looks like* a JWT" for the Storage Sensor | The design explicitly classifies **shape**, never decodes/validates a real token (privacy constraint: raw session material never leaves the service worker / is never persisted). A JWT-shape check is 3 dot-separated base64url segments where the first segment base64url-decodes to JSON containing `alg`/`typ`. This is ~10 lines of code with no dependency needed — pulling in a decode library for a boolean shape check is unnecessary surface area (see "What NOT to Use"). |
| **jwt-decode** | `4.0.0` (optional, only if you need typed payload access) | Decode (not verify) the payload of a token that has already passed the shape check, to read claims like `exp`/`iat` for confidence scoring (e.g. "does this token's `exp` look plausible / not expired") | Only reach for this if the fusion engine wants to *use* claim data (e.g. expiry) beyond a boolean shape signal — MVP spec (weight: medium, signal = "JWT-shaped… keys") doesn't require it. If added: zero runtime dependencies, browser-safe (`atob`-based), explicitly documented as **non-validating** (correct here — we're not doing auth, just heuristic classification). Do not use `jsonwebtoken` (Node-oriented, includes verify/sign machinery, larger, has historically shipped CVEs around `alg: none` — none of that is relevant risk surface you want in a content script). LOW-MEDIUM confidence this library is even needed for MVP — flag as a "defer until fusion engine implementation" decision. |
### Supporting / Glue Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `wxt/browser` (part of WXT, not separate install) | bundled | Cross-browser, promise-based `browser.*` API surface (cookies, webRequest, scripting, storage, runtime) | Always — this is how the service worker and content script talk to `cookies`/`webRequest`/`storage`/`scripting` in a way that works unmodified on Chrome and Firefox. |
| `@webext-core/messaging` | `3.0.2` | Typed runtime messaging between content script (Storage/DOM sensors) and service worker (ConfidenceEngine) | Recommended over hand-rolled `browser.runtime.sendMessage`/`onMessage` — gives you a typed `defineExtensionMessaging<ProtocolMap>()` call so "sensor sends `{signal: 'dom', value: 0.8}`" is type-checked at both ends instead of stringly-typed. Small (part of the same `webext-core` family WXT already depends on for fake-browser), zero-config with WXT. |
## Installation
# Scaffold (creates WXT project structure, wxt.config.ts, .wxt/ types)
# Pin TypeScript to 6.x (WXT init may pull latest/"7" — override explicitly)
# Core runtime deps
# jwt-decode is optional — add only when the fusion engine needs claim data:
# npm install jwt-decode
# Messaging glue (content script <-> service worker)
# Testing
# Types
# Lint (ESLint 9/10 flat config + type-aware TS rules)
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Build framework | WXT | CRXJS (Vite plugin) | CRXJS is Chromium-only (no first-party Firefox output) and gives you nothing beyond bundling — you'd hand-roll manifest cross-browser diffs, storage helpers, and test mocking yourself. Reasonable choice *only* if you want zero framework abstraction and are staying Chrome-only; this project's "Firefox-compatible" requirement rules it out. |
| Build framework | WXT | Plasmo | Uses Parcel (slower builds than Vite, larger output — ~2x in community benchmarks), community sentiment describes it as in "maintenance mode" with outdated dependencies as of 2026. Its React-first DX is nice if the extension needed a popup/options UI in React, but this MVP explicitly defers the popup UI. |
| Build framework | WXT | Raw esbuild + hand-written manifest.json | Viable for a tiny extension with no cross-browser target, but you'd reimplement manifest generation, dev-mode HMR, and test-mocking that WXT gives for free. Not worth it given the Firefox-compatibility requirement and the TDD-heavy process constraint (WXT's fake-browser is the single biggest testing time-saver here). |
| PSL library | tldts | psl | `psl` is far more widely downloaded (38M/week vs tldts's ~57M/week — comparable now, but historically psl was "the popular one") and marginally simpler API, but is ~1000x slower per parse and requires a valid hostname as input (no URL parsing built in), meaning more glue code. tldts also gets ~57M weekly downloads, so it's not a niche choice. |
| JWT handling | Hand-rolled shape check (+ optional jwt-decode) | `jose` / `jsonwebtoken` | Both are full JWT libraries built for *verifying and signing* tokens server-side. This project never validates a signature (it has no key, isn't the token issuer) — pulling in verification machinery for a shape heuristic is scope creep and unnecessary attack/bundle-size surface in a content script. |
| Test runner | Vitest | Jest | Jest requires `ts-jest`/`babel-jest` transform config, has no first-party WXT integration (you'd hand-write the `chrome`/`browser` mocks that `@webext-core/fake-browser` gives Vitest for free), and is measurably slower on Vite-based projects. There is no advantage to Jest here — skip it. |
| DOM test env | happy-dom (default) + jsdom (per-file fallback) | jsdom only | jsdom alone works but is 5-10x slower across the whole suite; given the MutationObserver-heavy DOM Sensor and Border Overlay tests will run frequently in a TDD loop, the speed difference matters more than jsdom's marginally more complete spec coverage, which you keep available per-file for the rare gap. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|--------------|
| **TypeScript 7.0.x** (`typescript@7.0.2`, GA July 8 2026) | Ships without a stable programmatic compiler API (arrives in TS 7.1); `typescript-eslint`'s type-aware rules crash under it and the team has explicitly closed TS7 support as "not planned" for now; peer-dependency ranges (`typescript >=4.8.4 <6.1.0`) block clean installs of `typescript-eslint@8.x` alongside it. This is a same-week landmine, not a stale-training-data assumption — verified against the TypeScript devblog and a live typescript-eslint GitHub issue on 2026-07-17. | `typescript@6.0.3` (latest 6.x — same strict defaults TS7 hard-adopted, but full tooling compatibility). Revisit once typescript-eslint ships official TS7 support or `@typescript/typescript6` compat-shim guidance is no longer needed. |
| **webextension-polyfill** (Mozilla's standalone npm package) as a manual dependency | WXT 0.20+ removed it as a default dependency because it "doesn't provide any value anymore" once you use WXT's own `wxt/browser` export, which already normalizes Chrome's callback API and Firefox's native promise API into one typed surface. Adding the raw polyfill on top is redundant weight and can conflict with WXT's own `browser` global. | `import { browser } from 'wxt/browser'` (or WXT auto-import) |
| **Chrome's blocking `webRequest`** (`extraInfoSpec: ['blocking']`) | Removed for regular installed MV3 extensions in Chrome (only available to force-installed enterprise policy extensions). Irrelevant anyway — this project only *observes* status codes/headers, never blocks/modifies requests. | Non-blocking `webRequest.onCompleted` / `onResponseStarted` (fully supported in Chrome MV3 — confirmed current, these are the "observational" APIs Google explicitly kept) or `declarativeNetRequest` if blocking/redirect behavior is ever needed (it isn't here). |
| **jsonwebtoken** (npm) | Node/server-oriented signing+verification library; assumes you hold a secret/public key to verify against, which this extension never has (and shouldn't — it's not the token issuer). Unnecessary bundle weight and misleading API surface (`verify()` implies a security guarantee this project doesn't and shouldn't make) for a content script that only needs a shape heuristic. | Hand-rolled shape check, or `jwt-decode` if claim inspection (not verification) is genuinely needed. |
| **CRXJS** for this specific project | Chromium-only by design (no Firefox manifest output), which directly conflicts with the "Firefox-compatible" constraint. Good tool, wrong project. | WXT |
| **Manifest V2** anywhere in the build | Chrome sunset MV2 for the vast majority of users in mid-2025/2026; Playwright (used for e2e here) no longer even loads MV2 extensions. Firefox still supports MV2 but there's no reason to target it given WXT can force MV3 output for Firefox too. | WXT with `manifestVersion: 3` set explicitly in `wxt.config.ts` (WXT's default is MV3-for-Chrome/MV2-for-Firefox-and-Safari, so this must be set explicitly to get one consistent MV3 manifest structure across both target browsers, as the project constraint requires) |
| **`tldts-experimental`** | Different default private-suffix handling than stable `tldts`; picking it without a specific documented need risks silently different eTLD+1 grouping behavior than what was tested. | Stable `tldts` |
## Stack Patterns by Variant
- Use WXT with `manifestVersion: 3` forced (don't rely on WXT's Firefox-defaults-to-MV2 behavior)
- Write all extension-API code against `browser.*` from `wxt/browser`, never the global `chrome.*` object, so the same code compiles/runs on both targets without branching
- Build both targets in CI (`wxt build -b chrome`, `wxt build -b firefox`) even though only Chrome MV3 is the near-term ship target, to catch Firefox-specific manifest/permission drift early
- Vitest + `@webext-core/fake-browser` is the fast inner loop for the ConfidenceEngine and each signal extractor (table-driven tests fit naturally — the design doc explicitly calls this out)
- Reserve Playwright e2e for the smaller number of "mock SPA: set cookie → verdict flips → border appears" integration scenarios and the manual 3-4-real-app pass, not for unit-level coverage
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `wxt@0.20.27` | `typescript@6.0.3` | WXT generates `.wxt/tsconfig.json`; not yet verified against TS7's native compiler as of this research date — stay on 6.x. |
| `typescript-eslint@8.64.0` | `typescript >=4.8.4 <6.1.0` | Explicitly excludes TS7 by peer-dep range as of this research date — this is the concrete evidence behind the TS7 avoidance above. |
| `vitest@4.1.10` | `wxt@0.20.27` via `wxt/testing/vitest-plugin` (`WxtVitest()`) | Plugin polyfills `import.meta.env.BROWSER`, aliases (`@/*`), and the fake browser API together — install both in lockstep, don't hand-configure Vitest separately. |
| `@playwright/test@1.61.1` | Chrome MV3 only for extension loading | Playwright dropped MV2 extension loading in 2026; irrelevant here since we're MV3-only, but don't attempt to e2e-test a Firefox MV2 build with Playwright — use manual/`web-ext run` testing for Firefox instead. |
| `@webext-core/fake-browser@1.5.2` | `@webext-core/messaging@3.0.2` | Same maintainer/monorepo family as WXT's own dependency (`webext-core`) — version them together and expect WXT's own `package.json` to pin compatible ranges when scaffolding via `wxt init`. |
## Sources
- Context7 `/wxt-dev/wxt` — unit testing (Vitest plugin, fake-browser), manifest/tsconfig generation, browser API typing (fetched 2026-07-17)
- [WXT official comparison](https://wxt.dev/guide/resources/compare) — framework positioning vs Plasmo/CRXJS
- [WXT unit testing guide](https://wxt.dev/guide/essentials/unit-testing) — Vitest + fake-browser setup verified
- [WXT e2e testing guide](https://wxt.dev/guide/essentials/e2e-testing) — Playwright + `.output/chrome-mv3` build output path
- [WXT TypeScript config guide](https://wxt.dev/guide/essentials/config/typescript) — `.wxt/tsconfig.json` extension pattern, `WebWorker` lib gap for service workers
- npm registry (`npm view <pkg> version`, checked live 2026-07-17) — exact current versions for wxt, vitest, typescript, @types/chrome, tldts, jwt-decode, @webext-core/fake-browser, @webext-core/messaging, typescript-eslint, eslint, playwright, psl
- [Announcing TypeScript 7.0 — devblogs.microsoft.com](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) — GA date (July 8, 2026), programmatic API deferred to 7.1
- [typescript-eslint TS7 support issue #12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518) — peer-dep incompatibility, "not planned" status — HIGH confidence, primary source
- [tldts GitHub benchmarks](https://github.com/remusao/tldts/blob/master/comparison/comparison.md) and [tldts README](https://github.com/remusao/tldts/blob/master/README.md) — performance vs `psl`, ICANN-vs-private suffix default behavior
- [chrome.webRequest — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/webRequest) and Chromium extensions group discussion on MV3 blocking-webRequest restriction — confirms non-blocking observational events remain available in MV3
- [Playwright Chrome extensions docs](https://playwright.dev/docs/chrome-extensions) and [Playwright Chrome Extension Testing (Manifest V3) Guide 2026](https://qaskills.sh/blog/playwright-chrome-extension-testing-manifest-v3-2026) — MV3-only extension loading, `launchPersistentContext` requirement, service worker suspension handling
- [jwt-decode npm](https://www.npmjs.com/package/jwt-decode) / [auth0/jwt-decode GitHub](https://github.com/auth0/jwt-decode) — non-validating decode confirmed, 4.0.0 stable for 3 years (no churn expected, JWT structure is a fixed spec)
- [happy-dom vs jsdom 2026 comparison — pkgpulse.com](https://www.pkgpulse.com/guides/happy-dom-vs-jsdom-2026) (MEDIUM confidence, single blog source, but corroborated by Vitest's own documented default and a Vitest GitHub discussion thread) — performance and `MutationObserver` support confirmation
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
