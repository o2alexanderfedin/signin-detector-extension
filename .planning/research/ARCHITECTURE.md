# Architecture Research

**Domain:** Chrome MV3 extension — cross-context signal fusion (service worker + content script)
**Researched:** 2026-07-17
**Confidence:** HIGH (all MV3 lifecycle/messaging/API claims verified against Chrome for Developers docs; DOM/storage classifier design is project-specific, MEDIUM)

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE WORKER (background, non-persistent, dies after ~30s idle)    │
│                                                                        │
│  ┌───────────────┐   ┌───────────────┐                                │
│  │ Cookie Sensor  │   │ Network Sensor │   (direct in-process calls)  │
│  │ cookies API +  │   │ webRequest     │───────┐                      │
│  │ onChanged      │   │ onCompleted/   │       │                      │
│  └──────┬────────┘   │ onErrorOccurred│       │                      │
│         │             └──────┬─────────┘       │                      │
│         └────────────────────┴─────────────────▼                      │
│                    ┌────────────────────────────────┐                 │
│                    │      ConfidenceEngine            │                │
│                    │  updateSignal(appKey, sig, val)  │                │
│                    │  fusion + hysteresis (pure)      │                │
│                    └───────────────┬──────────────────┘                │
│                                    │ read/write               ▲        │
│                       ┌────────────▼───────────┐   (message)  │        │
│                       │ VerdictStore             │◄────────────┘        │
│                       │ chrome.storage.session   │   messaging/router   │
│                       │ {appKey/tabId → verdict} │   (onMessage)        │
│                       └───────────────────────────┘                    │
└───────────────────────────────────▲──────────────────────┬────────────┘
                    one-shot msg     │                      │ one-shot msg
              SENSOR_SIGNAL/GET_VERDICT              VERDICT_UPDATE
                    (content → SW)    │                      │ (SW → content)
┌───────────────────────────────────┴──────────────────────▼────────────┐
│  CONTENT SCRIPT (top frame, lives as long as the document does)        │
│                                                                        │
│  ┌────────────────┐   ┌───────────────────┐   ┌──────────────────┐    │
│  │ Storage Sensor  │   │ DOM Sensor          │   │ Border Overlay    │  │
│  │ local/session-  │   │ MutationObserver    │──▶│ closed Shadow DOM │  │
│  │ Storage scan    │   │ (debounced)         │   │ position:fixed    │  │
│  └────────────────┘   └───────────────────┘   └──────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Runs in | Chrome APIs |
|-----------|----------------|---------|--------------|
| Cookie Sensor | Read cookies for a tab's registrable domain, classify shape (HttpOnly+Secure+long-expiry+high-entropy) → number\|null; subscribe to `cookies.onChanged` | SW | `cookies` |
| Network Sensor | Observe identity-endpoint requests (`/me`, `/session`, GraphQL `viewer`), classify status/header → number\|null | SW | `webRequest` |
| AppIdentity resolver | URL → eTLD+1 (registrable domain), tab → appKey mapping, tab lifecycle tracking | SW | `tabs` (bundled PSL data, no network fetch — MV3 forbids remote code) |
| ConfidenceEngine | Fuse weighted signals (only over observed ones), apply hysteresis state machine, own the single verdict per appKey | SW | none (pure) |
| VerdictStore | Persist `{appKey/tabId → SignalVector + verdict}` across SW restarts; clear on tab close | SW | `storage.session`, `tabs.onRemoved` |
| Messaging Router | Dispatch inbound `SENSOR_SIGNAL`/`GET_VERDICT` to engine/store; push `VERDICT_UPDATE` to the right tab | SW | `runtime.onMessage`, `tabs.sendMessage` |
| Storage Sensor | Scan local/sessionStorage for JWT-shaped/auth-keyed values → number\|null | Content script | `localStorage`/`sessionStorage` (page-exposed, no chrome API) |
| DOM Sensor | Debounced MutationObserver scanning for logout/account UI vs password-login form → number\|null | Content script | DOM only |
| Border Overlay | Render/re-assert closed-Shadow-DOM border on verdict change and on DOM re-render | Content script | DOM only |

## Recommended Project Structure

```
src/
├── shared/
│   ├── types.ts              # Message envelope unions, SignalVector, Verdict — single contract
│   └── constants.ts          # Weights, hysteresis thresholds (0.7/0.3), debounce timings
├── engine/
│   └── confidenceEngine.ts   # Pure: fusion + hysteresis state machine (no Chrome API)
├── identity/
│   └── appIdentity.ts        # Pure: url → eTLD+1 (bundled PSL via `tldts`), tab tracking wrapper
├── background/
│   ├── sensors/
│   │   ├── cookieSensor.classify.ts   # pure classifier (input: cookie[], output: number|null)
│   │   ├── cookieSensor.ts            # chrome.cookies glue
│   │   ├── networkSensor.classify.ts  # pure classifier (input: {status,url,headers})
│   │   └── networkSensor.ts           # chrome.webRequest glue
│   ├── state/
│   │   └── verdictStore.ts   # chrome.storage.session adapter, rehydrate-on-demand
│   ├── messaging/
│   │   └── router.ts         # onMessage dispatch + tabs.sendMessage push
│   └── background.ts         # entry: registers ALL listeners synchronously at top level
├── content/
│   ├── sensors/
│   │   ├── storageSensor.classify.ts  # pure classifier (input: key/value dump)
│   │   ├── storageSensor.ts           # localStorage/sessionStorage read glue
│   │   ├── domSensor.classify.ts      # pure classifier (input: DOM snapshot/selectors)
│   │   └── domSensor.ts               # MutationObserver glue
│   ├── overlay/
│   │   └── borderOverlay.ts  # closed Shadow DOM renderer (jsdom-testable, no chrome API)
│   └── content.ts            # entry: wires sensors + overlay + messaging
└── manifest.json
```

### Structure Rationale

- **`shared/` first:** message contracts are the seam between two independently-restarting runtimes (SW dies, content script doesn't) — get the types right before either side is built.
- **`*.classify.ts` split from `*.ts` in every sensor:** separates the pure decision logic (unit-testable with fixtures, no browser needed) from the Chrome API glue (thin, tested via integration/mocked-API tests). This is the single biggest lever for TDD velocity in this codebase — the classifiers are where the actual detection logic and risk live; the glue is boilerplate.
- **`engine/` and `identity/` have zero Chrome API imports:** they're plain TypeScript, testable with `vitest`/`jest` directly, buildable and testable before a single line of extension-glue code exists.

## Architectural Patterns

### Pattern 1: SW-restart-safe verdict state (storage-backed, not memory-backed)

**What:** The service worker is *not* a long-running process — Chrome terminates it after ~30s of inactivity, and receiving an event or calling an extension API resets the idle timer, but the worker still restarts routinely during normal browsing (idle tabs, long gaps between signals). Any state held only in a top-level `let`/`Map` is wiped on restart. [HIGH confidence — developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle]

**When to use:** Any per-tab/per-app verdict, SignalVector, or hysteresis "previous state" that must survive across the *inevitable* multiple SW restarts during a single tab's lifetime.

**Trade-offs:** `chrome.storage.session` is in-memory (not written to disk, cleared when the browser exits) with an ~10 MB quota — appropriate for this project's "never persist raw session material" constraint, since only aggregate confidence numbers (not raw cookie/token values) go into it. Slight latency cost (`await`) vs a raw in-memory read, negligible for a UI-facing verdict.

**Example:**
```typescript
// state/verdictStore.ts
export async function getVerdict(tabId: number): Promise<StoredVerdict | undefined> {
  const key = `verdict:${tabId}`;
  const result = await chrome.storage.session.get(key);
  return result[key];
}

export async function setVerdict(tabId: number, v: StoredVerdict): Promise<void> {
  await chrome.storage.session.set({ [`verdict:${tabId}`]: v });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`verdict:${tabId}`); // per design doc §7: cleared on tab close
});
```

By default `chrome.storage.session` is only readable from trusted contexts (SW, extension pages) — **do not** call `setAccessLevel(TRUSTED_AND_UNTRUSTED_CONTEXTS)`; the content script never needs direct storage access because it only talks to the SW via messages, so keeping the default access level minimizes attack surface. [HIGH confidence — developer.chrome.com/docs/extensions/reference/api/storage]

### Pattern 2: One-shot messaging only — no long-lived ports

**What:** Use `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` (one-shot, request/response via `sendResponse` or a `Promise`) for both directions of content-script ↔ service-worker communication. Do **not** use `chrome.runtime.connect` long-lived ports for this project.

**When to use:** Any signal push, verdict push, or "give me current state" query between contexts.

**Trade-offs:** Chrome's post-Chrome-110 behavior is that *opening* a port no longer resets/holds the SW idle timer by itself, and a port silently disconnects (fires `onDisconnect`) whenever the SW is terminated — the content script would need reconnect logic on every restart with no material benefit for this project's event cadence (bursty, infrequent signal pushes, not a stream). One-shot `sendMessage` reliably wakes a terminated SW to deliver the message and resets the idle timer on receipt, which is exactly the delivery guarantee needed here. Ports would only pay off for high-frequency continuous streaming, which this system doesn't have. [HIGH confidence for termination/reset semantics — developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle; MEDIUM for the "no benefit here" judgment — project-specific reasoning]

**Example:**
```typescript
// content/content.ts — one-shot push, no port
chrome.runtime.sendMessage({ type: 'SENSOR_SIGNAL', signal: 'dom', value: 0.8 } satisfies SensorSignalMsg);

// background/messaging/router.ts — sender.tab.id is Chrome-provided, not spoofable
chrome.runtime.onMessage.addListener((msg: ExtensionMessage, sender, sendResponse) => {
  if (msg.type === 'SENSOR_SIGNAL' && sender.tab?.id != null) {
    engine.updateSignal(sender.tab.id, msg.signal, msg.value);
    return false; // no async response needed
  }
  if (msg.type === 'GET_VERDICT' && sender.tab?.id != null) {
    getVerdict(sender.tab.id).then(sendResponse);
    return true; // keep channel open for async sendResponse
  }
});
```

### Pattern 3: Single fusion authority, dual signal-origin paths

**What:** `ConfidenceEngine` is the *only* component that computes a verdict, and it lives entirely in the service worker. Cookie Sensor and Network Sensor call `engine.updateSignal()` **directly** (same process, in-process function call — no message needed since they already run in the SW). Storage Sensor and DOM Sensor run in the content script and can only reach the engine via `runtime.sendMessage` (`SENSOR_SIGNAL`), landing in the Messaging Router which calls the same `engine.updateSignal()`. Both paths converge on one function signature — the engine is transport-agnostic.

**When to use:** Always for this project — it is the direct consequence of `cookies`/`webRequest` being background-context-only APIs while `localStorage`/DOM are page-context-only.

**Trade-offs:** Keeps the privacy-sensitive fusion logic (and the only place hysteresis state lives) in a single location, easy to unit-test in total isolation from Chrome APIs. Cost: content-script-origin signals are one message-hop staler than SW-origin signals (typically single-digit ms, not user-visible given the 0.3–0.7 hysteresis hold band).

**Message shape (shared/types.ts):**
```typescript
type SignalName = 'cookie' | 'network' | 'storage' | 'dom';

interface SensorSignalMsg {
  type: 'SENSOR_SIGNAL';
  signal: Extract<SignalName, 'storage' | 'dom'>; // only content-script-origin signals travel this way
  value: number | null;
}

interface GetVerdictMsg { type: 'GET_VERDICT'; }

interface VerdictUpdateMsg {
  type: 'VERDICT_UPDATE';
  state: 'signed-in' | 'signed-out' | 'unknown';
  confidence: number;
}

type ExtensionMessage = SensorSignalMsg | GetVerdictMsg;
```

`SignalVector` (engine/store internal state, never sent to content script as raw values — only the fused verdict crosses the boundary outward):
```typescript
interface SignalVector {
  cookie: number | null;
  network: number | null;
  storage: number | null;
  dom: number | null;
  updatedAt: Partial<Record<SignalName, number>>;
}
```

### Pattern 4: webRequest for observation, not declarativeNetRequest

**What:** Use `chrome.webRequest.onCompleted` (+ `onErrorOccurred`) in non-blocking mode to read `statusCode` and (with `extraHeaders` in `opt_extraInfoSpec`) response headers for identity-endpoint requests.

**When to use:** Network Sensor's entire purpose — classify 200 vs 401/403 on `/me`/`/session`/GraphQL-viewer-shaped requests, and detect `Authorization: Bearer` presence.

**Trade-offs — why not declarativeNetRequest:** `declarativeNetRequest` (DNR) is a *declarative rule matcher* for blocking/redirecting/modifying requests before/during dispatch (`getMatchedRules` reports which static rule fired, gated behind the `feedback` permission and rate-limited) — it does not expose response status codes or give your JS a callback with response details for arbitrary traffic. It is the wrong tool for observability; it would silently produce no network signal. `webRequestBlocking` (the ability to synchronously block/modify) is restricted to force-installed enterprise extensions in MV3, but plain non-blocking observation via `webRequest` is unchanged and fully available to normal (Chrome-Web-Store) MV3 extensions — this is exactly the mode this project needs, since it only reads status/headers and never blocks or modifies. [HIGH confidence — developer.chrome.com/docs/extensions/reference/api/webRequest; developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests]

**Critical gotcha:** `chrome.webRequest.onCompleted.addListener(...)` (like `chrome.cookies.onChanged`, `chrome.tabs.onRemoved`, `chrome.runtime.onMessage`) **must be registered synchronously at the top level** of `background.ts`, during the service worker's initial script evaluation — not inside an `async` function after an `await`, and not behind a conditional. If registration is deferred, Chrome may fail to re-attach the listener on the next SW restart, silently breaking the sensor after the very first termination with no error thrown. [HIGH confidence — developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle]

## Data Flow

### Signal → Verdict → Border flow

```
Cookie changes (cookies.onChanged, no navigation)
    ↓ (in-process call — SW context)
Cookie Sensor.classify() → number|null
    ↓
ConfidenceEngine.updateSignal(appKey, 'cookie', value)
    ↓ writes
VerdictStore (chrome.storage.session)
    ↓ if verdict transitioned (hysteresis crossed 0.7/0.3)
Messaging Router → chrome.tabs.sendMessage(tabId, VERDICT_UPDATE)
    ↓ (one-shot, wakes/uses live content script — never dies)
content.ts onMessage handler
    ↓
Border Overlay.render(verdict) → toggles border in closed Shadow DOM
```

```
DOM mutation (SPA re-render, no navigation)
    ↓ (in-page context)
DOM Sensor (debounced MutationObserver) → classify() → number|null
    ↓ crosses process boundary
chrome.runtime.sendMessage({type:'SENSOR_SIGNAL', signal:'dom', value})
    ↓ (wakes SW if terminated)
Messaging Router.onMessage → engine.updateSignal(sender.tab.id, 'dom', value)
    ↓ same downstream path as above
```

### SW-restart recovery flow

```
Content script loads (fresh document OR SW just restarted, port/state unknown)
    ↓
content.ts sends one-shot GET_VERDICT
    ↓ (wakes SW if needed)
Messaging Router → VerdictStore.getVerdict(tabId)
    ↓ if empty (first-ever observation for this tab, or storage.session cleared)
Router triggers on-demand cookie/network probe (chrome.cookies.getAll for tab's domain)
    ↓
sendResponse(currentVerdict or 'unknown')
    ↓
Border Overlay syncs to actual current state immediately — no waiting for next event
```

### Key Data Flows

1. **Push (event-driven):** Any sensor firing → engine → store → (if transitioned) push to content script. This is the primary flow per the "no navigation" requirement — driven entirely by `cookies.onChanged`, `webRequest.onCompleted`, debounced `MutationObserver`, and a lightweight localStorage poll (see Anti-Patterns).
2. **Pull (resync-on-load):** Content script boot → `GET_VERDICT` → immediate correct render, independent of whether the SW happened to have been alive continuously. This is what makes the architecture correct across the SW's discontinuous lifecycle — the content script never assumes continuity.

## Scaling Considerations

Scale axis for this project isn't "users," it's **SW wake frequency and event volume under `<all_urls>` host permissions** — `cookies.onChanged` and `webRequest.onCompleted` fire for *all* cookie changes and *all* network requests across *all* tabs, not just tracked ones.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Few tabs, light browsing | No adjustment needed — default listeners are fine. |
| Many tabs (10+) / heavy SPA traffic | Filter aggressively at the listener boundary before touching the engine: Network Sensor should early-return on non-identity-endpoint-shaped URLs (path/method heuristic) before any classification work; Cookie Sensor should ignore changes for domains with no tracked tab. This is the actual first bottleneck — not compute cost of fusion (trivial), but burning the 30s idle budget / CPU processing irrelevant global traffic. |
| Very high request volume sites (analytics-heavy SPAs) | Debounce DOM Sensor aggressively (300–500ms, per design doc); confirm `webRequest` listener does zero work (not even URL-parse) for requests that fail a cheap string check first. |

### Scaling Priorities

1. **First bottleneck:** Global event volume from `<all_urls>` — mitigate with cheap early filters in every SW-side listener, not by restricting permissions (out of scope for MVP per PROJECT.md).
2. **Second bottleneck:** MutationObserver storms on highly dynamic SPAs — mitigate with debounce (already in design), not by disabling observation.

## Anti-Patterns

### Anti-Pattern 1: In-memory-only verdict state in the service worker

**What people do:** Keep `const verdicts = new Map<number, Verdict>()` at module scope and read/write it directly, assuming the SW stays alive for the tab's session.
**Why it's wrong:** The SW is terminated after ~30s of inactivity and restarts on the next event — the Map resets to empty, and the verdict silently reverts to "unknown" even though nothing about the tab's sign-in state changed, causing visible border flicker.
**Do this instead:** Treat the SW as stateless; every write goes through `VerdictStore` → `chrome.storage.session`; every read on startup is a lazy rehydrate, not an assumption of continuity.

### Anti-Pattern 2: Long-lived port as the primary channel

**What people do:** `chrome.runtime.connect()` once from the content script on load and keep pushing/receiving over that port indefinitely.
**Why it's wrong:** The port disconnects silently whenever the SW terminates (`onDisconnect` fires with no automatic reconnect), and since Chrome 110 opening a port no longer reliably resets/holds the SW's idle timer — so the port becomes a false sense of "connection," while actually being just as ephemeral as the SW itself, plus reconnect bookkeeping neither one-shot messaging needs.
**Do this instead:** One-shot `sendMessage`/`tabs.sendMessage` for every push; each message independently wakes a dead SW and is delivered — no connection state to manage.

### Anti-Pattern 3: Registering Chrome API listeners conditionally or after an await

**What people do:** Wrap `chrome.webRequest.onCompleted.addListener(...)` or `chrome.cookies.onChanged.addListener(...)` inside an `async function init() { await loadConfig(); chrome.webRequest.onCompleted.addListener(...) }`.
**Why it's wrong:** MV3 requires event listeners to be registered synchronously during the SW's initial (top-level) script evaluation so Chrome can re-attach them on every restart; deferred registration can silently fail to re-attach after the first termination, breaking the sensor with no error surfaced.
**Do this instead:** Register every listener as the very first thing `background.ts` does, unconditionally; do any async setup (like reading config) *inside* the listener callbacks, not before registration.

### Anti-Pattern 4: Using declarativeNetRequest to observe responses

**What people do:** Reach for `declarativeNetRequest` because it's "the MV3-recommended networking API" and try to use it to detect 200 vs 401 on identity endpoints.
**Why it's wrong:** DNR is a request-time rule matcher for blocking/redirecting/header-modification; it does not expose response status codes to your extension's JS for arbitrary matched traffic. Using it here silently produces no Network Sensor signal at all.
**Do this instead:** Use non-blocking `webRequest.onCompleted`/`onErrorOccurred` — this is still fully available for regular MV3 extensions and is the only API that surfaces response status codes.

### Anti-Pattern 5: Trusting the `storage` event for same-tab localStorage writes

**What people do:** Have the Storage Sensor rely solely on `window.addEventListener('storage', ...)` to detect a new auth token being written.
**Why it's wrong:** The native `storage` event only fires in *other* documents/tabs, never in the tab that performed the write — a same-tab SPA login that sets `localStorage.setItem('auth_token', ...)` produces zero `storage` events in that tab, so the sensor would miss the exact case the border exists to detect.
**Do this instead:** Pair the `storage` event (useful for cross-tab logout/login sync) with a lightweight periodic re-scan of the tracked keys (piggybacked on the same debounce tick as the DOM Sensor, e.g. every MutationObserver-triggered check also re-reads storage) so same-tab writes are caught too.

## Integration Points

### External Services

None — the design is explicitly local-only, read-only, zero outbound network calls (per PROJECT.md privacy constraint). No third-party API integration in the MVP.

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Cookie/Network Sensor ↔ ConfidenceEngine | Direct in-process function call (`updateSignal`) | Same context (SW) — no message needed, no boundary to cross |
| Storage/DOM Sensor ↔ ConfidenceEngine | `chrome.runtime.sendMessage` → Messaging Router → `updateSignal` | Cross-process boundary; content script's message wakes SW if terminated |
| ConfidenceEngine/VerdictStore ↔ Border Overlay | `chrome.tabs.sendMessage(tabId, VERDICT_UPDATE)` pushed on transition + `GET_VERDICT` pulled on content script load | Push for reactivity, pull for restart-safety — both needed |
| AppIdentity resolver ↔ everything keyed by app | Pure function call within SW; tab→appKey cache invalidated on `tabs.onUpdated`/`onRemoved` | eTLD+1 computed from bundled PSL data (e.g. `tldts` package) — MV3 forbids fetching a remote PSL, must ship it in the bundle |

## Build Order (TDD, dependency-first)

Ordered so every step's dependencies are already built and tested; steps in the same tier can run in parallel (subagents/contributors), matching PROJECT.md's "favor parallel work streams" constraint.

**Tier 0 — contracts (blocks everyone, build first, ~no logic):**
1. `shared/types.ts`, `shared/constants.ts`

**Tier 1 — pure, Chrome-API-free logic (parallelizable, the actual detection risk lives here):**
2. `engine/confidenceEngine.ts` — fusion formula + hysteresis state machine; TDD table-driven tests per design doc §8 (this is the core value of the product — build and prove it first, independent of any Chrome API)
3. `identity/appIdentity.ts` (pure part) — url → eTLD+1, fixture-driven tests
4. `background/sensors/{cookie,network}Sensor.classify.ts` and `content/sensors/{storage,dom}Sensor.classify.ts` — four independent pure classifiers, fixture/table-driven tests, fully parallelizable across contributors

**Tier 2 — storage/persistence (depends on Tier 0 types only):**
5. `background/state/verdictStore.ts` — `chrome.storage.session` adapter, testable with a mocked `chrome.storage` (e.g. `jest-chrome`/`sinon-chrome`)

**Tier 3 — Chrome API glue (depends on Tier 1 classifiers + Tier 0 types; thin, mostly integration-tested):**
6. `background/sensors/cookieSensor.ts`, `background/sensors/networkSensor.ts` — wrap `chrome.cookies`/`chrome.webRequest`, call the Tier-1 classifiers
7. `background/messaging/router.ts` — dispatch `SENSOR_SIGNAL`/`GET_VERDICT`, push `VERDICT_UPDATE`; integration-tested with mocked `chrome.runtime`

**Tier 4 — wiring (depends on everything above):**
8. `background/background.ts` — registers all listeners **synchronously at top level** (verify via code review/lint, not unit test — this is a structural MV3 requirement, not a runtime-testable one)
9. `content/overlay/borderOverlay.ts` — closed Shadow DOM renderer; unit-testable in jsdom independent of Chrome APIs, so this can actually start as early as Tier 1 in parallel if useful
10. `content/content.ts` — wires storage/DOM sensors + overlay + messaging on the content side

**Tier 5 — end-to-end validation:**
11. Integration test: mock SPA fixture — set cookie → verdict flips → border appears (design doc §8)
12. Manual validation: 3–4 real apps (a Google property, GitHub, a plain cookie-session app) — sign-in/sign-out each, confirm expected verdict

**Parallelization guidance:** After Tier 0 lands, Tier 1 (steps 2–4) has four to five independent, Chrome-API-free work items — ideal for parallel subagents. Border Overlay (step 9) has no dependency on any Chrome API either and can start immediately after Tier 0. Tier 3 (Chrome glue) is the narrowest, most sequential part of the tree since it depends on stable classifier signatures — keep it small and start it only once the corresponding Tier-1 classifier's interface is frozen, even if the classifier's internal heuristic keeps evolving.

## Sources

- [The extension service worker lifecycle — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) — HIGH: 30s idle timeout, event/API calls reset timer, top-level listener registration requirement, statelessness guidance
- [chrome.storage API reference — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/storage) — HIGH: `storage.session` in-memory/~10MB quota, default `TRUSTED_CONTEXTS` access level, not persisted to disk
- [chrome.webRequest API reference — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/webRequest) — HIGH: non-blocking observation unchanged in MV3, `extraHeaders` for full header visibility
- [Replace blocking web request listeners — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests) — HIGH: `webRequestBlocking` restricted to enterprise force-installed extensions; declarativeNetRequest positioned as the blocking-use-case replacement, not an observation tool
- [chrome.alarms API reference — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/alarms) — MEDIUM: alarms wake a terminated SW but don't keep it continuously alive; not needed for this design (event-driven wake via cookies/webRequest/messages is sufficient)
- Chromium extensions group thread on port lifetime post-Chrome-110 — MEDIUM (community/engineering discussion, not primary docs, but consistent across multiple independent threads): opening a port no longer reliably resets/holds the idle timer, motivating the one-shot-messaging-only recommendation

---
*Architecture research for: Chrome MV3 sign-in detector extension*
*Researched: 2026-07-17*
