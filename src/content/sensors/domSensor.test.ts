import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

import { DOM_AMBIGUOUS_VALUE, DOM_POSITIVE_VALUE } from '../../shared/constants';
import { buildDomSnapshot, createDomSensor } from './domSensor';

/**
 * SEN-05 -- content-script DOM sensor glue tests. `getEvidence()` /
 * `buildDomSnapshot()` are tested against an isolated happy-dom
 * `Document` (never the global `document`), so nothing leaks across
 * tests.
 *
 * `watch()`'s debounced MutationObserver is tested with a short injected
 * `debounceMs` and REAL timers (not fake timers) -- happy-dom dispatches
 * MutationObserver callbacks as real microtasks/macrotasks that fake
 * timers don't reliably drive, matching `borderOverlay.test.ts`'s
 * established convention for this codebase.
 */

function makeDocument(): Document {
  const window = new Window();
  return window.document as unknown as Document;
}

async function waitPastDebounce(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms + 40));
}

describe('domSensor (SEN-05)', () => {
  describe('buildDomSnapshot -- structural DOM -> boolean snapshot', () => {
    it('detects a structural logout button by accessible text', () => {
      const doc = makeDocument();
      const button = doc.createElement('button');
      button.textContent = 'Sign Out';
      doc.body.appendChild(button);

      expect(buildDomSnapshot(doc.body)).toEqual({
        hasLogoutAffordance: true,
        hasAccountAffordance: false,
        hasAvatarAffordance: false,
        hasPasswordLoginForm: false,
      });
    });

    it('detects a logout link via aria-label even when its visible text differs', () => {
      const doc = makeDocument();
      const link = doc.createElement('a');
      link.setAttribute('href', '#');
      link.setAttribute('aria-label', 'Log out');
      link.textContent = 'Bye!';
      doc.body.appendChild(link);

      expect(buildDomSnapshot(doc.body).hasLogoutAffordance).toBe(true);
    });

    it('detects an account affordance', () => {
      const doc = makeDocument();
      const link = doc.createElement('a');
      link.textContent = 'Account Settings';
      doc.body.appendChild(link);

      expect(buildDomSnapshot(doc.body).hasAccountAffordance).toBe(true);
    });

    it('detects an avatar affordance via an <img alt="User avatar">', () => {
      const doc = makeDocument();
      const img = doc.createElement('img');
      img.setAttribute('alt', 'User avatar');
      doc.body.appendChild(img);

      expect(buildDomSnapshot(doc.body).hasAvatarAffordance).toBe(true);
    });

    it('detects a visible password login form', () => {
      const doc = makeDocument();
      const form = doc.createElement('form');
      const input = doc.createElement('input');
      input.setAttribute('type', 'password');
      form.appendChild(input);
      doc.body.appendChild(form);

      expect(buildDomSnapshot(doc.body).hasPasswordLoginForm).toBe(true);
    });

    it('does not match logout/account patterns in non-interactive text (structural, not raw text search)', () => {
      const doc = makeDocument();
      const paragraph = doc.createElement('p');
      paragraph.textContent = 'Sign out other devices from your account dashboard for extra security.';
      doc.body.appendChild(paragraph); // not an <a>/<button>/[role] -- must not match

      const snapshot = buildDomSnapshot(doc.body);
      expect(snapshot.hasLogoutAffordance).toBe(false);
      expect(snapshot.hasAccountAffordance).toBe(false);
    });

    it('returns all-false for an empty tree', () => {
      const doc = makeDocument();
      expect(buildDomSnapshot(doc.body)).toEqual({
        hasLogoutAffordance: false,
        hasAccountAffordance: false,
        hasAvatarAffordance: false,
        hasPasswordLoginForm: false,
      });
    });
  });

  describe('getEvidence -- reuses the pure classifyDom classifier', () => {
    it('returns observed:false when the snapshot has no affordance and no password form', () => {
      const doc = makeDocument();
      const sensor = createDomSensor({ root: doc.body });
      expect(sensor.getEvidence()).toEqual({ signal: 'dom', observed: false });
    });

    it('returns DOM_POSITIVE_VALUE with passwordFormVisible:false for a logout affordance alone', () => {
      const doc = makeDocument();
      const button = doc.createElement('button');
      button.textContent = 'Log out';
      doc.body.appendChild(button);

      const sensor = createDomSensor({ root: doc.body });
      expect(sensor.getEvidence()).toEqual({
        signal: 'dom',
        observed: true,
        value: DOM_POSITIVE_VALUE,
        passwordFormVisible: false,
      });
    });

    it('returns DOM_AMBIGUOUS_VALUE with passwordFormVisible:true when a password form is visible alongside a logout affordance', () => {
      const doc = makeDocument();
      const button = doc.createElement('button');
      button.textContent = 'Sign out';
      doc.body.appendChild(button);
      const form = doc.createElement('form');
      const input = doc.createElement('input');
      input.setAttribute('type', 'password');
      form.appendChild(input);
      doc.body.appendChild(form);

      const sensor = createDomSensor({ root: doc.body });
      expect(sensor.getEvidence()).toEqual({
        signal: 'dom',
        observed: true,
        value: DOM_AMBIGUOUS_VALUE,
        passwordFormVisible: true,
      });
    });

    it('defaults `root` to the global document when no options are given', () => {
      const sensor = createDomSensor();
      // The real happy-dom global document (via vitest.config.ts) has no
      // affordances/password form by default.
      expect(sensor.getEvidence()).toEqual({ signal: 'dom', observed: false });
    });
  });

  describe('watch -- debounced MutationObserver (SEN-05)', () => {
    it('does not invoke onEvidence before the debounce window elapses', async () => {
      const doc = makeDocument();
      const sensor = createDomSensor({ root: doc.body, debounceMs: 30 });
      const onEvidence = vi.fn();
      const stop = sensor.watch(onEvidence);

      const button = doc.createElement('button');
      button.textContent = 'Sign out';
      doc.body.appendChild(button);
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(onEvidence).not.toHaveBeenCalled();
      stop();
    });

    it('invokes onEvidence once, with the fresh classification, after the debounce window settles', async () => {
      const doc = makeDocument();
      const sensor = createDomSensor({ root: doc.body, debounceMs: 30 });
      const onEvidence = vi.fn();
      const stop = sensor.watch(onEvidence);

      const button = doc.createElement('button');
      button.textContent = 'Sign out';
      doc.body.appendChild(button);

      await waitPastDebounce(30);

      expect(onEvidence).toHaveBeenCalledTimes(1);
      expect(onEvidence).toHaveBeenCalledWith({
        signal: 'dom',
        observed: true,
        value: DOM_POSITIVE_VALUE,
        passwordFormVisible: false,
      });
      stop();
    });

    it('collapses several rapid mutations within the debounce window into a single onEvidence call', async () => {
      const doc = makeDocument();
      const sensor = createDomSensor({ root: doc.body, debounceMs: 30 });
      const onEvidence = vi.fn();
      const stop = sensor.watch(onEvidence);

      for (let i = 0; i < 5; i += 1) {
        const span = doc.createElement('span');
        span.textContent = `churn-${String(i)}`;
        doc.body.appendChild(span);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await waitPastDebounce(30);

      expect(onEvidence).toHaveBeenCalledTimes(1);
      stop();
    });

    it('the returned stop() disconnects the observer -- later mutations do not invoke onEvidence', async () => {
      const doc = makeDocument();
      const sensor = createDomSensor({ root: doc.body, debounceMs: 30 });
      const onEvidence = vi.fn();
      const stop = sensor.watch(onEvidence);
      stop();

      const button = doc.createElement('button');
      button.textContent = 'Sign out';
      doc.body.appendChild(button);
      await waitPastDebounce(30);

      expect(onEvidence).not.toHaveBeenCalled();
    });

    it('stop() before the debounce timer fires cancels the pending call', async () => {
      const doc = makeDocument();
      const sensor = createDomSensor({ root: doc.body, debounceMs: 30 });
      const onEvidence = vi.fn();
      const stop = sensor.watch(onEvidence);

      const button = doc.createElement('button');
      button.textContent = 'Sign out';
      doc.body.appendChild(button);
      await new Promise((resolve) => setTimeout(resolve, 5)); // mutation observed, timer scheduled
      stop(); // cancel before the 30ms debounce elapses

      await waitPastDebounce(30);

      expect(onEvidence).not.toHaveBeenCalled();
    });
  });
});
