/// <reference types="chrome" />

import { classifyNetwork, type NetworkRequestInput } from '../../sensors/network/classify';
import type { SignalEvidence } from '../../shared/types';

/**
 * The subset of `chrome.webRequest` this sensor depends on -- injectable
 * so it's unit-testable without a real browser. `@webext-core/fake-browser`
 * does not implement `chrome.webRequest` (see `networkSensor.test.ts`),
 * so this narrow shape is what test fakes need to satisfy -- the same
 * "inject the chrome namespace" pattern `cookieSensor.ts` uses.
 */
export interface WebRequestApi {
  onCompleted: Pick<typeof chrome.webRequest.onCompleted, 'addListener' | 'removeListener'>;
}

export interface NetworkSensor {
  /**
   * Subscribes to `chrome.webRequest.onCompleted` -- status code and
   * response headers only, the request body is never requested or read
   * (SEN-03 / PRV-01) -- maps every completed request into the pure
   * `classifyNetwork` classifier's input shape, and invokes `onEvidence`
   * with its result. This module never scores a request itself -- it
   * only adapts real Chrome data into the classifier's input shape.
   * Returns an unsubscribe function.
   */
  watch(
    onEvidence: (evidence: SignalEvidence) => void,
    filter?: chrome.webRequest.RequestFilter,
  ): () => void;
}

/** No caller-supplied filter -- observe every completed request. */
const DEFAULT_FILTER: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'] };

/** Header presence check only -- never reads a header's value for meaning. */
function hasAuthorizationHeader(headers: readonly chrome.webRequest.HttpHeader[] | undefined): boolean {
  return (headers ?? []).some((header) => header.name.toLowerCase() === 'authorization');
}

/**
 * Maps a real `chrome.webRequest.OnCompletedDetails` into the pure
 * classifier's `NetworkRequestInput` shape. Only `url`, `statusCode`, and
 * response header presence are read -- the response body is never
 * requested (no `extraHeaders`/body extraInfoSpec is used).
 */
function toNetworkRequestInput(details: chrome.webRequest.OnCompletedDetails): NetworkRequestInput {
  return {
    url: details.url,
    statusCode: details.statusCode,
    hasAuthorizationHeader: hasAuthorizationHeader(details.responseHeaders),
  };
}

/**
 * Creates a {@link NetworkSensor}. `webRequestApi` defaults to the real
 * `chrome.webRequest` and is injectable for testing.
 */
export function createNetworkSensor(webRequestApi: WebRequestApi = chrome.webRequest): NetworkSensor {
  function watch(
    onEvidence: (evidence: SignalEvidence) => void,
    filter: chrome.webRequest.RequestFilter = DEFAULT_FILTER,
  ): () => void {
    const listener = (details: chrome.webRequest.OnCompletedDetails): void => {
      onEvidence(classifyNetwork(toNetworkRequestInput(details)));
    };

    webRequestApi.onCompleted.addListener(listener, filter, ['responseHeaders']);
    return () => webRequestApi.onCompleted.removeListener(listener);
  }

  return { watch };
}
