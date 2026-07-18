import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
// manifestVersion is forced to 3 for both Chrome and Firefox build targets
// (WXT otherwise defaults Firefox output to MV2) -- this project's
// constraint is one consistent MV3 manifest across both browsers.
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    // `cookies`/`webRequest` back the background sensors (SEN-01/SEN-03),
    // `storage` backs `chrome.storage.session` (PLT-01's verdictStore),
    // `scripting` is required by MV3 for the content-script injection WXT
    // configures via `entrypoints/content.ts`'s `defineContentScript`.
    permissions: ['cookies', 'webRequest', 'storage', 'scripting'],
    // Broad by necessity -- the detector must observe cookies/network/DOM
    // on ANY site the user is signed into, not a fixed allowlist.
    //
    // KNOWN SHIP-TIMELINE RISK (documented, not a Phase 4 blocker):
    // `<all_urls>` host_permissions combined with the `webRequest`
    // permission is one of the patterns that triggers the Chrome Web
    // Store's mandatory deep/manual review queue (rather than automated
    // review), which can add days-to-weeks to the review timeline for any
    // submission. See https://developer.chrome.com/docs/webstore/review-process
    // and https://developer.chrome.com/docs/extensions/develop/migrate/improve-security#permissions.
    // Revisit narrowing this (e.g. optional_host_permissions requested
    // on demand) if store review latency becomes a real constraint.
    host_permissions: ['<all_urls>'],
  },
});
