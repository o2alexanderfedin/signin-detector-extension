---
phase: 5
status: passed
verified: 2026-07-17
tests: 186 unit + Playwright e2e (5/5 real-browser)
human_verification: pending (documented in docs/MANUAL-TESTING.md)
---

# Phase 5: Validation & Hardening — Verification

**Result:** ✅ PASSED (automated criteria green). Manual real-site criteria are documented as a human-verification checklist — see `docs/MANUAL-TESTING.md`.

## Success criteria (from ROADMAP)

1. ✅ **Playwright e2e** — real built extension in real headless Chromium: session cookie → border shows; same-eTLD+1 route/hash change → border stays (no thrash); cookie cleared/401 → border removed. Ran **5/5 green** (a genuine SW-startup race was found and fixed during verification).
2. ⏳ **Human-pending** — real Google/GitHub/plain-cookie apps; 60s+ SW-idle survival with DevTools closed; no false border on a cookie-banner-only news site. *(Cannot be automated in this sandbox — checklist in `docs/MANUAL-TESTING.md`.)*
3. ⏳ **Human-pending** — CSP/Trusted-Types-strict site renders border without violation; fullscreen Top-Layer limitation confirmed. *(Manual.)*
4. ⏳ **Human-pending** — real OAuth ("Sign in with Google/GitHub") settles to signed-in after redirect. *(Manual.)*
5. ✅ **Privacy audit** — `npm run audit:privacy` PASS (18 files, zero outbound calls, zero raw-value leakage at the messaging boundary) + `privacyAudit.test.ts`.

## Gates

| Gate | Result |
|------|--------|
| Unit + integration tests | 186 passing / 0 failing |
| Playwright e2e (real browser) | 5/5 green (headless Chromium, real extension) |
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `npm run audit:privacy` | PASS |
| `wxt build` (Chrome + Firefox) | succeed |
| `npm audit` | 10 transitive **dev-tooling** advisories (WXT/Vite chain) — none shipped in the extension; `--force` deliberately not run |

## Automated-green vs Human-pending

- **Automated-green:** Playwright e2e (real extension/real Chromium), `fullLoop.test.ts` (fake-browser), privacy audit (script + vitest), full unit suite, both browser builds.
- **Human-pending (documented, not blocking the build):** the six real-site items in `docs/MANUAL-TESTING.md` — require a human with real accounts/browsers.

**Recommendation:** ship-ready for a human validation pass against `docs/MANUAL-TESTING.md`; that pass + weight/threshold calibration are the v1.x follow-ups.
