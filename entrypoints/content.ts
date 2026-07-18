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

    // DOM sensor's own debounced MutationObserver re-scan (SEN-05) -- every
    // settled batch of DOM mutations re-sends fresh evidence.
    domSensor.watch((evidence) => {
      sendSensorSignal(evidence).catch(reportSensorError);
    });

    // `storageSensor.ts` has no push API of its own (SEN-04 is a one-shot
    // read) -- the native DOM `storage` event (RCT-01's "storage events"
    // trigger) fires in this frame whenever localStorage/sessionStorage
    // changes in another same-origin context, so re-run the existing
    // one-shot sensor on that event rather than polling.
    window.addEventListener('storage', sendStorageEvidence);

    // The border overlay is driven ENTIRELY by inbound verdicts -- never by
    // anything computed locally (BDR-01/BDR-04).
    onVerdictUpdate((result) => {
      overlay.show(result.state);
    });
  },
});
