import { configDefaults, defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    // Node 25 enables its own Web Storage by default: a global `localStorage`
    // that, without --localstorage-file, is an empty object with no methods,
    // and it shadows happy-dom's. Turn it off so tests see the DOM's storage.
    execArgv: ['--no-experimental-webstorage'],
    // The Playwright e2e harness (`npm run test:e2e`, tests/e2e/playwright/)
    // has its own *.spec.ts files that import `@playwright/test`, not
    // vitest -- excluded here so `npm test` never tries to execute them as
    // unit tests. Spread vitest's own defaults (rather than replacing them
    // outright) so node_modules/etc. stay excluded too.
    exclude: [...configDefaults.exclude, 'tests/e2e/playwright/**'],
  },
});
