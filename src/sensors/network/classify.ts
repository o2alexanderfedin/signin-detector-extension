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

/**
 * The path of `url`, without host, query string or fragment -- the endpoint patterns describe paths,
 * and a host name (`user.example.com`) or a query value (`/login?next=/account`) must not match them.
 * An unparseable URL has no path to match.
 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function isIdentityShaped(path: string): boolean {
  return IDENTITY_ENDPOINT_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function isGraphqlShaped(path: string): boolean {
  return GRAPHQL_ENDPOINT_PATH_PATTERN.test(path);
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

  const path = pathOf(url);
  const identityShaped = isIdentityShaped(path);
  const graphqlShaped = isGraphqlShaped(path);

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
