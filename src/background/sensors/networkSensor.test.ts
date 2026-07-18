/// <reference types="chrome" />

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NETWORK_GRAPHQL_200_VALUE,
  NETWORK_REST_IDENTITY_200_VALUE,
  STRONG_NEGATIVE_VALUE,
} from '../../shared/constants';
import { createNetworkSensor, type WebRequestApi } from './networkSensor';

/**
 * Background network sensor glue (Phase 3, workstream 1).
 *
 * `@webext-core/fake-browser` does not implement `chrome.webRequest`
 * either, so -- same as `cookieSensor.test.ts` -- we hand-roll a minimal
 * fake for exactly the `WebRequestApi` subset (`onCompleted.addListener`
 * / `removeListener`) this sensor depends on.
 */

interface FakeWebRequestApi {
  readonly api: WebRequestApi;
  trigger(details: chrome.webRequest.OnCompletedDetails): void;
  listenerCount(): number;
  lastFilter(): chrome.webRequest.RequestFilter | undefined;
  lastExtraInfoSpec(): readonly string[] | undefined;
}

function createFakeWebRequestApi(): FakeWebRequestApi {
  const listeners: Array<(details: chrome.webRequest.OnCompletedDetails) => void> = [];
  let filter: chrome.webRequest.RequestFilter | undefined;
  let extraInfoSpec: readonly string[] | undefined;

  return {
    api: {
      onCompleted: {
        addListener: (callback, f, spec) => {
          listeners.push(callback);
          filter = f;
          extraInfoSpec = spec;
        },
        removeListener: (callback) => {
          const index = listeners.indexOf(callback);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        },
      },
    },
    trigger(details) {
      listeners.forEach((listener) => listener(details));
    },
    listenerCount() {
      return listeners.length;
    },
    lastFilter() {
      return filter;
    },
    lastExtraInfoSpec() {
      return extraInfoSpec;
    },
  };
}

function completedDetails(
  overrides: Partial<chrome.webRequest.OnCompletedDetails> = {},
): chrome.webRequest.OnCompletedDetails {
  return {
    documentLifecycle: 'active',
    frameId: 0,
    frameType: 'outermost_frame',
    method: 'GET',
    parentFrameId: -1,
    requestId: '1',
    tabId: 1,
    timeStamp: Date.now(),
    type: 'xmlhttprequest',
    url: 'https://example.com/api/me',
    fromCache: false,
    responseHeaders: [],
    statusCode: 200,
    statusLine: 'HTTP/1.1 200 OK',
    ...overrides,
  };
}

describe('createNetworkSensor (background glue)', () => {
  let fake: FakeWebRequestApi;

  beforeEach(() => {
    fake = createFakeWebRequestApi();
  });

  describe('watch -- subscribes to chrome.webRequest.onCompleted', () => {
    it('registers a listener with a status/headers-only extraInfoSpec (no request body access, SEN-03/PRV-01)', () => {
      const sensor = createNetworkSensor(fake.api);
      sensor.watch(() => {});

      expect(fake.listenerCount()).toBe(1);
      expect(fake.lastExtraInfoSpec()).toEqual(['responseHeaders']);
    });

    it('passes a default RequestFilter matching all URLs when none is provided', () => {
      const sensor = createNetworkSensor(fake.api);
      sensor.watch(() => {});

      expect(fake.lastFilter()).toEqual({ urls: ['<all_urls>'] });
    });

    it('passes through a caller-supplied RequestFilter', () => {
      const sensor = createNetworkSensor(fake.api);
      const filter: chrome.webRequest.RequestFilter = { urls: ['*://example.com/*'] };
      sensor.watch(() => {}, filter);

      expect(fake.lastFilter()).toBe(filter);
    });

    it('maps a REST identity-shaped 200 completion into classifyNetwork input and emits NETWORK_REST_IDENTITY_200_VALUE', () => {
      const sensor = createNetworkSensor(fake.api);
      const onEvidence = vi.fn();
      sensor.watch(onEvidence);

      fake.trigger(completedDetails({ url: 'https://example.com/api/me', statusCode: 200 }));

      expect(onEvidence).toHaveBeenCalledWith({
        signal: 'network',
        observed: true,
        value: NETWORK_REST_IDENTITY_200_VALUE,
      });
    });

    it('maps a GraphQL-shaped 200 completion to the lower NETWORK_GRAPHQL_200_VALUE (soft-200 hedge, delegates to classifyNetwork)', () => {
      const sensor = createNetworkSensor(fake.api);
      const onEvidence = vi.fn();
      sensor.watch(onEvidence);

      fake.trigger(completedDetails({ url: 'https://example.com/graphql', statusCode: 200 }));

      expect(onEvidence).toHaveBeenCalledWith({
        signal: 'network',
        observed: true,
        value: NETWORK_GRAPHQL_200_VALUE,
      });
    });

    it('maps a 401 on an identity-shaped endpoint to STRONG_NEGATIVE_VALUE', () => {
      const sensor = createNetworkSensor(fake.api);
      const onEvidence = vi.fn();
      sensor.watch(onEvidence);

      fake.trigger(completedDetails({ url: 'https://example.com/api/session', statusCode: 401 }));

      expect(onEvidence).toHaveBeenCalledWith({
        signal: 'network',
        observed: true,
        value: STRONG_NEGATIVE_VALUE,
      });
    });

    it('emits observed:false for a non-identity-shaped URL, never inventing a value (delegates to classifyNetwork)', () => {
      const sensor = createNetworkSensor(fake.api);
      const onEvidence = vi.fn();
      sensor.watch(onEvidence);

      fake.trigger(completedDetails({ url: 'https://example.com/api/products', statusCode: 200 }));

      expect(onEvidence).toHaveBeenCalledWith({ signal: 'network', observed: false });
    });

    it('derives hasAuthorizationHeader from response headers only -- never inspects the response body', () => {
      const sensor = createNetworkSensor(fake.api);
      const onEvidence = vi.fn();
      sensor.watch(onEvidence);

      // hasAuthorizationHeader must never change the classification (per
      // classifyNetwork's own contract) -- this proves the mapping reads
      // headers only and the result is unaffected either way.
      fake.trigger(
        completedDetails({
          url: 'https://example.com/api/me',
          statusCode: 200,
          responseHeaders: [{ name: 'Authorization', value: 'Bearer xyz' }],
        }),
      );

      expect(onEvidence).toHaveBeenCalledWith({
        signal: 'network',
        observed: true,
        value: NETWORK_REST_IDENTITY_200_VALUE,
      });
    });

    it('returns an unsubscribe function that removes the listener', () => {
      const sensor = createNetworkSensor(fake.api);
      const unsubscribe = sensor.watch(() => {});
      expect(fake.listenerCount()).toBe(1);

      unsubscribe();

      expect(fake.listenerCount()).toBe(0);
    });

    it('no longer invokes onEvidence after unsubscribe', () => {
      const sensor = createNetworkSensor(fake.api);
      const onEvidence = vi.fn();
      const unsubscribe = sensor.watch(onEvidence);
      unsubscribe();

      fake.trigger(completedDetails({ url: 'https://example.com/api/me', statusCode: 200 }));

      expect(onEvidence).not.toHaveBeenCalled();
    });
  });
});
