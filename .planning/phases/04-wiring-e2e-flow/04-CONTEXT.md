# Phase 4: Wiring & End-to-End Flow - Context

**Gathered:** 2026-07-17
**Status:** Ready for planning
**Mode:** Auto-accepted from research (autonomous — decisions locked by ARCHITECTURE.md/PITFALLS.md)

<domain>
## Phase Boundary

Assemble the Phase 1–3 components into a live extension: wire `entrypoints/background.ts` (service worker) and `entrypoints/content.ts` (content script), set the manifest permissions, so the full signal→verdict→border pipeline runs on real browser events.

**In scope:** RCT-01, PLT-03, PRV-01, PRV-02.
</domain>

<decisions>
## Implementation Decisions

### background.ts (service worker)
- **Synchronous top-level listener registration (PLT-03):** register `chrome.cookies.onChanged`, `chrome.webRequest.onCompleted`, `chrome.runtime.onMessage` (sensor signals from content), and `chrome.tabs.onRemoved` (→ `verdictStore.clear(tabId)`) at the TOP LEVEL of the module — never inside an async callback/`await` — so they survive SW restart (avoids the #1 MV3 anti-pattern).
- **Per-tab engine:** maintain a `ConfidenceEngine` per tab, rehydrating its snapshot from `verdictStore` on demand (SW may have restarted). Resolve the tab's `WebAppKey` from its top-frame URL via `resolveWebAppKey`.
- **Recompute loop (RCT-01):** on ANY signal event (cookie change, network completion, or a content sensor message), gather/refresh that signal's `SignalEvidence`, feed the engine, compute the `VerdictResult`, persist the engine snapshot to `verdictStore`, and `sendVerdictUpdate` to that tab's content script. Driven by events ONLY — no navigation listener drives detection, no polling/`setInterval`.

### content.ts (content script, top frame only)
- On load: instantiate the storage + DOM sensors → send their `SignalEvidence` via the one-shot messaging module; subscribe to verdict updates → drive `borderOverlay.show(state)` / `hide()`.
- Runs at `document_idle`, `all_frames: false` (top frame only), `matches: <all_urls>`.

### Manifest (wxt.config.ts)
- `permissions`: `cookies`, `webRequest`, `storage`, `scripting`. `host_permissions`: `<all_urls>`.
- Document the `<all_urls>` + `webRequest` Web-Store deep-review cost (known ship-timeline risk from research).

### Privacy (PRV-01, PRV-02)
- Only boolean/enum/number/verdict payloads cross the content↔SW boundary (already enforced by the frozen message types).
- The extension makes ZERO outbound network calls — no `fetch`/`XMLHttpRequest`/`WebSocket` anywhere in `src/` or `entrypoints/`. Only derived verdict/confidence values live in `chrome.storage.session`, cleared on tab close.

### Testing
- Integration tests with `@webext-core/fake-browser`: simulate the full loop — a session cookie appears (`cookies.onChanged`) → engine recomputes → `VERDICT_UPDATE` sent → (content side) overlay shows; then a 401 / cookie removal → overlay hides.
- PLT-03: a test that imports `background.ts` and asserts each `addListener` was called synchronously at import time.
- PRV-02: a grep-style test asserting no `fetch(`/`XMLHttpRequest`/`WebSocket` in `src/` + `entrypoints/`.
- `npm ci` in the worktree.
</decisions>

<code_context>
## Existing Code Insights

On `develop`: engine (+ serialize/restore), identity, pure classifiers (Phase 1); `verdictStore` (Phase 2); background sensors, content sensors, `messaging.ts`, `borderOverlay` (Phase 3). `entrypoints/background.ts` and `entrypoints/content.ts` currently exist as WXT stubs — replace their bodies with the real wiring. Reuse the messaging helpers from `src/content/messaging.ts` for both sides.
</code_context>

<specifics>
## Specific Ideas

- Keep entrypoints THIN — they compose already-tested units; put any non-trivial glue into a testable module under `src/background/` (e.g. a `pipeline.ts` orchestrator the entrypoint just starts) so it's unit-testable rather than trapped in the entrypoint.
- Registration must be synchronous; do lazy/async work (like reading storage) INSIDE the listener callbacks, not before registering them.
</specifics>

<deferred>
## Deferred Ideas

- Real-browser validation (Playwright + manual matrix) → Phase 5.
</deferred>
