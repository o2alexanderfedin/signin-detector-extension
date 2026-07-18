#!/usr/bin/env node
/**
 * Standalone privacy audit (PRV-01 / PRV-02) -- `npm run audit:privacy`.
 *
 * Mirrors `src/shared/privacyAudit.test.ts` (the vitest-integrated
 * outbound-network-call check, PRV-02) so it is runnable WITHOUT booting
 * the whole unit suite -- e.g. as a standalone CI/release-gate step -- and
 * adds one more structural check the vitest test does not cover: PRV-01
 * ("raw cookie/token values never cross the content-script <-> service-
 * worker message boundary"), scanned specifically at the files that form
 * that boundary.
 *
 * Zero dependencies beyond Node's built-in `fs`/`path`/`url`. Exits 0
 * (with a one-line PASS summary) on a clean audit; prints every violation
 * and exits 1 otherwise.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const SCAN_DIRS = ['src', 'entrypoints'];

/**
 * PRV-02: the only three ways this extension could ever initiate outbound
 * network traffic on its own (identical to `privacyAudit.test.ts`'s
 * `FORBIDDEN_PATTERNS`).
 */
const OUTBOUND_NETWORK_PATTERNS = [
  { name: 'fetch(', regex: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', regex: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', regex: /\bWebSocket\b/ },
];

/**
 * PRV-01: files that form the content-script <-> service-worker messaging
 * boundary -- see `src/content/messaging.ts`'s own doc comment: message
 * payloads carry "booleans/enums/numbers only, NEVER a raw cookie/token/
 * storage value". A raw `cookie.value` / `token.value` / `session.value`
 * reference appearing in any of these files means a raw value is at least
 * reachable at message-construction time.
 *
 * Deliberately narrower than "every file under src/" -- classifier/sensor
 * files legitimately read `.value` (e.g. `src/sensors/cookie/classify.ts`
 * inspects `cookie.value.length` for entropy, `src/sensors/storage/
 * classify.ts` inspects a JWT's segments) but that raw value never
 * crosses the wire; only the derived numeric score
 * (`SignalEvidence['value']: number`) does. Flagging `.value` repo-wide
 * would false-positive on that legitimate, already-privacy-reviewed code.
 */
const MESSAGE_BOUNDARY_PATH_PATTERNS = [/(^|\/)entrypoints\//, /(^|\/)messaging\.ts$/];

const RAW_VALUE_LEAK_PATTERNS = [
  { name: 'cookie.value', regex: /\bcookie\.value\b/i },
  { name: 'token.value', regex: /\btoken\.value\b/i },
  { name: 'session.value', regex: /\bsession\.value\b/i },
];

function isSourceFile(fileName) {
  return (
    (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) &&
    !fileName.endsWith('.test.ts') &&
    !fileName.endsWith('.test.tsx')
  );
}

function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (stats.isFile() && isSourceFile(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

function auditFile(filePath) {
  const relPath = relative(ROOT_DIR, filePath).split('\\').join('/'); // normalize for Windows too
  const contents = readFileSync(filePath, 'utf-8');
  const violations = [];

  for (const { name, regex } of OUTBOUND_NETWORK_PATTERNS) {
    if (regex.test(contents)) {
      violations.push(`${relPath}: forbidden outbound-network call \`${name}\` (PRV-02)`);
    }
  }

  const isBoundaryFile = MESSAGE_BOUNDARY_PATH_PATTERNS.some((pattern) => pattern.test(relPath));
  if (isBoundaryFile) {
    for (const { name, regex } of RAW_VALUE_LEAK_PATTERNS) {
      if (regex.test(contents)) {
        violations.push(`${relPath}: possible raw-value leakage at the message boundary \`${name}\` (PRV-01)`);
      }
    }
  }

  return violations;
}

function main() {
  const violations = [];
  let fileCount = 0;

  for (const dir of SCAN_DIRS) {
    const absoluteDir = join(ROOT_DIR, dir);
    for (const filePath of listSourceFiles(absoluteDir)) {
      fileCount += 1;
      violations.push(...auditFile(filePath));
    }
  }

  if (fileCount === 0) {
    console.error(`[audit:privacy] FAIL -- scanned 0 files under ${SCAN_DIRS.join('/, ')}/ -- the scan is misconfigured (expected >10 files).`);
    process.exitCode = 1;
    return;
  }

  if (violations.length > 0) {
    console.error(`[audit:privacy] FAIL -- ${String(violations.length)} violation(s) across ${String(fileCount)} scanned files:\n`);
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `[audit:privacy] PASS -- ${String(fileCount)} files scanned under ${SCAN_DIRS.join('/, ')}/: zero outbound-network calls (PRV-02), zero raw cookie/token/session value leakage at the messaging boundary (PRV-01).`,
  );
}

main();
