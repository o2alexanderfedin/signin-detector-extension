import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXTENSION_DIR = path.join(REPO_ROOT, '.output', 'chrome-mv3');
const MANIFEST_PATH = path.join(EXTENSION_DIR, 'manifest.json');

/**
 * This e2e harness loads the REAL unpacked MV3 build (not a mock) into
 * Chromium via `--load-extension` -- see `fixtures.ts`. That means a fresh
 * `wxt build` (`npm run build`) must have already produced
 * `.output/chrome-mv3` before Chromium ever launches.
 *
 * Rather than let that surface as an opaque "--load-extension path does
 * not exist" Chromium startup failure, this Playwright `globalSetup` runs
 * the build itself, once, before any test/browser starts -- `npm run
 * build` (== `wxt build`) is still documented as an explicit prerequisite
 * in `docs/MANUAL-TESTING.md` and this file's own doc comment for anyone
 * running `playwright test` directly (e.g. via the VS Code extension)
 * rather than through `npm run test:e2e`.
 */
export default function globalSetup(): void {
  console.log('[e2e/global-setup] Building the extension (`npm run build` == `wxt build`) before launching Chromium...');
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });

  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `[e2e/global-setup] Expected a built extension at ${MANIFEST_PATH} after \`npm run build\`, but it is missing. ` +
        'Run `npm run build` manually and inspect its output for the underlying failure.',
    );
  }
  console.log(`[e2e/global-setup] Extension build OK: ${EXTENSION_DIR}`);
}
