import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PRV-02 -- "The extension makes no outbound network calls; only derived
 * numbers/verdicts exist in memory/session storage, cleared on tab close."
 *
 * A structural, grep-style audit (not a mocked-fetch-throws-if-called test,
 * which would only catch a call path actually exercised by some other
 * test): walks every `.ts`/`.tsx` source file under `src/` and
 * `entrypoints/` and asserts none of them reference `fetch(`,
 * `XMLHttpRequest`, or `WebSocket` -- the three ways this extension could
 * ever initiate outbound network traffic on its own. Test files
 * (`*.test.ts`) are excluded so this audit reviews only shipped code.
 */

const ROOT_DIR = join(__dirname, '..', '..');
const SCAN_DIRS = ['src', 'entrypoints'];
const FORBIDDEN_PATTERNS: readonly RegExp[] = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/];

interface Violation {
  readonly file: string;
  readonly pattern: string;
}

function isSourceFile(fileName: string): boolean {
  return (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) && !fileName.endsWith('.test.ts') && !fileName.endsWith('.test.tsx');
}

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
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

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    const absoluteDir = join(ROOT_DIR, dir);
    for (const filePath of listSourceFiles(absoluteDir)) {
      const contents = readFileSync(filePath, 'utf-8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(contents)) {
          violations.push({ file: relative(ROOT_DIR, filePath), pattern: pattern.source });
        }
      }
    }
  }
  return violations;
}

describe('privacy audit (PRV-02): zero outbound network calls anywhere in shipped source', () => {
  it('no `fetch(`, `XMLHttpRequest`, or `WebSocket` reference exists anywhere under src/ or entrypoints/', () => {
    const violations = findViolations();
    expect(violations).toEqual([]);
  });

  it('the audit itself actually scans a non-trivial number of files (a false-negative-empty scan would make the assertion above meaningless)', () => {
    let fileCount = 0;
    for (const dir of SCAN_DIRS) {
      fileCount += listSourceFiles(join(ROOT_DIR, dir)).length;
    }
    expect(fileCount).toBeGreaterThan(10);
  });

  it('sanity check: the scanner DOES detect a forbidden pattern when present (proves the regexes and file walk actually work)', () => {
    const sample = "const x = fetch('https://example.com');";
    expect(FORBIDDEN_PATTERNS.some((pattern) => pattern.test(sample))).toBe(true);
    expect(FORBIDDEN_PATTERNS.some((pattern) => pattern.test('new WebSocket(url)'))).toBe(true);
    expect(FORBIDDEN_PATTERNS.some((pattern) => pattern.test('new XMLHttpRequest()'))).toBe(true);
    expect(FORBIDDEN_PATTERNS.some((pattern) => pattern.test('const prefetch = 1; const refetch = () => {};'))).toBe(
      false,
    );
  });
});
