import { DOM_AMBIGUOUS_VALUE, DOM_POSITIVE_VALUE } from '../../shared/constants';
import type { SignalEvidence } from '../../shared/types';

/**
 * A normalized DOM snapshot -- booleans only, never live DOM state
 * (per ARCHITECTURE.md). Produced by the content-script layer in a
 * later phase; this classifier is pure and takes only the snapshot.
 */
export interface DomSnapshotInput {
  readonly hasLogoutAffordance: boolean;
  readonly hasAccountAffordance: boolean;
  readonly hasAvatarAffordance: boolean;
  readonly hasPasswordLoginForm: boolean;
}

/**
 * Classifies a normalized DOM snapshot into a low-weight, shape-only
 * signed-in signal (SEN-05). A logout/account/avatar affordance with no
 * visible password-login form is a low-weight positive; a visible
 * password form -- alone, or alongside an affordance (e.g. a re-auth
 * prompt) -- is conservatively scored as ambiguous. `passwordFormVisible`
 * always reflects ground truth so the engine's ENG-02 cross-signal rule
 * can consume it independently of this classifier's own score.
 */
export function classifyDom(snapshot: DomSnapshotInput): SignalEvidence {
  const { hasLogoutAffordance, hasAccountAffordance, hasAvatarAffordance, hasPasswordLoginForm } =
    snapshot;

  const hasAffordance = hasLogoutAffordance || hasAccountAffordance || hasAvatarAffordance;

  if (!hasAffordance && !hasPasswordLoginForm) {
    return { signal: 'dom', observed: false };
  }

  if (hasAffordance && !hasPasswordLoginForm) {
    return {
      signal: 'dom',
      observed: true,
      value: DOM_POSITIVE_VALUE,
      passwordFormVisible: false,
    };
  }

  return {
    signal: 'dom',
    observed: true,
    value: DOM_AMBIGUOUS_VALUE,
    passwordFormVisible: true,
  };
}
