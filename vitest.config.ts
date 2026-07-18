import { configDefaults, defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    // The Playwright e2e harness (`npm run test:e2e`, tests/e2e/playwright/)
    // has its own *.spec.ts files that import `@playwright/test`, not
    // vitest -- excluded here so `npm test` never tries to execute them as
    // unit tests. Spread vitest's own defaults (rather than replacing them
    // outright) so node_modules/etc. stay excluded too.
    exclude: [...configDefaults.exclude, 'tests/e2e/playwright/**'],
  },
});
