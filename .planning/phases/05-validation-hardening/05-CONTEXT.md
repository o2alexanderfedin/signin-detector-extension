# Phase 5: Validation & Hardening - Context

**Gathered:** 2026-07-17
**Status:** Ready for planning
**Mode:** Auto-accepted from research (autonomous). Note: several criteria are inherently human/manual.

<domain>
## Phase Boundary

Prove the assembled pipeline works under the conditions that make sign-in detection silently fail, and harden. No new REQ-IDs — validates ENG/SEN/IDN/RCT/BDR/PLT/PRV end-to-end.

**Automatable here:**
- **Playwright e2e** (criterion 1): load the built unpacked extension into Chromium, drive a LOCAL mock page (sets a session-like cookie + an identity endpoint returning 200/401), assert the closed-shadow border host appears on "sign-in" and disappears on "sign-out", including a same-eTLD+1 in-app route/hash change that must NOT thrash the verdict.
- **Privacy audit** (criterion 5): a runnable audit (script + the existing `privacyAudit.test.ts`) proving zero raw cookie/token values are logged/stored/transmitted and zero outbound calls.

**Inherently manual (documented as a human-verification checklist, NOT executable in this sandbox):**
- Criterion 2: real apps (a Google property, GitHub, a plain cookie-session app); verdict survives 60s+ SW idle with DevTools closed; no false border on a cookie-banner-only news site.
- Criterion 3: CSP/Trusted-Types-strict site (bank/enterprise SaaS) renders the border without a CSP violation; fullscreen app confirms the accepted Top-Layer limitation.
- Criterion 4: a real OAuth ("Sign in with Google/GitHub") flow settles to signed-in after redirect.
</domain>

<decisions>
## Implementation Decisions

- **Playwright harness:** `tests/e2e/playwright/` with a config that launches `chromium.launchPersistentContext` loading `.output/chrome-mv3` (build first). A tiny local fixture (static HTML + a mock cookie/identity route, or `context.route`) simulates signed-in/out. Use `@playwright/test 1.61.1` (already pinned). Keep it as a separate `test:e2e` script so it doesn't run in the unit `vitest` lane.
- **If Chromium cannot launch in this sandbox** (no display / restricted): still deliver the complete, runnable Playwright test + config + fixtures and a note that it runs in a real environment; the fake-browser `fullLoop.test.ts` (Phase 4) already proves the same loop deterministically. Do NOT fake a "pass".
- **Manual matrix:** write `docs/MANUAL-TESTING.md` — the human checklist (the 3 manual criteria above) with exact steps + expected results, plus the known Top-Layer / CHIPS / Web-Store-review limitations.
- **Hardening:** codify the privacy audit as an `npm run audit:privacy` script; document the accepted limitations; optionally run non-breaking `npm audit` review (do not `--force`).
- `npm ci` in the worktree; keep the full unit suite green.
</decisions>

<code_context>
## Existing Code Insights

On `develop`: full pipeline (entrypoints + src), 186 passing unit/integration tests incl. `tests/e2e/fullLoop.test.ts` (fake-browser end-to-end) and `src/shared/privacyAudit.test.ts`. `wxt build` emits `.output/chrome-mv3`. `@playwright/test` is a pinned devDependency.
</code_context>

<specifics>
## Specific Ideas

- The Playwright test must load the REAL built extension (not a mock) so it exercises actual MV3 service-worker + content-script behavior — that's the point of this phase.
- Be honest in the VERIFICATION about which criteria are automated-green vs human-pending.
</specifics>

<deferred>
## Deferred Ideas

- Weight/threshold calibration against real usage → v1.x.
- Top-Layer defeat handling, CHIPS/partitioned cookies, multi-domain clustering → documented limitations / v1.x.
</deferred>
