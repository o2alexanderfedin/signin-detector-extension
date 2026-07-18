import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, test as base, type BrowserContext } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..', '..', '..', '.output', 'chrome-mv3');

/**
 * `E2E_HEADED=1` runs a real headed Chromium window (useful for local
 * debugging with a display attached). Defaults to headless. Chrome
 * extensions only load in the modern `--headless=new` mode (Chromium
 * 112+) -- legacy `headless: true` silently refuses to load unpacked
 * extensions, which is why headless is driven via the explicit CLI flag
 * below rather than Playwright's own `headless` launch option.
 */
const HEADED = process.env.E2E_HEADED === '1';

/**
 * `fixture-app.test` is the hostname the local fixture server
 * (`fixtures/server.ts`) is addressed by in every spec -- `.test` is an
 * IANA/RFC 2606-reserved TLD ("Special-Use Domain Names") set aside
 * specifically for testing, never a live registrable domain, and `tldts`
 * (this repo's `resolveWebAppKey`, see `src/identity/appIdentity.ts`)
 * resolves it to a stable eTLD+1 (`fixture-app.test` itself) without any
 * real DNS lookup. `--host-resolver-rules` below maps it to loopback --
 * this is the standard Chromium technique for "fake domain, real local
 * server" testing without touching `/etc/hosts`.
 */
export const FIXTURE_HOST = 'fixture-app.test';

interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
}

/**
 * Extends Playwright's base `test` with an extension-loaded persistent
 * `context` + its resolved `extensionId`, following Playwright's
 * documented Chrome-extension-testing pattern
 * (https://playwright.dev/docs/chrome-extensions). `launchPersistentContext`
 * is required here -- extensions cannot be loaded into an ordinary
 * `browser.newContext()`.
 */
export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture-function signature requires the (possibly-empty) dependency-fixtures object as the first param even when this fixture depends on none.
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      // `exactOptionalPropertyTypes` forbids `headless: undefined` -- omit
      // the key entirely (Playwright's own default) rather than assign it.
      ...(HEADED ? { headless: false } : {}),
      args: [
        ...(HEADED ? [] : ['--headless=new']),
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        // Sandboxed CI/dev-container environments frequently lack the
        // setuid sandbox helper; harmless on a normal desktop.
        '--no-sandbox',
        `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1`,
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // MV3: the extension's own service worker registers on load. It may
    // already be running (fast machines) or still be starting.
    let [background] = context.serviceWorkers();
    background ??= await context.waitForEvent('serviceworker');
    const extensionId = background.url().split('/')[2];
    if (extensionId === undefined) {
      throw new Error(`[e2e] could not parse extensionId from service worker URL: ${background.url()}`);
    }
    await use(extensionId);
  },
});

export const expect = test.expect;
