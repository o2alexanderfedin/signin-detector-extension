import {
  BORDER_OVERLAY_HOST_ID,
  COOKIE_MIN_HIGH_ENTROPY_LENGTH,
  DEBOUNCE_SIGNED_OUT_MS,
} from '../../../src/shared/constants';
import { expect, FIXTURE_HOST, test } from './fixtures';
import { startFixtureServer, type FixtureServer } from './fixtures/server';

declare global {
  interface Window {
    /** Installed by `fixtures/server.ts`'s served page -- re-pings the mocked identity endpoint on demand. */
    pingIdentity: () => Promise<number>;
  }
}

/**
 * Phase 5 e2e (criterion 1): loads the REAL built extension into a real
 * Chromium (via `fixtures.ts`'s `launchPersistentContext`), drives a LOCAL
 * fixture app (`fixtures/server.ts`, loopback-only), and asserts the
 * content script's closed-shadow border host mounts/unmounts with the
 * fused verdict -- exactly the observable behavior a real user sees,
 * exercising the actual MV3 service worker + content script, not the
 * fake-browser harness `tests/e2e/fullLoop.test.ts` already covers.
 *
 * Confidence math (see `src/engine/confidenceEngine.ts` / `shared/constants.ts`):
 *  - Signed-in: cookie is HttpOnly + long value + long expiry but served
 *    over plain HTTP (no TLS in this local fixture) so `secure` is false
 *    -> COOKIE_PARTIAL_VALUE (0.5, weight 1.0) + the mocked REST identity
 *    endpoint's 200 -> NETWORK_REST_IDENTITY_200_VALUE (1.0, weight 1.0)
 *    = (0.5 + 1.0) / (1.0 + 1.0) = 0.75 >= THRESHOLD_SIGNED_IN (0.7).
 *  - Signed-out: cookie cleared (evidence becomes `observed: false`,
 *    excluded from fusion) + identity endpoint 401 -> STRONG_NEGATIVE_VALUE
 *    (-1, weight 1.0) alone = -1 <= THRESHOLD_SIGNED_OUT (0.3). ENG-04's
 *    asymmetric debounce means this only *commits* on the SECOND such
 *    event, >= DEBOUNCE_SIGNED_OUT_MS after the first -- see the two
 *    `pingIdentity()` calls below, spaced by a real-time wait.
 *  - The fixture page itself has no interactive/affordance/avatar/
 *    password-form markup, so the content script's DOM sensor (and the
 *    unused storage sensor) stay `observed: false` throughout and never
 *    contaminate this signal math (see `fixtures/server.ts`'s doc comment).
 */
test.describe('extension e2e: border overlay tracks the fused sign-in verdict on a real Chromium + real built extension', () => {
  let fixtureServer: FixtureServer;

  test.beforeAll(async () => {
    fixtureServer = await startFixtureServer();
  });

  test.afterAll(async () => {
    await fixtureServer.close();
  });

  test('border appears on signed-in (cookie + identity 200), survives an in-app route/hash change, and clears on signed-out (401) after the debounce window', async ({
    context,
    extensionId,
  }) => {
    // Sanity: the extension actually loaded (a real MV3 service worker
    // registered under a real, well-formed extension id).
    expect(extensionId).toMatch(/^[a-z]{32}$/);

    const origin = `http://${FIXTURE_HOST}:${String(fixtureServer.port)}`;

    // 1. Arrange "signed-in": a session-shaped cookie present + the mocked
    // identity endpoint returning 200.
    await context.addCookies([
      {
        name: 'session_id',
        value: 'a'.repeat(COOKIE_MIN_HIGH_ENTROPY_LENGTH * 2),
        domain: FIXTURE_HOST,
        path: '/',
        httpOnly: true,
        secure: false,
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 2, // 2 days out
      },
    ]);
    fixtureServer.setSignedIn(true);

    const page = await context.newPage();
    await page.goto(`${origin}/`);

    const border = page.locator(`#${BORDER_OVERLAY_HOST_ID}`);
    // The fixture page's own inline `<script>` already fires one
    // `pingIdentity()` on load (see `fixtures/server.ts`), but that FIRST
    // request can race the background service worker's
    // `chrome.webRequest.onCompleted` listener becoming fully active
    // right after a fresh SW start (the JS `addListener` call itself is
    // synchronous per PLT-03, but Chromium's underlying network-stack
    // interception hook for a brand-new SW can trail it by a beat) -- a
    // single missed event then has nothing to trigger a retry, since
    // nothing else re-pings on its own. Re-firing `pingIdentity()`
    // ourselves inside `toPass()`'s retry loop, well after the SW is
    // already confirmed alive (`extensionId` above already waited for
    // it), makes this deterministic without weakening what's actually
    // being asserted -- the border must eventually reflect a genuine
    // fresh 200.
    await expect(async () => {
      await page.evaluate(() => window.pingIdentity());
      await expect(border).toBeAttached({ timeout: 1_000 });
    }).toPass({ timeout: 10_000, intervals: [250, 500, 1_000] });

    // 2. Same-eTLD+1 in-app navigation (hash change, then a pushState
    // route change) must NEVER remove/re-mount the border -- IDN-02: the
    // WebAppKey is derived from the host only, and nothing in the
    // pipeline (`src/background/pipeline.ts`) reacts to navigation at
    // all, so this asserts the SAME element instance stays connected
    // (not merely "an element with this id exists again", which would
    // also pass after a hide+re-show thrash).
    const borderHandle = await border.elementHandle();
    if (borderHandle === null) {
      throw new Error('expected the border host to be attached before exercising in-app navigation');
    }

    await page.evaluate(() => {
      location.hash = '#settings';
    });
    await page.waitForTimeout(300); // >= BORDER_OVERLAY_REASSERT_DEBOUNCE_MS, so a spurious self-heal cycle would have already fired
    expect(await borderHandle.evaluate((el) => el.isConnected)).toBe(true);

    await page.evaluate(() => {
      history.pushState({}, '', '/dashboard');
    });
    await page.waitForTimeout(300);
    expect(await borderHandle.evaluate((el) => el.isConnected)).toBe(true);

    // 3. Transition to "signed-out": cookie cleared + identity endpoint
    // now 401.
    fixtureServer.setSignedIn(false);
    await context.clearCookies({ domain: FIXTURE_HOST });
    await page.evaluate(() => window.pingIdentity());

    // ENG-04's asymmetric debounce: the FIRST below-threshold event only
    // starts the pending-signed-out timer -- the border must NOT drop
    // immediately (proves the debounce actually holds, not merely that it
    // eventually clears).
    await expect(border).toBeAttached();

    // Keep periodically re-firing the (still-401) identity ping until the
    // real DEBOUNCE_SIGNED_OUT_MS window has elapsed since whichever ping
    // first registered as the pending-signed-out start -- robust to
    // exactly which ping the background `webRequest` listener happens to
    // observe first (see the signed-in race note above), while still
    // exercising the real debounce window in real time rather than a
    // shortened/faked one.
    await expect(async () => {
      await page.evaluate(() => window.pingIdentity());
      await expect(border).not.toBeAttached({ timeout: 500 });
    }).toPass({ timeout: DEBOUNCE_SIGNED_OUT_MS + 10_000, intervals: [500, 1_000, 1_500] });
  });
});
