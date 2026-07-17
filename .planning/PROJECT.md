# Sign-In Detector Browser Extension

## What This Is

A browser extension (Chrome MV3, Firefox-compatible) that continuously determines, per browser tab, whether the user is **signed in** to the webapp occupying that tab, and draws a **visible border** around the viewport when they are. It works across arbitrary webapps with zero per-app configuration, and does not rely on navigation events to make the determination.

## Core Value

Correctly distinguish "signed in" from "not signed in" for **any** webapp — without per-app rules and without depending on navigations — and reflect that state as a visible border.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Detect signed-in vs not-signed-in state for a webapp, generically (no per-app config)
- [ ] Fuse four signal classes — cookies (backbone), network status codes, storage tokens, DOM markers — into a confidence verdict
- [ ] Recompute the verdict on events (cookie change, network response, DOM mutation), NOT on navigation
- [ ] Treat a webapp as one logical app across its many domains/URLs (registrable-domain identity)
- [ ] Draw a visible border around the viewport when signed in, resilient to SPA re-renders
- [ ] Keep all processing local — never transmit or persist raw session material

### Out of Scope

- Identifying WHO is signed in (account identity) — not needed for the border signal
- Per-app rule packs / filter lists — the whole point is zero-config
- Modifying, blocking, or proxying the webapp — read-only observation
- Popup UI, least-privilege per-site permission mode, OAuth-IdP grace rule — deferred post-MVP to keep scope small

## Context

- **Deliverable evolution:** Started as a design-doc exercise (interview-style); design approved and committed at `docs/superpowers/specs/2026-07-17-signin-detector-extension-design.md`. Now building toward an MVP implementation.
- **Key technical insight:** an extension's `cookies` API can read `HttpOnly` session cookies that the page's own JS cannot — this is the backbone signal and the reason zero-config generic detection is feasible.
- **Manifest V3 constraints:** `webRequest` can observe headers and status codes but cannot easily read response bodies, so network detection is status-code/header based (200 vs 401/403), not payload parsing.

## Constraints

- **Tech stack**: Chrome MV3 extension (service worker + content script), Firefox-compatible. TypeScript, strongly typed, strict.
- **Timeline**: Limited — MVP-sized scope, delivered on time. Favor parallel work streams.
- **Privacy/Security**: Local-only processing; raw cookie/token values never leave the service worker, never persisted, never transmitted. No outbound network calls from the extension.
- **Permissions**: `cookies`, `webRequest`, `scripting`, `storage`, host access (`<all_urls>` for MVP). Broad host access is the main trust cost — stated up front.
- **Process**: TDD, SOLID, KISS, DRY, YAGNI, TRIZ. Rival subagents, Google AI mode consults, worktree isolation, workflow orchestration.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Signal-fusion confidence engine (Approach A) over network-only or DOM-only | No single signal is reliable across arbitrary apps; fusion degrades gracefully | — Pending |
| Cookies as the backbone signal | Extension can read HttpOnly session cookies the page cannot | — Pending |
| Event-driven recompute (cookies.onChanged, webRequest, MutationObserver) | Satisfies "cannot rely on navigation"; works on SPAs/multi-domain | — Pending |
| Registrable-domain (eTLD+1) app identity | Collapses api/cdn/www subdomains into one logical webapp | — Pending |
| Zero-config heuristics (not per-app rule packs) | Requirement: "work for a variety of webapps" | — Pending |
| MVP scope: defer popup, least-privilege mode, OAuth grace | Limited time; keep to smallest thing that satisfies requirements | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-17 after initialization*
