# Sign-In Detector — Browser Extension

A **Chrome MV3** (Firefox-compatible) browser extension that determines, per browser tab, whether the user is **signed in** to the webapp in that tab — and draws a **visible border** around the viewport when they are.

It works across arbitrary webapps with **zero per-app configuration**, and never relies on navigation events (webapps span many domains/URLs and are often SPAs).

> **About this project** — Built as an **interview exercise for the Microsoft Edge group**. It is an independent proof-of-concept: **not affiliated with, endorsed by, or an official product of Microsoft**. The full path from the one-line prompt to this release — design, research (including an unbiased second-opinion consult), a 5-phase roadmap, and a test-driven implementation — was produced with an AI agent workflow and is preserved under [`.planning/`](.planning/) and [`docs/`](docs/) for transparency.

## How it works

Detection fuses **four weak, independently-observed signals** into a single weighted-confidence verdict per tab (no single signal is trusted):

| Signal | Evidence of a session | Weight |
|--------|-----------------------|--------|
| **Cookie** | HttpOnly + Secure, high-entropy, long-expiry cookie scoped to the app (the extension `cookies` API reads HttpOnly cookies the page's own JS cannot) | high |
| **Network** | identity endpoint (`/me`, `/session`, GraphQL `viewer`) returns **200**; `Authorization: Bearer` present. **401/403 is a strong negative** | high |
| **Storage** | JWT-shaped values / `auth`·`session`·`token` keys in local/sessionStorage | medium |
| **DOM** | logout/account/avatar present **and** no password login surface | low |

The score crosses dual thresholds (0.7 / 0.3) with **hysteresis** and an **asymmetric logout debounce** to avoid flicker. Verdicts recompute on **events** (`cookies.onChanged`, `webRequest` responses, `MutationObserver`) — never on navigation. A webapp is identified by its **registrable domain (eTLD+1)**, so `api.`/`cdn.`/`www.` collapse into one logical app.

**Privacy:** all processing is local and in-memory — raw cookie/token values never cross the content-script ↔ service-worker boundary, are never persisted, and are never transmitted. The extension makes **zero outbound network calls**.

Full design: [`docs/superpowers/specs/2026-07-17-signin-detector-extension-design.md`](docs/superpowers/specs/2026-07-17-signin-detector-extension-design.md).

## Architecture

MV3's process split forces the shape: `cookies`/`webRequest` are service-worker-only, `localStorage`/DOM are content-script-only, so the **ConfidenceEngine lives in the service worker as the sole fusion authority**, fed by one-shot typed messages. Verdict state is persisted to `chrome.storage.session` so it survives service-worker suspension.

```
src/
  shared/        types (discriminated-union signal evidence, branded WebAppKey) + named constants
  engine/        confidenceEngine — weighted fusion, hysteresis, asymmetric debounce, serialize/restore
  identity/      appIdentity — eTLD+1 via tldts → branded WebAppKey
  sensors/       pure, shape-only classifiers: cookie · network · storage · dom
  background/    Chrome glue: sensors, verdictStore (chrome.storage.session), pipeline (per-tab engine)
  content/       storage/DOM sensors, one-shot messaging, closed-Shadow-DOM border overlay
entrypoints/     background.ts (SW) + content.ts — thin wiring; synchronous listener registration
tests/e2e/       fake-browser full-loop + real-browser Playwright
.planning/       PROJECT · REQUIREMENTS · ROADMAP · research/ · phases/ (design + verification trail)
docs/            design spec + MANUAL-TESTING.md
```

## Tech stack

WXT 0.20.27 (Vite-based MV3 framework) · TypeScript 6.0.3 · Vitest + `@webext-core/fake-browser` · happy-dom · `@playwright/test` (real-browser e2e) · `tldts` (eTLD+1). Rationale + pinned versions: [`.planning/research/STACK.md`](.planning/research/STACK.md).

## Build & run

```bash
npm install
npm test            # Vitest unit/integration suite (186 tests)
npm run test:e2e    # Playwright e2e — loads the real built extension in Chromium
npm run audit:privacy   # asserts no outbound calls / no raw-value leakage
npm run build       # WXT build → .output/chrome-mv3  (also: npm run build -- -b firefox)
npm run dev         # WXT dev build with HMR
```

**Load unpacked (Chrome/Edge):** `npm run build`, then open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, **Load unpacked**, and select `.output/chrome-mv3`. Sign in to any site and a green border appears; sign out and it clears.

**Prebuilt install package:** each tagged release ships packaged zips on the [Releases](https://github.com/o2alexanderfedin/signin-detector-extension/releases) page (built & published by CI). Download `sign-in-detector-<version>-chrome-mv3.zip` (or the Firefox zip), extract, and **Load unpacked** the extracted folder — or upload the zip to the Chrome/Edge Web Store / Firefox AMO.

## Status

**MVP feature-complete (v0.1.0).** All 5 phases built test-first: Detection Core → State & Persistence → Chrome Glue → Wiring & E2E → Validation. **186 unit/integration tests + real-browser Playwright e2e (5/5) green**; `tsc` strict + `eslint` clean; Chrome **and** Firefox builds succeed.

**Pending human validation** (needs real accounts/browsers) — see [`docs/MANUAL-TESTING.md`](docs/MANUAL-TESTING.md): real Google/GitHub/OAuth sign-in, 60s+ service-worker-idle survival, CSP/Trusted-Types-strict sites, fullscreen (CSS Top-Layer limitation).

**v1.x follow-ups:** weight/threshold calibration, OAuth-IdP grace, least-privilege permission mode, Firefox polish.

## Development

This repo uses **git-flow**. `main` is production (protected — direct commits blocked by a pre-commit hook); `develop` is integration; work happens on `feature/*` branches.

```bash
git flow feature start <name>     # branch off develop
# ...work, commit...
git flow feature finish <name>    # merge back into develop
```

## License

[MIT](LICENSE) © 2026 Alexander Fedin.
