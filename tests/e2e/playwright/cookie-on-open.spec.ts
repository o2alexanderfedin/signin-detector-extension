import { BORDER_OVERLAY_HOST_ID } from '../../../src/shared/constants';
import { expect, FIXTURE_HOST, test } from './fixtures';
import { startFixtureServer, type FixtureServer } from './fixtures/server';

/**
 * A user who signed in earlier -- before this tab was opened -- must get the
 * same border as a user who signs in while the tab is open. The session
 * cookie is already in the browser, so no cookie "changes" while the page is
 * shown; the extension has to read it when the page first reports in.
 *
 * The `/plain` page never calls an identity endpoint, so the cookie is the
 * only evidence: Secure + HttpOnly + long value + 2-day expiry is a full
 * cookie score (1.0), alone above the 0.7 sign-in threshold.
 */
test.describe('extension e2e: a session cookie set before the tab opened counts', () => {
  let fixtureServer: FixtureServer;

  test.beforeAll(async () => {
    fixtureServer = await startFixtureServer();
  });

  test.afterAll(async () => {
    await fixtureServer.close();
  });

  test('a tab opened on a site the user is already signed in to shows the border, and so does a second tab', async ({
    context,
    extensionId,
  }) => {
    expect(extensionId).toMatch(/^[a-z]{32}$/);
    const origin = `http://${FIXTURE_HOST}:${String(fixtureServer.port)}`;

    await context.addCookies([
      {
        name: 'session_id',
        value: 'k'.repeat(48),
        domain: FIXTURE_HOST,
        path: '/',
        httpOnly: true,
        secure: true,
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 2,
      },
    ]);

    const first = await context.newPage();
    await first.goto(`${origin}/plain`);
    await expect(first.locator(`#${BORDER_OVERLAY_HOST_ID}`)).toBeAttached({ timeout: 15_000 });

    const second = await context.newPage();
    await second.goto(`${origin}/plain`);
    await expect(second.locator(`#${BORDER_OVERLAY_HOST_ID}`)).toBeAttached({ timeout: 15_000 });
  });
});
