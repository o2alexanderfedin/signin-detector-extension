import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Phase 5 (Validation & Hardening) e2e harness -- criterion 1.
 *
 * Loads the REAL built unpacked extension (`.output/chrome-mv3`, produced
 * by `wxt build`) into a real Chromium via
 * `chromium.launchPersistentContext` (see `fixtures.ts`), against a LOCAL
 * fixture web server (`fixtures/server.ts`, loopback-only -- no real
 * external site is ever contacted), and asserts the content script's
 * closed-shadow border host (`BORDER_OVERLAY_HOST_ID`,
 * `src/shared/constants.ts`) appears/disappears with the fused verdict.
 *
 * PREREQUISITE: `globalSetup` below runs `npm run build` (== `wxt build`)
 * once before any test/browser starts, so `.output/chrome-mv3` always
 * exists when Chromium launches -- see `global-setup.ts`'s doc comment.
 * `npx playwright install chromium` must also have been run at least once
 * on this machine (not automated here -- it downloads a browser binary).
 *
 * Deliberately separate from `vitest.config.ts` (`npm run test:e2e` here
 * vs. `npm test`) -- see `vitest.config.ts`'s `exclude` entry for this
 * directory, and `package.json`'s `test:e2e` script.
 */
export default defineConfig({
  testDir: __dirname,
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  // A real Chromium launch + a real DEBOUNCE_SIGNED_OUT_MS (3s) real-time
  // wait (see border-overlay.spec.ts) is slower than the unit suite --
  // generous but bounded timeouts, no polling loops disguised as sleeps.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
