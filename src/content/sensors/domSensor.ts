import { classifyDom, type DomSnapshotInput } from '../../sensors/dom/classify';
import type { SignalEvidence } from '../../shared/types';

/**
 * Evidence shape this sensor can ever return. `classifyDom`'s DECLARED
 * return type is the full `SignalEvidence` union (shared by all four
 * Phase-1 classifiers), but its implementation only ever constructs the
 * `signal: 'dom'` variant. Narrowing it here lets this sensor's output
 * flow directly into `content/messaging.ts#sendSensorSignal` (which only
 * accepts `storage`/`dom` evidence) with no cast at the call site -- see
 * the cast note on {@link createDomSensor.getEvidence}.
 */
export type DomSensorEvidence = Extract<SignalEvidence, { readonly signal: 'dom' }>;

/**
 * Debounce window for the MutationObserver-driven re-scan (SEN-05).
 * Deliberately separate from (and wider-scoped than) the border overlay's
 * own re-assertion debounce (`BORDER_OVERLAY_REASSERT_DEBOUNCE_MS`, which
 * only watches `documentElement`'s direct childList) -- this observer
 * watches the whole subtree for affordance/password-form changes, so it
 * needs its own independently-tunable window.
 */
export const DOM_SENSOR_MUTATION_DEBOUNCE_MS = 250;

const LOGOUT_TEXT_PATTERN = /^(log|sign)[\s-]*out\b/i;
const ACCOUNT_TEXT_PATTERN = /\b(my\s+account|account(\s+settings)?|profile\s+settings)\b/i;
const AVATAR_HINT_PATTERN = /avatar|profile[\s-]?(photo|picture|pic)/i;

/** Interactive elements only -- never a raw-text search over the whole document (see module doc). */
const INTERACTIVE_SELECTOR = 'a, button, [role="button"], [role="menuitem"]';

/** The accessible name of an interactive element: its `aria-label` if set, else its trimmed text content. */
function accessibleText(element: Element): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim().length > 0) {
    return ariaLabel.trim();
  }
  return (element.textContent ?? '').trim();
}

/**
 * True iff some interactive element (link/button/`role="button"`/
 * `role="menuitem"`) matches `pattern` by accessible name. Structural
 * (element-scoped), never a raw-text search over the whole document --
 * PITFALLS.md warns that marketing/landing-page copy routinely contains
 * "Sign out"/"Account"/"Dashboard" outside of any actual affordance.
 */
function hasInteractiveMatch(root: ParentNode, pattern: RegExp): boolean {
  return Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR)).some((element) =>
    pattern.test(accessibleText(element)),
  );
}

/** True iff any element hints at being a user avatar via its `alt` text, `class`, or `id`. */
function hasAvatarElement(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll('img, [class], [id]')).some((element) => {
    const alt = element.getAttribute('alt') ?? '';
    const className = typeof element.className === 'string' ? element.className : '';
    const id = element.id;
    return (
      AVATAR_HINT_PATTERN.test(alt) || AVATAR_HINT_PATTERN.test(className) || AVATAR_HINT_PATTERN.test(id)
    );
  });
}

/**
 * Builds the normalized boolean {@link DomSnapshotInput} `classifyDom`
 * expects, from a real (or detached/injected) DOM tree. This is the
 * "content-script layer" the Phase-1 classifier's own doc comment defers
 * to for snapshot production -- structural presence checks only, never a
 * raw whole-document text search (PITFALLS.md).
 */
export function buildDomSnapshot(root: ParentNode): DomSnapshotInput {
  return {
    hasLogoutAffordance: hasInteractiveMatch(root, LOGOUT_TEXT_PATTERN),
    hasAccountAffordance: hasInteractiveMatch(root, ACCOUNT_TEXT_PATTERN),
    hasAvatarAffordance: hasAvatarElement(root),
    hasPasswordLoginForm: root.querySelector('form input[type="password"]') !== null,
  };
}

/** Injectable configuration for {@link createDomSensor}. */
export interface CreateDomSensorOptions {
  /** Defaults to the global `document`. Inject a fresh (happy-dom) Document, or a detached Element subtree, per test for isolation. */
  readonly root?: Document | Element;
  /** MutationObserver debounce window (SEN-05). Defaults to {@link DOM_SENSOR_MUTATION_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
}

export interface DomSensor {
  /** One-shot: snapshots the DOM right now and classifies it via the pure `classifyDom` (SEN-05). */
  getEvidence(): DomSensorEvidence;
  /**
   * Wires a debounced `MutationObserver` over the whole subtree; each
   * settled batch of mutations re-snapshots and re-classifies the DOM,
   * invoking `onEvidence` with the fresh result (SPAs re-render
   * constantly, so debouncing is required -- undebounced observation is a
   * perf/battery risk per FEATURES.md). Returns an unsubscribe function
   * that disconnects the observer and cancels any pending (not-yet-fired)
   * debounce timer.
   */
  watch(onEvidence: (evidence: DomSensorEvidence) => void): () => void;
}

/**
 * Creates a {@link DomSensor}. `root` defaults to the real global
 * `document` and is injectable for testing.
 */
export function createDomSensor(options: CreateDomSensorOptions = {}): DomSensor {
  const root = options.root ?? document;
  const debounceMs = options.debounceMs ?? DOM_SENSOR_MUTATION_DEBOUNCE_MS;

  function getEvidence(): DomSensorEvidence {
    // Safe narrowing cast -- see the module doc comment on
    // `DomSensorEvidence` for why this is provably correct.
    return classifyDom(buildDomSnapshot(root)) as DomSensorEvidence;
  }

  function watch(onEvidence: (evidence: DomSensorEvidence) => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const observer = new MutationObserver(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        onEvidence(getEvidence());
      }, debounceMs);
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    return () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      observer.disconnect();
    };
  }

  return { getEvidence, watch };
}
