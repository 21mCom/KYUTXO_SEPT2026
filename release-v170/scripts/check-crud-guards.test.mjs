// Tests for the CRUD-guard self-check: verifies that the scanner exits
// non-zero with a useful message when a path listed in GUARDED_TABLES or
// ALWAYS_ALLOWED_FILES no longer exists on disk (renamed / moved / deleted).
//
// Run with: node --test scripts/check-crud-guards.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SCANNER = path.resolve(path.dirname(__filename), 'check-crud-guards.js');
const scannerSrc = fs.readFileSync(SCANNER, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The scanner derives ROOT from __dirname, which breaks when the script is
// copied to a temp directory.  We patch this line before injecting any other
// modifications so that all path.resolve(ROOT, ...) calls still resolve to the
// real project root.
const ROOT_NEEDLE = "const ROOT = path.resolve(__dirname, '..');";
const ROOT_REPLACEMENT = `const ROOT = ${JSON.stringify(ROOT)};`;
assert.ok(
  scannerSrc.includes(ROOT_NEEDLE),
  `ROOT derivation line not found in scanner source — update ROOT_NEEDLE in this test:\n  ${ROOT_NEEDLE}`
);
const scannerSrcWithFixedRoot = scannerSrc.replace(ROOT_NEEDLE, ROOT_REPLACEMENT);

/**
 * Write a modified copy of the scanner to a temp directory, run it with the
 * given extra argv, then clean up.  Returns the spawnSync result.
 *
 * The caller receives `scannerSrcWithFixedRoot` as the base so they only need
 * to inject their stale-path change on top of an already-correct ROOT.
 */
function runModifiedScanner(modifiedSrc, extraArgs = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crud-guard-test-'));
  const tmpScanner = path.join(tmpDir, 'check-crud-guards.js');
  fs.writeFileSync(tmpScanner, modifiedSrc);
  try {
    return spawnSync('node', [tmpScanner, ...extraArgs], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case 1 – stale GUARDED_TABLES crudFile entry
//
// Replace the crudFile path for the "records" table with a path that no
// longer exists on disk.  The self-check must fire in BOTH full-scan mode and
// --production-only mode, because CRUD_FILES entries are never skipped.
// ---------------------------------------------------------------------------

const STALE_CRUD_FILE = '/nonexistent/path/to/stale-record-crud-MOVED.ts';

// The original line we target appears exactly once in the scanner source.
const CRUD_FILE_NEEDLE =
  "crudFile: path.resolve(ROOT, 'client/src/lib/data/record-crud.ts'),";
const CRUD_FILE_REPLACEMENT =
  `crudFile: '${STALE_CRUD_FILE}',`;

test('self-check flags a stale GUARDED_TABLES crudFile path in full-scan mode', () => {
  assert.ok(
    scannerSrc.includes(CRUD_FILE_NEEDLE),
    `Needle not found in scanner source — update the test if record-crud.ts was renamed:\n  ${CRUD_FILE_NEEDLE}`
  );

  const modified = scannerSrcWithFixedRoot.replace(CRUD_FILE_NEEDLE, CRUD_FILE_REPLACEMENT);
  const result = runModifiedScanner(modified);

  assert.equal(
    result.status,
    1,
    'scanner should exit 1 when a GUARDED_TABLES crudFile path does not exist, ' +
      `but it exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );

  const combined = result.stdout + result.stderr;
  assert.ok(
    combined.includes('stale-record-crud-MOVED') || combined.includes('GUARDED_TABLES'),
    'scanner output should mention the missing file or the GUARDED_TABLES label\n' +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    combined.includes('crudFile') ||
      combined.includes('renamed') ||
      combined.includes('stale'),
    'scanner output should contain a hint about a crudFile / renamed / stale entry'
  );
});

test('self-check flags a stale GUARDED_TABLES crudFile path in --production-only mode', () => {
  // CRUD-layer guard files must ALWAYS be checked, even in production-only mode;
  // otherwise a moved CRUD file would silently stop being guarded in CI builds.
  assert.ok(
    scannerSrc.includes(CRUD_FILE_NEEDLE),
    `Needle not found in scanner source — update the test if record-crud.ts was renamed:\n  ${CRUD_FILE_NEEDLE}`
  );

  const modified = scannerSrcWithFixedRoot.replace(CRUD_FILE_NEEDLE, CRUD_FILE_REPLACEMENT);
  const result = runModifiedScanner(modified, ['--production-only']);

  assert.equal(
    result.status,
    1,
    'scanner should exit 1 even in --production-only mode when a GUARDED_TABLES crudFile ' +
      `path does not exist, but it exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );

  const combined = result.stdout + result.stderr;
  assert.ok(
    combined.includes('stale-record-crud-MOVED') || combined.includes('GUARDED_TABLES'),
    'scanner output should mention the missing file or the GUARDED_TABLES label\n' +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// Case 2 – stale ALWAYS_ALLOWED_FILES entry that is a test file
//
// Inject a nonexistent .test.ts path into ALWAYS_ALLOWED_FILES.
//
// Full-scan mode  : must exit 1 (all allowlisted paths are verified).
// Production-only : must exit 0 (test-file entries are skipped in self-check
//                   because test files never ship in the production bundle).
// ---------------------------------------------------------------------------

const STALE_TEST_ALLOWED = '/nonexistent/path/to/stale-scale.test.ts';

// Inject the stale entry as the first item in the Set literal so the
// replacement is unambiguous (the opening line appears exactly once).
const ALLOWED_SET_NEEDLE = 'const ALWAYS_ALLOWED_FILES = new Set([';
const ALLOWED_SET_REPLACEMENT =
  `const ALWAYS_ALLOWED_FILES = new Set([\n  '${STALE_TEST_ALLOWED}',`;

test('self-check flags a stale test-file ALWAYS_ALLOWED_FILES entry in full-scan mode', () => {
  assert.ok(
    scannerSrc.includes(ALLOWED_SET_NEEDLE),
    `Needle not found in scanner source — update the test if ALWAYS_ALLOWED_FILES was restructured:\n  ${ALLOWED_SET_NEEDLE}`
  );

  const modified = scannerSrcWithFixedRoot.replace(ALLOWED_SET_NEEDLE, ALLOWED_SET_REPLACEMENT);
  const result = runModifiedScanner(modified);

  assert.equal(
    result.status,
    1,
    'scanner should exit 1 (full-scan) when a test-file ALWAYS_ALLOWED_FILES entry no longer exists, ' +
      `but it exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );

  const combined = result.stdout + result.stderr;
  assert.ok(
    combined.includes('stale-scale.test') || combined.includes('ALWAYS_ALLOWED_FILES'),
    'scanner output should mention the missing file or ALWAYS_ALLOWED_FILES\n' +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test(
  'self-check skips a stale test-file ALWAYS_ALLOWED_FILES entry in --production-only mode',
  () => {
    // In --production-only mode the self-check intentionally skips test-file
    // entries in ALWAYS_ALLOWED_FILES (they are excluded from the production
    // scan anyway, so their absence can never hide a production violation).
    assert.ok(
      scannerSrc.includes(ALLOWED_SET_NEEDLE),
      `Needle not found in scanner source — update the test if ALWAYS_ALLOWED_FILES was restructured:\n  ${ALLOWED_SET_NEEDLE}`
    );

    const modified = scannerSrcWithFixedRoot.replace(ALLOWED_SET_NEEDLE, ALLOWED_SET_REPLACEMENT);
    const result = runModifiedScanner(modified, ['--production-only']);

    assert.equal(
      result.status,
      0,
      'scanner should exit 0 in --production-only mode when the only stale ' +
        'ALWAYS_ALLOWED_FILES entry is a test file, ' +
        `but it exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
);

// ---------------------------------------------------------------------------
// Case 3 – stale ALWAYS_ALLOWED_FILES entry that is a NON-test source file
//
// A moved non-test production source in the allowlist must be caught in BOTH
// modes (it is never exempt from the self-check).
// ---------------------------------------------------------------------------

const STALE_PROD_ALLOWED = '/nonexistent/path/to/stale-fund-trail-engine-MOVED.ts';

// Inject before the first existing entry in ALWAYS_ALLOWED_FILES.
const PROD_ALLOWED_REPLACEMENT =
  `const ALWAYS_ALLOWED_FILES = new Set([\n  '${STALE_PROD_ALLOWED}',`;

test('self-check flags a stale non-test ALWAYS_ALLOWED_FILES entry in full-scan mode', () => {
  assert.ok(
    scannerSrc.includes(ALLOWED_SET_NEEDLE),
    `Needle not found in scanner source — update the test if ALWAYS_ALLOWED_FILES was restructured:\n  ${ALLOWED_SET_NEEDLE}`
  );

  const modified = scannerSrcWithFixedRoot.replace(ALLOWED_SET_NEEDLE, PROD_ALLOWED_REPLACEMENT);
  const result = runModifiedScanner(modified);

  assert.equal(
    result.status,
    1,
    'scanner should exit 1 (full-scan) when a non-test ALWAYS_ALLOWED_FILES entry no longer exists, ' +
      `but it exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );

  const combined = result.stdout + result.stderr;
  assert.ok(
    combined.includes('stale-fund-trail-engine-MOVED') || combined.includes('ALWAYS_ALLOWED_FILES'),
    'scanner output should mention the missing file or ALWAYS_ALLOWED_FILES\n' +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test('self-check flags a stale non-test ALWAYS_ALLOWED_FILES entry in --production-only mode', () => {
  assert.ok(
    scannerSrc.includes(ALLOWED_SET_NEEDLE),
    `Needle not found in scanner source — update the test if ALWAYS_ALLOWED_FILES was restructured:\n  ${ALLOWED_SET_NEEDLE}`
  );

  const modified = scannerSrcWithFixedRoot.replace(ALLOWED_SET_NEEDLE, PROD_ALLOWED_REPLACEMENT);
  const result = runModifiedScanner(modified, ['--production-only']);

  assert.equal(
    result.status,
    1,
    'scanner should exit 1 in --production-only mode when a non-test ALWAYS_ALLOWED_FILES ' +
      `entry no longer exists, but it exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );

  const combined = result.stdout + result.stderr;
  assert.ok(
    combined.includes('stale-fund-trail-engine-MOVED') || combined.includes('ALWAYS_ALLOWED_FILES'),
    'scanner output should mention the missing file or ALWAYS_ALLOWED_FILES\n' +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});
