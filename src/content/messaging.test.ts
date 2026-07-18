/// <reference types="chrome" />

import { fakeBrowser } from '@webext-core/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOM_POSITIVE_VALUE, STORAGE_POSITIVE_VALUE } from '../shared/constants';
import type { SensorSignalMessage, VerdictResult } from '../shared/types';
import {
  onSensorSignal,
  onVerdictUpdate,
  sendSensorSignal,
  sendVerdictUpdate,
  type ContentSensorEvidence,
} from './messaging';
import { createDomSensor } from './sensors/domSensor';
import { createStorageSensor } from './sensors/storageSensor';

/**
 * PLT-02 -- typed one-shot messaging tests. `chrome`/`browser` are
 * globally stubbed to the SAME `fakeBrowser` instance by WXT's Vitest
 * plugin (see vitest.config.ts and verdictStore.test.ts's identical
 * note).
 *
 * `@webext-core/messaging` allows only ONE listener per message type per
 * JS context -- every test that registers a receiver captures its
 * unsubscribe function below, cleaned up in `afterEach`, or the next
 * test's `onMessage` call throws "only one listener can be setup".
 */

const STORAGE_EVIDENCE: ContentSensorEvidence = {
  signal: 'storage',
  observed: true,
  value: STORAGE_POSITIVE_VALUE,
};
const DOM_EVIDENCE: ContentSensorEvidence = {
  signal: 'dom',
  observed: true,
  value: DOM_POSITIVE_VALUE,
  passwordFormVisible: false,
};
const UNOBSERVED_EVIDENCE: ContentSensorEvidence = { signal: 'storage', observed: false };

const VERDICT_RESULT: VerdictResult = { state: 'signed-in', confidence: 0.9 };

describe('messaging.ts (PLT-02)', () => {
  let unsubscribeSensor: (() => void) | undefined;
  let unsubscribeVerdict: (() => void) | undefined;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  afterEach(() => {
    unsubscribeSensor?.();
    unsubscribeSensor = undefined;
    unsubscribeVerdict?.();
    unsubscribeVerdict = undefined;
    vi.restoreAllMocks();
  });

  describe('sendSensorSignal / onSensorSignal (content -> SW)', () => {
    it('delivers storage evidence verbatim, wrapped in the frozen SensorSignalMessage contract', async () => {
      const received: SensorSignalMessage[] = [];
      unsubscribeSensor = onSensorSignal((message) => received.push(message));

      await sendSensorSignal(STORAGE_EVIDENCE);

      expect(received).toEqual([{ type: 'SENSOR_SIGNAL', signal: 'storage', evidence: STORAGE_EVIDENCE }]);
    });

    it('delivers dom evidence verbatim, including passwordFormVisible', async () => {
      const received: SensorSignalMessage[] = [];
      unsubscribeSensor = onSensorSignal((message) => received.push(message));

      await sendSensorSignal(DOM_EVIDENCE);

      expect(received).toEqual([{ type: 'SENSOR_SIGNAL', signal: 'dom', evidence: DOM_EVIDENCE }]);
    });

    it('delivers observed:false evidence correctly (no value field)', async () => {
      const received: SensorSignalMessage[] = [];
      unsubscribeSensor = onSensorSignal((message) => received.push(message));

      await sendSensorSignal(UNOBSERVED_EVIDENCE);

      expect(received).toEqual([
        { type: 'SENSOR_SIGNAL', signal: 'storage', evidence: { signal: 'storage', observed: false } },
      ]);
    });

    it('passes the library-provided sender info through to the handler', async () => {
      let sender: unknown;
      unsubscribeSensor = onSensorSignal((_message, s) => {
        sender = s;
      });

      await sendSensorSignal(STORAGE_EVIDENCE);

      expect(sender).toBeDefined();
    });

    it('rejects when no onSensorSignal receiver is registered yet (mirrors runtime.sendMessage "no listener")', async () => {
      await expect(sendSensorSignal(STORAGE_EVIDENCE)).rejects.toThrow();
    });

    it('unsubscribe stops delivery and allows re-registering a new receiver', async () => {
      const first = vi.fn();
      const unsubscribe = onSensorSignal(first);
      unsubscribe();

      const second: SensorSignalMessage[] = [];
      unsubscribeSensor = onSensorSignal((message) => second.push(message));
      await sendSensorSignal(STORAGE_EVIDENCE);

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveLength(1);
    });
  });

  describe('sendVerdictUpdate / onVerdictUpdate (SW -> content, targeted by tabId)', () => {
    const TAB_ID = 7;

    // `@webext-core/fake-browser` does not implement `tabs.sendMessage`
    // (it throws "not implemented" -- only `runtime.sendMessage` has a
    // real in-memory implementation). Forward it onto the already-working
    // `runtime.sendMessage` fake, which delivers to the same shared
    // `runtime.onMessage` bus a real content script's `onMessage` listener
    // also fires on for a `tabs.sendMessage`-targeted message. Declared as
    // a separately-typed named function (rather than inline) so its
    // `Promise<unknown>` return type is fixed by us, not contextually
    // inferred against `chrome.tabs.sendMessage`'s last (void-returning,
    // callback-style) overload.
    function forwardTabsSendMessageToRuntime(_tabId: number, message: unknown): Promise<unknown> {
      return chrome.runtime.sendMessage(message);
    }

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- false positive: `chrome.tabs.sendMessage`'s LAST declared overload (what utility-type-based contextual typing resolves to) is the void-returning 4-arg callback form, but the real API -- and our mock -- return a Promise when called without a callback (exactly how `sendVerdictUpdate` calls it). `tsc --noEmit` is clean; no unhandled rejection here.
      vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(forwardTabsSendMessageToRuntime);
    });

    it('delivers the fused verdict verbatim, wrapped in the frozen VerdictUpdateMessage contract', async () => {
      const received: VerdictResult[] = [];
      unsubscribeVerdict = onVerdictUpdate((result) => received.push(result));

      await sendVerdictUpdate(VERDICT_RESULT, TAB_ID);

      expect(received).toEqual([VERDICT_RESULT]);
    });

    it('targets the given tabId', async () => {
      unsubscribeVerdict = onVerdictUpdate(() => {});

      await sendVerdictUpdate(VERDICT_RESULT, TAB_ID);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
      const mockedSendMessage = chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
      expect(mockedSendMessage.mock.calls[0]?.[0]).toBe(TAB_ID);
    });

    it('unsubscribe stops delivery', async () => {
      const received: VerdictResult[] = [];
      const unsubscribe = onVerdictUpdate((result) => received.push(result));
      unsubscribe();

      await expect(sendVerdictUpdate(VERDICT_RESULT, TAB_ID)).rejects.toThrow();
      expect(received).toEqual([]);
    });
  });

  describe('privacy boundary (PRV-01): payload shape', () => {
    it('the wire message for a sensor signal contains only signal/observed/value/passwordFormVisible-shaped evidence -- never an extra raw field', async () => {
      const received: SensorSignalMessage[] = [];
      unsubscribeSensor = onSensorSignal((message) => received.push(message));

      await sendSensorSignal(DOM_EVIDENCE);

      const [message] = received;
      expect(message).toBeDefined();
      const evidenceKeys = Object.keys(message?.evidence ?? {}).sort();
      expect(evidenceKeys).toEqual(['observed', 'passwordFormVisible', 'signal', 'value']);
      // The only string field is the fixed enum discriminator `signal`
      // ('dom'/'storage') -- everything else is boolean/number, never an
      // arbitrary/raw cookie or token value (PRV-01).
      expect(['dom', 'storage']).toContain(message?.evidence.signal);
      Object.entries(message?.evidence ?? {}).forEach(([key, value]) => {
        if (key === 'signal') {
          expect(typeof value).toBe('string');
        } else {
          expect(['boolean', 'number']).toContain(typeof value);
        }
      });
    });
  });

  describe('integration: sensor glue output flows directly into sendSensorSignal (no cast)', () => {
    it('storageSensor.getEvidence() -> sendSensorSignal -> onSensorSignal round-trips correctly', async () => {
      const sensor = createStorageSensor({
        local: {
          length: 1,
          key: (index) => (index === 0 ? 'authToken' : null),
          getItem: (key) => (key === 'authToken' ? 'plain-opaque-string' : null),
        },
        session: { length: 0, key: () => null, getItem: () => null },
      });
      const received: SensorSignalMessage[] = [];
      unsubscribeSensor = onSensorSignal((message) => received.push(message));

      const evidence = sensor.getEvidence();
      await sendSensorSignal(evidence);

      expect(received).toEqual([{ type: 'SENSOR_SIGNAL', signal: 'storage', evidence }]);
    });

    it('domSensor.getEvidence() -> sendSensorSignal -> onSensorSignal round-trips correctly', async () => {
      const container = document.createElement('div');
      const button = document.createElement('button');
      button.textContent = 'Sign out';
      container.appendChild(button);

      const sensor = createDomSensor({ root: container });
      const received: SensorSignalMessage[] = [];
      unsubscribeSensor = onSensorSignal((message) => received.push(message));

      const evidence = sensor.getEvidence();
      await sendSensorSignal(evidence);

      expect(received).toEqual([{ type: 'SENSOR_SIGNAL', signal: 'dom', evidence }]);
    });
  });
});
