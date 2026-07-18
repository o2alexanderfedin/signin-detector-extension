import type { VerdictState } from '../../shared/types';
import {
  BORDER_OVERLAY_COLOR,
  BORDER_OVERLAY_HOST_ID,
  BORDER_OVERLAY_REASSERT_DEBOUNCE_MS,
  BORDER_OVERLAY_WIDTH_PX,
  BORDER_OVERLAY_Z_INDEX,
} from '../../shared/constants';

/**
 * Injectable configuration for {@link createBorderOverlay}. The overlay has
 * no Chrome-API dependency of its own -- everything it touches is plain DOM
 * -- but it still takes an injectable `document` (and `isTopFrame` check) so
 * it is unit-testable under happy-dom without a real browser tab/iframe.
 */
export interface CreateBorderOverlayOptions {
  /** Defaults to the global `document`. Inject a fresh (happy-dom) Document per test for isolation. */
  readonly document?: Document;
  /** MutationObserver re-assertion debounce window (BDR-03). Defaults to {@link BORDER_OVERLAY_REASSERT_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /**
   * The border must only ever render in the top frame, never inside an
   * iframe. Defaults to the real `window.top === window` check; injectable
   * so it's unit-testable without constructing a real nested-frame Window.
   */
  readonly isTopFrame?: () => boolean;
}

/**
 * Handle returned by {@link createBorderOverlay}. `root` exposes the live
 * closed ShadowRoot instance for assertions -- from OUTSIDE this module a
 * closed shadow root is otherwise unreachable (`hostElement.shadowRoot` is
 * `null` by spec), which is the whole point of `mode: 'closed'` (defeats
 * page-script introspection/tampering with the overlay).
 */
export interface BorderOverlayHandle {
  /** Shows the border iff `state === 'signed-in'` and we're in the top frame (BDR-04); any other state hides it. */
  show(state: VerdictState): void;
  /** Removes the border and stops re-asserting it. Safe to call when already hidden (idempotent). */
  hide(): void;
  /** The closed ShadowRoot currently mounted, or `null` when hidden. Test/inspection seam only. */
  readonly root: ShadowRoot | null;
}

/** Builds the single inset-border element painted inside the shadow root. CSSOM only -- see module doc. */
function buildBorderElement(doc: Document): HTMLDivElement {
  const border = doc.createElement('div');
  border.style.setProperty('position', 'fixed');
  border.style.setProperty('inset', '0');
  border.style.setProperty('pointer-events', 'none');
  border.style.setProperty('z-index', String(BORDER_OVERLAY_Z_INDEX));
  border.style.setProperty('box-sizing', 'border-box');
  border.style.setProperty('border', `${String(BORDER_OVERLAY_WIDTH_PX)}px solid ${BORDER_OVERLAY_COLOR}`);
  return border;
}

/**
 * Creates a viewport-edge border overlay controller (BDR-01..04).
 *
 * The border is a single `position: fixed; inset: 0; pointer-events: none;`
 * element at the DOM stacking-context maximum z-index, inside a CLOSED
 * Shadow DOM host attached directly to `document.documentElement`. Every
 * node and style is built via `document.createElement` +
 * `element.style.setProperty` -- NEVER `innerHTML` or `style.cssText` -- so
 * the overlay survives Trusted-Types and strict-CSP pages that block
 * string-based DOM/style injection (PITFALLS.md Pitfall 11).
 *
 * A debounced `MutationObserver`, scoped to `document.documentElement`'s
 * direct `childList` only (never `subtree: true`), watches for the page
 * removing or reordering the host and rebuilds it (BDR-03). Scoping to the
 * direct childList (rather than the whole subtree) is deliberate -- see
 * PITFALLS.md Pitfall 12 -- so this self-healing check doesn't fire on
 * every unrelated deep DOM mutation on high-churn pages (chat, live
 * dashboards).
 *
 * Accepted limitation (documented, not fixed in this phase): the CSS Top
 * Layer (`<dialog>`, Popover API, fullscreen) can still paint above this
 * border regardless of z-index, because the Top Layer is a separate paint
 * stack outside normal stacking-context ordering. See PITFALLS.md Pitfall
 * 11; revisited in Phase 5.
 */
export function createBorderOverlay(options: CreateBorderOverlayOptions = {}): BorderOverlayHandle {
  const doc = options.document ?? document;
  const debounceMs = options.debounceMs ?? BORDER_OVERLAY_REASSERT_DEBOUNCE_MS;
  const isTopFrame = options.isTopFrame ?? ((): boolean => window.top === window);

  let hostElement: HTMLDivElement | null = null;
  let shadowRoot: ShadowRoot | null = null;
  let observer: MutationObserver | null = null;
  let reassertTimer: ReturnType<typeof setTimeout> | null = null;
  let visible = false;

  function mountHost(): void {
    if (hostElement !== null && hostElement.isConnected) {
      return; // already mounted -- idempotent, double show() never duplicates the host.
    }

    const host = doc.createElement('div');
    host.setAttribute('id', BORDER_OVERLAY_HOST_ID);
    // Reset the host's own box so page CSS can't inherit into (or size)
    // the closed shadow tree; the host itself paints nothing.
    host.style.setProperty('all', 'initial');
    host.style.setProperty('display', 'block');

    const root = host.attachShadow({ mode: 'closed' });
    root.appendChild(buildBorderElement(doc));

    doc.documentElement.appendChild(host);

    hostElement = host;
    shadowRoot = root;
  }

  function unmountHost(): void {
    if (hostElement !== null && hostElement.isConnected) {
      hostElement.remove();
    }
    hostElement = null;
    shadowRoot = null;
  }

  function scheduleReassert(): void {
    if (reassertTimer !== null) {
      clearTimeout(reassertTimer);
    }
    reassertTimer = setTimeout(() => {
      reassertTimer = null;
      if (visible && (hostElement === null || !hostElement.isConnected)) {
        mountHost();
      }
    }, debounceMs);
  }

  function startObserving(): void {
    if (observer !== null) {
      return;
    }
    observer = new MutationObserver(() => {
      scheduleReassert();
    });
    // Direct childList only -- see module doc / PITFALLS.md Pitfall 12.
    observer.observe(doc.documentElement, { childList: true });
  }

  function stopObserving(): void {
    if (observer !== null) {
      observer.disconnect();
      observer = null;
    }
    if (reassertTimer !== null) {
      clearTimeout(reassertTimer);
      reassertTimer = null;
    }
  }

  function doHide(): void {
    visible = false;
    stopObserving();
    unmountHost();
  }

  function doShow(state: VerdictState): void {
    if (state !== 'signed-in' || !isTopFrame()) {
      doHide();
      return;
    }
    visible = true;
    mountHost();
    startObserving();
  }

  return {
    show: doShow,
    hide: doHide,
    get root(): ShadowRoot | null {
      return shadowRoot;
    },
  };
}
