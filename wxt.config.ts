import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
// manifestVersion is forced to 3 for both Chrome and Firefox build targets
// (WXT otherwise defaults Firefox output to MV2) -- this project's
// constraint is one consistent MV3 manifest across both browsers.
export default defineConfig({
  manifestVersion: 3,
});
