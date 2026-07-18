# Sign-In Detector — Browser Extension

A **Chrome MV3** (Firefox-compatible) browser extension that determines, per browser tab, whether the user is **signed in** to the webapp in that tab — and draws a **visible border** around the viewport when they are.

It works across arbitrary webapps with **zero per-app configuration**, and never relies on navigation events (webapps span many domains/URLs and are often SPAs).

## How it works

Detection fuses **four weak, independently-observed signals** into a single weighted-confidence verdict per tab (no single signal is trusted):

| Signal | Evidence of a session | Weight |
|--------|-----------------------|--------|
| **Cookie** | HttpOnly + Secure, high-entropy, long-expiry cookie scoped to the app (the extension `cookies` API reads HttpOnly cookies the page's own JS cannot) | high |
| **Network** | identity endpoint (`/me`, `/session`, GraphQL `viewer`) returns **200**; `Authorization: Bearer` present. **401/403 is a strong negative** | high |
| **Storage** | JWT-shaped values / `auth`·`session`·`token` keys in local/sessionStorage | medium |
| **DOM** | logout/account/avatar present **and** no password login surface | low |

The score crosses dual thresholds (0.7 / 0.3) with **hysteresis** and an **asymmetric logout debounce** to avoid flicker. Verdicts recompute on **events** (`cookies.onChanged`, `webRequest` responses, `MutationObserver`) — never on navigation. A webapp is identified by its **registrable domain (eTLD+1)**, so `api.`/`cdn.`/`www.` collapse into one logical app.

**Privacy:** all processing is local and in-memory — raw cookie/token values never cross the content-script ↔ service-worker boundary, are never persisted, and are never transmitted.

Full design: [`docs/superpowers/specs/2026-07-17-signin-detector-extension-design.md`](docs/superpowers/specs/2026-07-17-signin-detector-extension-design.md).

## Tech stack

WXT (Vite-based MV3 framework) · TypeScript 6.0.3 · Vitest + `@webext-core/fake-browser` · happy-dom · Playwright (e2e) · `tldts` (eTLD+1). See [`.planning/research/STACK.md`](.planning/research/STACK.md).

## Project structure

```
.planning/            GSD planning: PROJECT, REQUIREMENTS, ROADMAP, research/, phases/
docs/                 Design spec
src/                  Extension source (added during Phase 1)
  shared/  engine/  identity/  sensors/{cookie,network,storage,dom}/
```

Roadmap (5 phases, MVP): Detection Core → State & Persistence → Chrome Glue → Wiring & E2E → Validation. See [`.planning/ROADMAP.md`](.planning/ROADMAP.md).

## Development

This repo uses **git-flow**. `main` is production (protected — direct commits blocked by a pre-commit hook); `develop` is integration; work happens on `feature/*` branches.

```bash
git flow feature start <name>     # branch off develop
# ...work, commit...
git flow feature finish <name>    # merge back into develop

npm install
npm test        # Vitest unit/integration
npm run dev     # WXT dev build (loads unpacked extension)
```

## Status

Under active development via an autonomous, test-driven build. Detection core is planned first as pure, Chrome-API-free TypeScript (100% unit-testable) before any browser integration.

## License

MIT (or as specified by the repository owner).
