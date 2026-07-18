/// <reference types="chrome" />

import { createPipeline } from '../src/background/pipeline';
import { createVerdictStore } from '../src/background/state/verdictStore';
import { onSensorSignal, sendVerdictUpdate } from '../src/content/messaging';

/**
 * The live service worker (RCT-01 / PLT-01 / PLT-02 / PLT-03). This
 * entrypoint is deliberately THIN: it registers exactly the four listeners
 * the detection pipeline is driven by, and every callback does nothing but
 * delegate into `src/background/pipeline.ts` -- the actual orchestration
 * (per-tab engine, WebAppKey resolution, store persistence, outbound
 * messaging) lives there where it's unit-testable.
 *
 * PLT-03 -- MV3's #1 anti-pattern is registering listeners asynchronously
 * (e.g. behind an `await` or inside a `.then()`), which means they are
 * silently NOT re-attached after the service worker is suspended and woken
 * again, since Chrome only replays events to listeners that were attached
 * synchronously during the very first turn of the script's execution.
 * Every `addListener` call below -- and `onSensorSignal`'s own internal
 * `browser.runtime.onMessage.addListener` call inside
 * `content/messaging.ts` -- happens synchronously, with NO `await` or
 * `.then()` anywhere before it, at the top level of `defineBackground`'s
 * callback. WXT calls that callback synchronously immediately on script
 * load (see `wxt`'s generated background entrypoint), so this satisfies
 * MV3's real top-level-synchronous requirement.
 */
export default defineBackground(() => {
  const pipeline = createPipeline({
    store: createVerdictStore(),
    sendVerdictUpdate,
  });

  /** Errors are logged, never rethrown into the event dispatcher -- one bad tick must not stop future events from being handled. */
  function reportPipelineError(error: unknown): void {
    console.error('[sign-in-detector] pipeline error', error);
  }

  chrome.cookies.onChanged.addListener((changeInfo) => {
    pipeline.handleCookieChanged(changeInfo).catch(reportPipelineError);
  });

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      pipeline.handleNetworkCompleted(details).catch(reportPipelineError);
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );

  onSensorSignal((message, sender) => {
    pipeline.handleSensorSignal(message, sender).catch(reportPipelineError);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    pipeline.handleTabRemoved(tabId).catch(reportPipelineError);
  });
});
