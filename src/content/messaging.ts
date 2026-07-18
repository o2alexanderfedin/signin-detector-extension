import { defineExtensionMessaging, type ExtensionMessage } from '@webext-core/messaging';

import type { SensorSignalMessage, SignalEvidence, VerdictResult, VerdictUpdateMessage } from '../shared/types';

/**
 * The subset of `SignalEvidence` a content-script sensor may ever send
 * (PLT-02 / PRV-01): `storage` and `dom` only -- `cookie`/`network`
 * evidence is produced entirely inside the background service worker
 * (which alone has the `chrome.cookies`/`chrome.webRequest` permissions)
 * and never crosses this boundary. Both `storageSensor.ts` and
 * `domSensor.ts` already narrow their `getEvidence()` return types to
 * exactly one member of this union, so their output flows into
 * `sendSensorSignal` below with no cast at the call site.
 */
export type ContentSensorEvidence = Extract<SignalEvidence, { readonly signal: 'storage' | 'dom' }>;

/**
 * Typed one-shot messaging protocol (PLT-02). Defined once and imported
 * from both the content script and the background service worker so both
 * sides share the exact same compile-time contract. Every message type
 * carries one of the FROZEN `shared/types.ts` message contracts as its
 * payload -- booleans/enums/numbers only, NEVER a raw cookie/token/storage
 * value (PRV-01).
 */
interface ProtocolMap {
  /** content -> SW: a single sensor's freshly classified evidence, sent as a single one-shot message (no long-lived port). */
  sensorSignal(message: SensorSignalMessage): void;
  /** SW -> content (a specific tab): the fused verdict, consumed by the border overlay. */
  verdictUpdate(message: VerdictUpdateMessage): void;
}

/**
 * The single messenger instance for this protocol, backed by
 * `browser.runtime.sendMessage`/`browser.tabs.sendMessage`. Shared by both
 * the `send*`/`on*` helpers below -- content and background code both
 * import THIS module rather than constructing their own messenger, so
 * they can never drift onto incompatible wire formats.
 */
const messenger = defineExtensionMessaging<ProtocolMap>();

/**
 * Sends one content-script sensor's evidence to the background service
 * worker as a single one-shot `runtime.sendMessage` call (PLT-02) -- no
 * long-lived port. Rejects if no `onSensorSignal` receiver is registered
 * on the SW side yet (mirrors `chrome.runtime.sendMessage`'s "no
 * listener" failure mode).
 */
export function sendSensorSignal(evidence: ContentSensorEvidence): Promise<void> {
  return messenger.sendMessage('sensorSignal', {
    type: 'SENSOR_SIGNAL',
    signal: evidence.signal,
    evidence,
  });
}

/**
 * Registers the SW-side receiver for content-script sensor signals.
 * `sender` is the library-provided message-sender info -- background code
 * may read `sender.tab?.id` to know which tab the evidence came from; the
 * payload itself never carries a tab id. Only one receiver may be
 * registered per JS context at a time (`@webext-core/messaging`
 * constraint) -- call the returned unsubscribe function before
 * registering a new one.
 */
export function onSensorSignal(
  handler: (message: SensorSignalMessage, sender: ExtensionMessage['sender']) => void,
): () => void {
  return messenger.onMessage('sensorSignal', (message) => {
    handler(message.data, message.sender);
  });
}

/**
 * Sends the fused verdict from the background service worker to one
 * specific tab's content script, targeted by `tabId` (consumed by the
 * border overlay to decide show/hide).
 */
export function sendVerdictUpdate(result: VerdictResult, tabId: number): Promise<void> {
  return messenger.sendMessage('verdictUpdate', { type: 'VERDICT_UPDATE', result }, tabId);
}

/**
 * Registers the content-script-side receiver for verdict updates. Only
 * one receiver may be registered per JS context at a time -- call the
 * returned unsubscribe function before registering a new one.
 */
export function onVerdictUpdate(handler: (result: VerdictResult) => void): () => void {
  return messenger.onMessage('verdictUpdate', (message) => {
    handler(message.data.result);
  });
}
