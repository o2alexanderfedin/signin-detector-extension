# Phase 3: Chrome Glue — Sensors, Messaging & Border Overlay - Context

**Gathered:** 2026-07-17
**Status:** Ready for planning
**Mode:** Auto-accepted from research (autonomous — decisions locked by ARCHITECTURE.md/PITFALLS.md/SUMMARY.md)

<domain>
## Phase Boundary

Connect the pure Phase-1 detection core (+ Phase-2 verdictStore) to real Chrome APIs, and render the border. Build the *components* — the end-to-end wiring/listener-registration is Phase 4.

**In scope:** PLT-02, BDR-01, BDR-02, BDR-03, BDR-04.

Three disjoint workstreams:
1. **Background sensor glue** — `src/background/sensors/cookieSensor.ts` (`chrome.cookies.getAll` + `chrome.cookies.onChanged`) and `networkSensor.ts` (`chrome.webRequest.onCompleted`, status/header only). Each reads real Chrome data → calls the corresponding PURE `classify.ts` from Phase 1 → returns/emits a `SignalEvidence`. The ConfidenceEngine stays the sole fusion authority (these glue modules never fuse; they only produce evidence).
2. **Content sensor glue + messaging** — `src/content/sensors/storageSensor.ts` (reads local/sessionStorage → pure storage classify) and `domSensor.ts` (builds a boolean DOM snapshot + debounced `MutationObserver` → pure dom classify), plus `src/content/messaging.ts` (typed one-shot send using `@webext-core/messaging`, and a SW-side receiver helper). Content sensors send their `SignalEvidence` to the SW via a single one-shot typed message per event (PLT-02) — no long-lived port.
3. **Border overlay** — `src/content/overlay/borderOverlay.ts`: renders a viewport-edge border in a **closed Shadow DOM**, built with `document.createElement` + CSSOM property assignment ONLY (never `innerHTML`/`style.cssText`), re-asserted by a `MutationObserver`, shown on `SignedIn` and removed otherwise.
</domain>

<decisions>
## Implementation Decisions

- **Reuse, don't reimplement:** every sensor glue module imports and calls its Phase-1 pure `classify.ts`. Glue = "get real data → normalize → hand to classifier". No detection logic in the glue.
- **Messaging (PLT-02):** one-shot `runtime.sendMessage` via `@webext-core/messaging` typed protocol; message payloads are the frozen boolean/enum/number contracts from `shared/types.ts` — NO raw cookie/token values cross the boundary (PRV-01 holds here too). Content→SW only for sensor signals; SW→content for verdict updates (used by the overlay).
- **Border overlay (BDR-01..04):**
  - `position: fixed; inset: 0; pointer-events: none; z-index: 2147483647` inset border via CSSOM.
  - Closed Shadow DOM host attached to `document.documentElement`; top frame only (`window.top === window`).
  - `createElement` + `.style.setProperty` / CSSOM — never string injection (survives Trusted-Types/CSP-strict sites, per PITFALLS.md).
  - `MutationObserver` re-asserts the host if the page removes/reorders it (BDR-03); debounced.
  - `show(state)` / `hide()`; border present only when `SignedIn`, removed promptly otherwise (BDR-04).
  - **Accepted limitation (documented, not fixed in MVP):** the CSS Top Layer (`<dialog>`, Popover, fullscreen) can render above the border — noted in PITFALLS.md, validated/acknowledged in Phase 5.
- **Testing:** TDD. Chrome-API glue tested with `@webext-core/fake-browser`; overlay tested with `happy-dom` (asserts closed shadow root, edge elements, no `innerHTML` usage, MutationObserver re-assertion, show/hide). `npm ci` in the worktree.
</decisions>

<code_context>
## Existing Code Insights

On `develop`: Phase 1 pure classifiers (`src/sensors/*/classify.ts`), engine, identity; Phase 2 `src/background/state/verdictStore.ts` + engine serialize seam. Message contracts already exist in `src/shared/types.ts` (`SensorSignalMessage`, `VerdictUpdateMessage`, etc.). `@webext-core/messaging` is a listed dependency. New dirs: `src/background/sensors/`, `src/content/sensors/`, `src/content/messaging.ts`, `src/content/overlay/`.
</code_context>

<specifics>
## Specific Ideas

- Keep each glue module a thin adapter with a single responsibility and an injectable dependency (the chrome namespace / the classifier) so it's unit-testable and Phase-4 can wire it.
- Overlay must be idempotent (calling show twice doesn't duplicate the host) and clean up its MutationObserver on hide.
- Purity rule still applies to Phase-1 dirs: do NOT add chrome imports to `src/engine`, `src/identity`, `src/sensors/*/classify.ts` — the glue lives in `src/background/` and `src/content/`.
</specifics>

<deferred>
## Deferred Ideas

- End-to-end wiring (listener registration in background.ts/content.ts, event-driven recompute loop) → Phase 4.
- Unknown-state border styling, Top-Layer defeat handling → v1.x / documented limitation.
</deferred>
