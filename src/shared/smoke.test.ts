import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs under happy-dom with a working DOM global and basic arithmetic', () => {
    expect(typeof document).toBe('object');
    expect(1 + 1).toBe(2);
  });
});
