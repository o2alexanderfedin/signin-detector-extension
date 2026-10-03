import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOM_SENSOR_MUTATION_DEBOUNCE_MS } from '../../src/content/sensors/domSensor';
import type { ContentSensorEvidence } from '../../src/content/messaging';

/**
 * `entrypoints/content.ts` -- the page's own sign-in token. The browser's `storage` event fires only
 * in OTHER tabs and windows of the same site, never in the page that made the change. So when the
 * page itself saves its token at sign-in, or deletes it at sign-out, the content script must still
 * notice and send fresh storage evidence.
 *
 * The messaging module is replaced so the test can see every signal the content script sends.
 * Lives under `tests/entrypoints/` for the same reason `background.test.ts` does (WXT treats every
 * file directly under `entrypoints/` as an entrypoint).
 */
const sent: ContentSensorEvidence[] = [];

vi.mock('../../src/content/messaging', () => ({
  sendSensorSignal: (evidence: ContentSensorEvidence) => {
    sent.push(evidence);
    return Promise.resolve();
  },
  onVerdictUpdate: () => () => {},
}));

/** A JWT-shaped value: base64url header with `alg` and `typ`, any payload, any signature. */
function jwtShapedToken(): string {
  const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'user' })}.signature`;
}

function lastStorageEvidence(): ContentSensorEvidence | undefined {
  return sent.filter((evidence) => evidence.signal === 'storage').at(-1);
}

/** The page re-renders after its own change, as a page does when it signs in or out. */
async function pageRerenders(): Promise<void> {
  document.body.appendChild(document.createElement('div'));
  await vi.advanceTimersByTimeAsync(DOM_SENSOR_MUTATION_DEBOUNCE_MS + 1);
}

describe('entrypoints/content.ts: the page changes its own storage', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = '';
    sent.length = 0;
    const mod = await import('../../entrypoints/content');
    // The runtime context argument is not used by this content script.
    (mod.default.main as () => void)();
    expect(lastStorageEvidence()).toEqual({ signal: 'storage', observed: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a token the page saves and then deletes itself is followed when the page re-renders', async () => {
    localStorage.setItem('auth_token', jwtShapedToken());
    await pageRerenders();
    expect(lastStorageEvidence()).toMatchObject({ signal: 'storage', observed: true });

    localStorage.removeItem('auth_token');
    await pageRerenders();
    expect(lastStorageEvidence()).toEqual({ signal: 'storage', observed: false });
  });

  it('a token the page saves and then deletes itself is followed when the user comes back to the tab', () => {
    localStorage.setItem('auth_token', jwtShapedToken());
    document.dispatchEvent(new Event('visibilitychange'));
    expect(lastStorageEvidence()).toMatchObject({ signal: 'storage', observed: true });

    localStorage.removeItem('auth_token');
    window.dispatchEvent(new Event('focus'));
    expect(lastStorageEvidence()).toEqual({ signal: 'storage', observed: false });
  });
});
