import { createBorderOverlay } from '../src/content/overlay/borderOverlay';
import { onVerdictUpdate, sendSensorSignal } from '../src/content/messaging';
import { createDomSensor } from '../src/content/sensors/domSensor';
import { createStorageSensor } from '../src/content/sensors/storageSensor';

/**
 * The live content script (RCT-01 / PLT-02 / BDR-01..04). Runs ONLY in the
 * top frame (`allFrames: false`), at `document_idle`, on every page
 * (`matches: <all_urls>`). Deliberately THIN: it starts the ALREADY-TESTED
 * storage + DOM sensors, forwards their evidence to the service worker via
 * `content/messaging.ts` (never reimplementing classification), and drives
 * the ALREADY-TESTED border overlay purely off inbound `VERDICT_UPDATE`
 * messages -- no local verdict computation happens here.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: false,
  runAt: 'document_idle',
  main() {
    const storageSensor = createStorageSensor();
    const domSensor = createDomSensor();
    const overlay = createBorderOverlay();

    /** A rejected one-shot send (e.g. the SW hasn't finished waking yet) must never crash the content script. */
    function reportSensorError(error: unknown): void {
      console.error('[sign-in-detector] sensor signal error', error);
    }

    function sendStorageEvidence(): void {
      sendSensorSignal(storageSensor.getEvidence()).catch(reportSensorError);
    }

    // Initial one-shot reads on load -- the very first verdict recompute
    // for this tab doesn't have to wait for a subsequent mutation/event.
    sendStorageEvidence();
    sendSensorSignal(domSensor.getEvidence()).catch(reportSensorError);

    // `storageSensor.ts` has no push API of its own (SEN-04 is a one-shot
    // read), and the browser tells no page about its own storage writes:
    // the DOM `storage` event fires only for changes made in ANOTHER tab or
    // window of the same site. So the sensor is re-run at three moments,
    // none of them a poll:
    // - on the `storage` event (another tab of the site signed in or out);
    // - with every settled batch of DOM mutations below -- a page that
    //   saves or deletes its own token at sign-in or sign-out re-renders;
    // - when the user comes back to the tab (`visibilitychange` to
    //   visible, window `focus`), in case the page changed storage without
    //   re-rendering.
    window.addEventListener('storage', sendStorageEvidence);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        sendStorageEvidence();
      }
    });
    window.addEventListener('focus', sendStorageEvidence);

    // DOM sensor's own debounced MutationObserver re-scan (SEN-05) -- every
    // settled batch of DOM mutations re-sends fresh DOM and storage evidence.
    domSensor.watch((evidence) => {
      sendSensorSignal(evidence).catch(reportSensorError);
      sendStorageEvidence();
    });

    // The border overlay is driven ENTIRELY by inbound verdicts -- never by
    // anything computed locally (BDR-01/BDR-04).
    onVerdictUpdate((result) => {
      overlay.show(result.state);
    });
  },
});
