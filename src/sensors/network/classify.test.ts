import { describe, expect, it } from 'vitest';

import {
  NETWORK_GRAPHQL_200_VALUE,
  NETWORK_REST_IDENTITY_200_VALUE,
  STRONG_NEGATIVE_VALUE,
} from '../../shared/constants';
import { classifyNetwork, type NetworkRequestInput } from './classify';

function req(overrides: Partial<NetworkRequestInput>): NetworkRequestInput {
  return {
    url: 'https://example.com/api/me',
    statusCode: 200,
    hasAuthorizationHeader: false,
    ...overrides,
  };
}

describe('classifyNetwork', () => {
  it('returns observed:false when the URL matches neither identity nor GraphQL patterns, regardless of status', () => {
    const result = classifyNetwork(
      req({ url: 'https://example.com/api/products', statusCode: 200 }),
    );
    expect(result).toEqual({ signal: 'network', observed: false });
  });

  it('returns NETWORK_REST_IDENTITY_200_VALUE for a REST identity-shaped URL with status 200', () => {
    const result = classifyNetwork(req({ url: 'https://example.com/api/me', statusCode: 200 }));
    expect(result).toEqual({
      signal: 'network',
      observed: true,
      value: NETWORK_REST_IDENTITY_200_VALUE,
    });
  });

  it('returns STRONG_NEGATIVE_VALUE for a REST identity-shaped URL with status 401', () => {
    const result = classifyNetwork(req({ url: 'https://example.com/api/me', statusCode: 401 }));
    expect(result).toEqual({
      signal: 'network',
      observed: true,
      value: STRONG_NEGATIVE_VALUE,
    });
  });

  it('returns STRONG_NEGATIVE_VALUE for a REST identity-shaped URL with status 403', () => {
    const result = classifyNetwork(
      req({ url: 'https://example.com/api/session', statusCode: 403 }),
    );
    expect(result).toEqual({
      signal: 'network',
      observed: true,
      value: STRONG_NEGATIVE_VALUE,
    });
  });

  it('returns a lower NETWORK_GRAPHQL_200_VALUE for a /graphql URL with status 200 (soft-200 hedge)', () => {
    const result = classifyNetwork(req({ url: 'https://example.com/graphql', statusCode: 200 }));
    expect(result).toEqual({
      signal: 'network',
      observed: true,
      value: NETWORK_GRAPHQL_200_VALUE,
    });
    expect(NETWORK_GRAPHQL_200_VALUE).toBeLessThan(NETWORK_REST_IDENTITY_200_VALUE);
  });

  it('returns STRONG_NEGATIVE_VALUE for a /graphql URL with status 401', () => {
    const result = classifyNetwork(req({ url: 'https://example.com/graphql', statusCode: 401 }));
    expect(result).toEqual({
      signal: 'network',
      observed: true,
      value: STRONG_NEGATIVE_VALUE,
    });
  });

  it('returns STRONG_NEGATIVE_VALUE for a /graphql URL with status 403', () => {
    const result = classifyNetwork(req({ url: 'https://example.com/graphql', statusCode: 403 }));
    expect(result).toEqual({
      signal: 'network',
      observed: true,
      value: STRONG_NEGATIVE_VALUE,
    });
  });

  it('returns observed:false for an identity-shaped URL with status 500 (inconclusive)', () => {
    const result = classifyNetwork(req({ url: 'https://example.com/api/me', statusCode: 500 }));
    expect(result).toEqual({ signal: 'network', observed: false });
  });

  it('does not change the score based on hasAuthorizationHeader presence', () => {
    const withHeader = classifyNetwork(
      req({ url: 'https://example.com/api/me', statusCode: 200, hasAuthorizationHeader: true }),
    );
    const withoutHeader = classifyNetwork(
      req({ url: 'https://example.com/api/me', statusCode: 200, hasAuthorizationHeader: false }),
    );
    expect(withHeader).toEqual(withoutHeader);
  });
});
