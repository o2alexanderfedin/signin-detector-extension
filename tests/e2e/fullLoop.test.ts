/// <reference types="chrome" />

import { fakeBrowser } from '@webext-core/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPipeline } from '../../src/background/pipeline';
import type { CookiesApi } from '../../src/background/sensors/cookieSensor';
import { createVerdictStore } from '../../src/background/state/verdictStore';
import { createBorderOverlay, type BorderOverlayHandle } from '../../src/content/overlay/borderOverlay';
import { onVerdictUpdate } from '../../src/content/messaging';
import {
  COOKIE_MIN_HIGH_ENTROPY_LENGTH,
  COOKIE_MIN_LONG_EXPIRY_MS,
  DEBOUNCE_SIGNED_OUT_MS,
} from '../../src/shared/constants';

/**
 * Phase 4 full end-to-end loop (RCT-01 / PLT-01 / PLT-02 / BDR-01/BDR-04):
 * a real `chrome.cookies.onChanged` event, through the background
 * `Pipeline`, over the REAL `content/messaging.ts` wire (not an injected
 * spy), driving a REAL `borderOverlay` instance on the "content" side --
 * i.e. every already-tested unit this phase composes, wired together
 * exactly as `entrypoints/background.ts` / `entrypoints/content.ts` wire
 * them, minus the WXT entrypoint wrappers themselves (covered separately
 * by `tests/entrypoints/background.test.ts`'s PLT-03 test).
 *
 * `chrome`/`browser` are globally stubbed to the SAME `fakeBrowser`
 * instance (WXT's Vitest plugin) -- `chrome.tabs.sendMessage` is not
 * implemented by fake-browser, so it's forwarded onto the working
 * `chrome.runtime.sendMessage` fake, exactly as `content/messaging.test.ts`
 * already does for the very same reason.
 */

const NOW = 1_700_000_000_000;
const TAB_URL = 'https://example.com/dashboard';
const COOKIE_DOMAIN = 'example.com';

const longValue = 'a'.repeat(COOKIE_MIN_HIGH_ENTROPY_LENGTH);
const longExpirySeconds = (NOW + COOKIE_MIN_LONG_EXPIRY_MS + 1000) / 1000;

function fullMatchCookie(overrides: Partial<chrome.cookies.Cookie> = {}): chrome.cookies.Cookie {
  return {
    domain: COOKIE_DOMAIN,
    name: 'session_id',
    httpOnly: true,
    secure: true,
    value: longValue,
    expirationDate: longExpirySeconds,
    session: false,
    hostOnly: true,
    path: '/',
    storeId: '0',
    sameSite: 'lax',
    ...overrides,
  };
}

interface FakeCookiesApi {
  readonly api: CookiesApi;
  setCookies(cookies: readonly chrome.cookies.Cookie[]): void;
}

function createFakeCookiesApi(initial: readonly chrome.cookies.Cookie[] = []): FakeCookiesApi {
  let cookies = [...initial];
  const getAll = vi.fn((details: chrome.cookies.GetAllDetails) => {
    if (details.domain === undefined) {
      return Promise.resolve(cookies);
    }
    return Promise.resolve(
      cookies.filter((cookie) => cookie.domain === details.domain || cookie.domain.endsWith(`.${details.domain}`)),
    );
  }) as unknown as CookiesApi['getAll'];

  return {
    api: { getAll, onChanged: { addListener: () => {}, removeListener: () => {} } },
    setCookies(next) {
      cookies = [...next];
    },
  };
}

// `@webext-core/fake-browser` does not implement `tabs.sendMessage` --
// forward it onto the working `runtime.sendMessage` fake, exactly as
// `content/messaging.test.ts` does (see its identical named-function +
// eslint-disable comment for why this must be a separately-typed named
// function rather than an inline arrow).
function forwardTabsSendMessageToRuntime(_tabId: number, message: unknown): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

describe('Phase 4 full loop: cookie appears -> VERDICT_UPDATE -> border shows; cookie disappears -> border hides', () => {
  let overlay: BorderOverlayHandle;
  let unsubscribeVerdict: (() => void) | undefined;

  beforeEach(() => {
    fakeBrowser.reset();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- false positive: `chrome.tabs.sendMessage`'s LAST declared overload (what utility-type-based contextual typing resolves to) is the void-returning 4-arg callback form, but the real API -- and our mock -- return a Promise when called without a callback (exactly how `sendVerdictUpdate` calls it). `tsc --noEmit` is clean; no unhandled rejection here.
    vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(forwardTabsSendMessageToRuntime);
    overlay = createBorderOverlay({ isTopFrame: () => true });
  });

  afterEach(() => {
    unsubscribeVerdict?.();
    unsubscribeVerdict = undefined;
    overlay.hide();
    vi.restoreAllMocks();
  });

  it('drives the content-side border overlay purely off real VERDICT_UPDATE messages sent by the pipeline', async () => {
    const tab = await fakeBrowser.tabs.create({ url: TAB_URL });
    const fakeCookies = createFakeCookiesApi([fullMatchCookie()]);

    // Content side: subscribes to verdict updates exactly like `entrypoints/content.ts` does.
    unsubscribeVerdict = onVerdictUpdate((result) => {
      overlay.show(result.state);
    });

    expect(overlay.root).toBeNull();

    let now = NOW;
    // Background side: the real orchestrator, using the REAL (not injected)
    // `sendVerdictUpdate` from `content/messaging.ts` -- exactly what
    // `entrypoints/background.ts` constructs.
    const pipeline = createPipeline({
      store: createVerdictStore(),
      cookiesApi: fakeCookies.api,
      clock: () => now,
    });

    // 1. A full-match session cookie appears for this tab's domain.
    await pipeline.handleCookieChanged({ removed: false, cause: 'explicit', cookie: fullMatchCookie() });

    expect(overlay.root).not.toBeNull(); // border rendered (BDR-01)

    // 2. The cookie disappears; SignedOut is debounced (ENG-04) so the
    // border must NOT vanish on this same tick.
    fakeCookies.setCookies([]);
    await pipeline.handleCookieChanged({ removed: true, cause: 'expired', cookie: fullMatchCookie() });

    expect(overlay.root).not.toBeNull();

    // 3. Once the debounce window elapses and another event confirms the
    // absence, the verdict commits to signed-out and the border hides.
    now += DEBOUNCE_SIGNED_OUT_MS + 1;
    await pipeline.handleCookieChanged({ removed: true, cause: 'expired', cookie: fullMatchCookie() });

    expect(overlay.root).toBeNull(); // border removed (BDR-04-adjacent: hides when not signed-in)

    void tab;
  });
});
