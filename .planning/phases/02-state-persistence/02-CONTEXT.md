# Phase 2: State & Persistence - Context

**Gathered:** 2026-07-17
**Status:** Ready for planning
**Mode:** Auto-accepted from research (autonomous — decisions locked by ARCHITECTURE.md/SUMMARY.md)

<domain>
## Phase Boundary

Build `src/background/state/verdictStore.ts` — a `chrome.storage.session` adapter that persists per-tab verdict/hysteresis state so it survives service-worker suspension/restart. This is the ONLY Chrome API introduced this phase (`chrome.storage.session`, mocked in tests via `@webext-core/fake-browser`). No sensors, messaging, DOM, or overlay yet — those are Phase 3+.

**In scope:** PLT-01.
</domain>

<decisions>
## Implementation Decisions

- **Store shape:** key by tab id (+ WebAppKey) → the engine's persisted state (last `VerdictResult` + whatever hysteresis/debounce bookkeeping the engine needs to resume deterministically). Only DERIVED values (numbers/enums) — never raw session material (PRV-01 holds).
- **Backend:** `chrome.storage.session` (in-memory, cleared on browser exit; ~10MB). Rehydrate-on-demand: read the tab's state lazily on SW wake; never assume in-memory continuity.
- **API surface (async):** `get(tabId): Promise<PersistedVerdictState | undefined>`, `set(tabId, state): Promise<void>`, `clear(tabId): Promise<void>` (called on tab close), and a safe default → `Unknown` when absent (must not throw).
- **Engine integration:** the ConfidenceEngine from Phase 1 stays the pure fusion authority; this store only persists/rehydrates its state. If the engine needs a serializable state snapshot, add a pure `serialize`/`restore` seam in the engine rather than leaking storage concerns into it (keep SOLID boundaries).
- **Testing:** TDD with `@webext-core/fake-browser` — set→restart(simulated: new store instance over same fake storage)→get returns state; clear removes it; missing tab → Unknown default, no throw. Use `npm ci` in the worktree.
</decisions>

<code_context>
## Existing Code Insights

Phase 1 is on `develop`: `src/shared/types.ts` (`VerdictResult`, `VerdictState`, `WebAppKey`), `src/engine/confidenceEngine.ts`. Reuse those types. WXT + Vitest + `@webext-core/fake-browser` already in devDeps (from Phase 1 scaffold). New dir: `src/background/state/`.
</code_context>

<specifics>
## Specific Ideas

- Keep the store a thin, single-responsibility adapter behind a small interface so Phase 4 wiring can inject it and tests can fake it.
- Serialize only what's needed to resume hysteresis + asymmetric-debounce correctly across a SW restart.
</specifics>

<deferred>
## Deferred Ideas

- Cross-tab verdict sharing by WebAppKey → v1.x (each tab converges independently for MVP).
</deferred>
