import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny, dependency-free, LOOPBACK-ONLY fixture web server -- no real
 * external site is ever contacted by this harness. Paired with
 * `fixtures.ts`'s `--host-resolver-rules=MAP fixture-app.test 127.0.0.1`
 * Chromium flag, so the extension under test observes a real (if
 * synthetic) same-origin identity endpoint via `chrome.webRequest`,
 * exactly as it would on a real site -- not a Playwright `context.route`
 * mock, which would only prove the *page* saw the right response, not
 * that the extension's background `webRequest.onCompleted` listener did.
 *
 * Routes:
 *  - `GET /` and any other non-`/api/me` path (e.g. `/dashboard`): a
 *    minimal static HTML page with NO interactive/affordance/avatar/
 *    password-form markup -- see `src/content/sensors/domSensor.ts` --
 *    so the content script's DOM sensor stays `observed: false` and
 *    never contaminates the fused verdict this test is asserting on.
 *    Exposes `window.pingIdentity()`, called once on load and again by
 *    the test whenever it needs to force a fresh
 *    `chrome.webRequest.onCompleted` event for `/api/me` (SEN-03's
 *    identity-endpoint-shaped path -- matches
 *    `IDENTITY_ENDPOINT_PATH_PATTERNS`' `/\/me\b/i`).
 *  - `GET /api/me`: the mocked identity endpoint. Returns 200 or 401
 *    based on in-memory `signedIn` state, toggled directly by the test
 *    via `setSignedIn()` -- no HTTP round trip needed, since the server
 *    runs in the SAME Node process as the Playwright test runner (only
 *    the extension-under-test's browser process talks to it over real
 *    loopback HTTP).
 */
export interface FixtureServer {
  readonly port: number;
  setSignedIn(signedIn: boolean): void;
  close(): Promise<void>;
}

function renderPage(requestUrl: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Fixture App</title></head>
<body>
<h1>Sign-In Detector fixture app</h1>
<p>path: ${requestUrl}</p>
<p id="status">loading...</p>
<script>
  window.pingIdentity = function () {
    return fetch('/api/me', { credentials: 'include' }).then(function (res) {
      document.getElementById('status').textContent = 'identity: ' + res.status;
      return res.status;
    });
  };
  window.pingIdentity();
</script>
</body>
</html>`;
}

export function startFixtureServer(): Promise<FixtureServer> {
  let signedIn = false;

  const server: Server = createServer((req, res) => {
    const requestUrl = req.url ?? '/';
    if (requestUrl.startsWith('/api/me')) {
      res.writeHead(signedIn ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: signedIn }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(renderPage(requestUrl));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        setSignedIn(next: boolean): void {
          signedIn = next;
        },
        close(): Promise<void> {
          return new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err) {
                rej(err);
              } else {
                res();
              }
            });
          });
        },
      });
    });
  });
}
