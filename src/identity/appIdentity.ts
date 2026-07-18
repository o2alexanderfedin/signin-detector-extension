import { getDomain } from 'tldts';

import type { WebAppKey } from '../shared/types';

/**
 * Resolves the eTLD+1 (registrable domain) identity key for a web
 * application from an arbitrary URL, via `tldts.getDomain`.
 *
 * Subdomains (api./www./cdn.) of the same registrable domain collapse to
 * the identical WebAppKey value (IDN-01), and the key is derived only
 * from the host -- never the path/hash -- so SPA route changes on the
 * same host never re-key (IDN-02).
 *
 * `tldts.getDomain` already returns `null` for IP-address hosts,
 * `localhost`, and non-http(s) protocols (`chrome://`, `file://`,
 * `about:`), so no additional IP/protocol handling is required here.
 */
export function resolveWebAppKey(url: string): WebAppKey | null {
  const domain = getDomain(url);
  if (domain === null) {
    return null;
  }
  return domain as WebAppKey;
}
