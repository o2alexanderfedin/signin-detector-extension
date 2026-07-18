import {
  GRAPHQL_ENDPOINT_PATH_PATTERN,
  IDENTITY_ENDPOINT_PATH_PATTERNS,
  NETWORK_GRAPHQL_200_VALUE,
  NETWORK_REST_IDENTITY_200_VALUE,
  STRONG_NEGATIVE_VALUE,
} from '../../shared/constants';
import type { SignalEvidence } from '../../shared/types';

/**
 * A single observed request/response descriptor. Status/header only --
 * response bodies are never inspected (SEN-03).
 */
export interface NetworkRequestInput {
  readonly url: string;
  readonly statusCode: number;
  readonly hasAuthorizationHeader: boolean;
}

function isIdentityShaped(url: string): boolean {
  return IDENTITY_ENDPOINT_PATH_PATTERNS.some((pattern) => pattern.test(url));
}

function isGraphqlShaped(url: string): boolean {
  return GRAPHQL_ENDPOINT_PATH_PATTERN.test(url);
}

/**
 * Classifies a single observed network request into a shape-only
 * signed-in signal (SEN-03), never inspecting the response body. A
 * GraphQL 200 is scored lower than a REST identity-endpoint 200 because
 * it cannot be distinguished from a "soft-200" auth-error shape without
 * body access (ENG-05). `hasAuthorizationHeader` is captured on the
 * input per SEN-03's contract but never changes the score -- a
 * cookie-session app legitimately has no bearer token.
 */
export function classifyNetwork(request: NetworkRequestInput): SignalEvidence {
  const { url, statusCode } = request;

  const identityShaped = isIdentityShaped(url);
  const graphqlShaped = isGraphqlShaped(url);

  if (!identityShaped && !graphqlShaped) {
    return { signal: 'network', observed: false };
  }

  if (statusCode === 401 || statusCode === 403) {
    return { signal: 'network', observed: true, value: STRONG_NEGATIVE_VALUE };
  }

  if (statusCode === 200) {
    const value = graphqlShaped ? NETWORK_GRAPHQL_200_VALUE : NETWORK_REST_IDENTITY_200_VALUE;
    return { signal: 'network', observed: true, value };
  }

  return { signal: 'network', observed: false };
}
