import { describe, expect, it } from 'vitest';

import { DOM_AMBIGUOUS_VALUE, DOM_POSITIVE_VALUE } from '../../shared/constants';
import { classifyDom, type DomSnapshotInput } from './classify';

function snapshot(overrides: Partial<DomSnapshotInput> = {}): DomSnapshotInput {
  return {
    hasLogoutAffordance: false,
    hasAccountAffordance: false,
    hasAvatarAffordance: false,
    hasPasswordLoginForm: false,
    ...overrides,
  };
}

describe('classifyDom', () => {
  it('returns observed:false when neither any affordance nor a password form is present', () => {
    expect(classifyDom(snapshot())).toEqual({ signal: 'dom', observed: false });
  });

  it('returns DOM_POSITIVE_VALUE with passwordFormVisible:false when a logout affordance is present alone', () => {
    const result = classifyDom(snapshot({ hasLogoutAffordance: true }));
    expect(result).toEqual({
      signal: 'dom',
      observed: true,
      value: DOM_POSITIVE_VALUE,
      passwordFormVisible: false,
    });
  });

  it('returns DOM_POSITIVE_VALUE with passwordFormVisible:false when an account affordance is present alone', () => {
    const result = classifyDom(snapshot({ hasAccountAffordance: true }));
    expect(result).toEqual({
      signal: 'dom',
      observed: true,
      value: DOM_POSITIVE_VALUE,
      passwordFormVisible: false,
    });
  });

  it('returns DOM_POSITIVE_VALUE with passwordFormVisible:false when an avatar affordance is present alone', () => {
    const result = classifyDom(snapshot({ hasAvatarAffordance: true }));
    expect(result).toEqual({
      signal: 'dom',
      observed: true,
      value: DOM_POSITIVE_VALUE,
      passwordFormVisible: false,
    });
  });

  it('returns DOM_AMBIGUOUS_VALUE with passwordFormVisible:true when a password form is present and no affordance is', () => {
    const result = classifyDom(snapshot({ hasPasswordLoginForm: true }));
    expect(result).toEqual({
      signal: 'dom',
      observed: true,
      value: DOM_AMBIGUOUS_VALUE,
      passwordFormVisible: true,
    });
  });

  it('returns DOM_AMBIGUOUS_VALUE with passwordFormVisible:true when both an affordance and a password form are present (conservative)', () => {
    const result = classifyDom(
      snapshot({ hasLogoutAffordance: true, hasPasswordLoginForm: true }),
    );
    expect(result).toEqual({
      signal: 'dom',
      observed: true,
      value: DOM_AMBIGUOUS_VALUE,
      passwordFormVisible: true,
    });
  });

  it('passwordFormVisible always reflects ground truth regardless of computed value', () => {
    const positiveCase = classifyDom(snapshot({ hasAccountAffordance: true }));
    const ambiguousCase = classifyDom(snapshot({ hasPasswordLoginForm: true }));

    if (positiveCase.signal === 'dom' && positiveCase.observed) {
      expect(positiveCase.passwordFormVisible).toBe(false);
    } else {
      expect.unreachable('expected observed dom evidence for positiveCase');
    }

    if (ambiguousCase.signal === 'dom' && ambiguousCase.observed) {
      expect(ambiguousCase.passwordFormVisible).toBe(true);
    } else {
      expect.unreachable('expected observed dom evidence for ambiguousCase');
    }
  });
});
