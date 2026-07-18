import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BORDER_OVERLAY_HOST_ID, BORDER_OVERLAY_WIDTH_PX, BORDER_OVERLAY_Z_INDEX } from '../../shared/constants';
import type { VerdictState } from '../../shared/types';
import { createBorderOverlay } from './borderOverlay';

/**
 * BDR-01..04 -- border overlay controller tests, under an isolated
 * happy-dom `Document` injected per test (never the global `document`),
 * so tests can freely simulate the page removing/reordering the host
 * without leaking DOM state across tests.
 *
 * A short `debounceMs` is used throughout so BDR-03 re-assertion tests
 * stay fast; real timers are used (not fake timers) because happy-dom's
 * MutationObserver dispatches callbacks as real microtasks/macrotasks,
 * which fake timers don't reliably drive.
 */

function makeDocument(): Document {
  const window = new Window();
  return window.document as unknown as Document;
}

async function waitPastDebounce(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms + 40));
}

describe('createBorderOverlay (BDR-01..04)', () => {
  let doc: Document;

  beforeEach(() => {
    doc = makeDocument();
  });

  // ---------------------------------------------------------------------
  // BDR-01/BDR-02: closed Shadow DOM host, viewport-edge inset border.
  // ---------------------------------------------------------------------
  describe('BDR-01/02: closed Shadow DOM host + edge border', () => {
    it('show("signed-in") attaches exactly one host element to document.documentElement', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.show('signed-in');

      const hosts = doc.documentElement.querySelectorAll(`#${BORDER_OVERLAY_HOST_ID}`);
      expect(hosts).toHaveLength(1);
      expect(hosts[0]?.parentElement).toBe(doc.documentElement);
    });

    it('the shadow root is CLOSED -- host.shadowRoot is null from the outside', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.show('signed-in');

      const host = doc.getElementById(BORDER_OVERLAY_HOST_ID);
      expect(host).not.toBeNull();
      expect(host?.shadowRoot).toBeNull();
    });

    it('the handle exposes the live closed ShadowRoot as a test/inspection seam', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.show('signed-in');

      const host = doc.getElementById(BORDER_OVERLAY_HOST_ID);
      expect(overlay.root).not.toBeNull();
      expect(overlay.root?.host).toBe(host);
    });

    it('overlay.root is null before the first show() and after hide()', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });
      expect(overlay.root).toBeNull();

      overlay.show('signed-in');
      expect(overlay.root).not.toBeNull();

      overlay.hide();
      expect(overlay.root).toBeNull();
    });

    it('the border element inside the shadow root is a viewport-edge inset border built via CSSOM', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });
      overlay.show('signed-in');

      const border = overlay.root?.firstElementChild as HTMLElement | null | undefined;
      expect(border).toBeTruthy();
      expect(border?.tagName).toBe('DIV');
      expect(border?.style.getPropertyValue('position')).toBe('fixed');
      expect(border?.style.getPropertyValue('inset')).toBe('0');
      expect(border?.style.getPropertyValue('pointer-events')).toBe('none');
      expect(border?.style.getPropertyValue('z-index')).toBe(String(BORDER_OVERLAY_Z_INDEX));
      expect(border?.style.getPropertyValue('border')).toContain('solid');
      expect(border?.style.getPropertyValue('border')).toContain(`${String(BORDER_OVERLAY_WIDTH_PX)}px`);
    });

    it('never uses innerHTML or style.cssText anywhere in the implementation (Trusted-Types/CSP survival)', () => {
      // NB: uses Node's `URL` explicitly -- happy-dom's environment overrides
      // the global `URL` to resolve relative to `http://localhost:3000/`
      // rather than this file's `file://` base, which breaks `fileURLToPath`.
      const sourcePath = fileURLToPath(new NodeURL('./borderOverlay.ts', import.meta.url));
      // Strip comments so the module's own doc-comments (which name these
      // forbidden APIs to explain WHY they're avoided) don't false-positive
      // this scan -- only actual usage in code should fail it.
      const source = readFileSync(sourcePath, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      expect(source).not.toMatch(/\.innerHTML\s*=/);
      expect(source).not.toMatch(/\.outerHTML\s*=/);
      expect(source).not.toMatch(/\.style\.cssText/);
      expect(source).not.toMatch(/\bcssText\s*=/);
      expect(source).not.toMatch(/insertAdjacentHTML\s*\(/);
    });
  });

  // ---------------------------------------------------------------------
  // BDR-04: visible only for 'signed-in'; removed promptly otherwise.
  // ---------------------------------------------------------------------
  describe('BDR-04: show/hide toggles on VerdictState', () => {
    it.each<VerdictState>(['unknown', 'signed-out'])('show(%s) never creates a host', (state) => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.show(state);

      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();
      expect(overlay.root).toBeNull();
    });

    it('a visible border is removed promptly when the state leaves signed-in', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.show('signed-in');
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).not.toBeNull();

      overlay.show('signed-out');
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();

      overlay.show('signed-in');
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).not.toBeNull();

      overlay.show('unknown');
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();
    });

    it('hide() removes the host and is safe to call when already hidden', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.hide();
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();

      overlay.show('signed-in');
      overlay.hide();
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Idempotency: double show() never duplicates the host.
  // ---------------------------------------------------------------------
  describe('idempotency', () => {
    it('calling show("signed-in") twice in a row does not duplicate the host', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.show('signed-in');
      const firstHost = doc.getElementById(BORDER_OVERLAY_HOST_ID);
      const firstRoot = overlay.root;

      overlay.show('signed-in');
      const hosts = doc.documentElement.querySelectorAll(`#${BORDER_OVERLAY_HOST_ID}`);

      expect(hosts).toHaveLength(1);
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBe(firstHost);
      expect(overlay.root).toBe(firstRoot);
    });

    it('calling hide() twice in a row is a safe no-op', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.show('signed-in');
      overlay.hide();
      overlay.hide();

      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // BDR-03: debounced MutationObserver re-assertion.
  // ---------------------------------------------------------------------
  describe('BDR-03: debounced MutationObserver re-assertion', () => {
    const debounceMs = 10;

    it('re-attaches the host after the page removes it, once the debounce window elapses', async () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs });
      overlay.show('signed-in');

      const original = doc.getElementById(BORDER_OVERLAY_HOST_ID);
      expect(original).not.toBeNull();

      original?.remove();
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();

      await waitPastDebounce(debounceMs);

      const reattached = doc.getElementById(BORDER_OVERLAY_HOST_ID);
      expect(reattached).not.toBeNull();
      expect(doc.documentElement.querySelectorAll(`#${BORDER_OVERLAY_HOST_ID}`)).toHaveLength(1);
    });

    it('does not re-attach the host before the debounce window elapses', async () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 200 });
      overlay.show('signed-in');

      doc.getElementById(BORDER_OVERLAY_HOST_ID)?.remove();
      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();
    });

    it('rapid repeated removals only settle once after the debounce window (no runaway re-appends)', async () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs });
      overlay.show('signed-in');

      for (let i = 0; i < 5; i += 1) {
        doc.getElementById(BORDER_OVERLAY_HOST_ID)?.remove();
        // Also churn an unrelated node to exercise the childList observer without settling early.
        const decoy = doc.createElement('span');
        doc.documentElement.appendChild(decoy);
        decoy.remove();
      }

      await waitPastDebounce(debounceMs);

      expect(doc.documentElement.querySelectorAll(`#${BORDER_OVERLAY_HOST_ID}`)).toHaveLength(1);
    });

    it('hide() disconnects the observer -- no re-attachment happens after hide, even after removal-like churn', async () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs });
      overlay.show('signed-in');
      overlay.hide();

      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();

      // Any further childList churn on documentElement must not resurrect the host.
      const decoy = doc.createElement('span');
      doc.documentElement.appendChild(decoy);

      await waitPastDebounce(debounceMs);

      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Top-frame-only rendering.
  // ---------------------------------------------------------------------
  describe('top-frame-only rendering', () => {
    it('show("signed-in") never creates a host when isTopFrame() returns false', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10, isTopFrame: () => false });

      overlay.show('signed-in');

      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).toBeNull();
      expect(overlay.root).toBeNull();
    });

    it('defaults to window.top === window when isTopFrame is not provided (top-frame test environment shows the border)', () => {
      const overlay = createBorderOverlay({ document: doc, debounceMs: 10 });

      overlay.show('signed-in');

      expect(doc.getElementById(BORDER_OVERLAY_HOST_ID)).not.toBeNull();
    });
  });

  afterEach(() => {
    doc.getElementById(BORDER_OVERLAY_HOST_ID)?.remove();
  });
});
