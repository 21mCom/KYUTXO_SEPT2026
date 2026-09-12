// Offline tests for the win32-unsafe path-derivation guard. Runs the real
// scripts/check-win32-path-derivation.js against fixture script directories
// via the CHECK_WIN32_PATH_SCRIPTS_DIR hook, so a badly-edited regex can't
// silently pass everything and stop protecting CI scripts.
//
// Run with: node --test scripts/check-win32-path-derivation.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(path.dirname(__filename), 'check-win32-path-derivation.js');

const NAIVE =
  "import path from 'node:path';\n" +
  "const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');\n" +
  'console.log(ROOT);\n';

const SAFE_FILEURLTOPATH =
  "import path from 'node:path';\n" +
  "import { fileURLToPath } from 'node:url';\n" +
  "const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');\n" +
  'console.log(ROOT);\n';

const SAFE_DRIVE_STRIP =
  "import path from 'node:path';\n" +
  "const ROOT = process.platform === 'win32'\n" +
  "  ? path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\\/(?=[A-Za-z]:)/, '')), '..')\n" +
  "  : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');\n" +
  'console.log(ROOT);\n';

function runGuard(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-path-guard-test-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    }
    return spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CHECK_WIN32_PATH_SCRIPTS_DIR: dir },
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('fails on a naive new URL(import.meta.url).pathname derivation', () => {
  const result = runGuard({ 'check-foo.mjs': NAIVE, 'other.js': 'console.log(1);\n' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check-foo\.mjs/);
  assert.match(result.stderr, /fileURLToPath/);
});

test('fails even when the call spans whitespace', () => {
  const result = runGuard({
    'check-foo.mjs':
      'const p = new URL(\n  import.meta.url\n)\n  .pathname;\nconsole.log(p);\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check-foo\.mjs/);
});

test('passes when the file uses fileURLToPath', () => {
  const result = runGuard({ 'check-foo.mjs': SAFE_FILEURLTOPATH });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('passes when the file mixes the pattern with a fileURLToPath call', () => {
  // The pattern may appear (e.g. for a URL, not a filesystem path) as long as
  // a win32-safe conversion exists in the same file.
  const result = runGuard({ 'check-foo.mjs': SAFE_FILEURLTOPATH + NAIVE });
  assert.equal(result.status, 0, result.stderr);
});

test('passes when the pathname is drive-letter-stripped for win32', () => {
  const result = runGuard({ 'check-foo.mjs': SAFE_DRIVE_STRIP });
  assert.equal(result.status, 0, result.stderr);
});

test('ignores *.test.* files', () => {
  const result = runGuard({
    'check-foo.test.mjs': NAIVE,
    'check-ok.mjs': SAFE_FILEURLTOPATH,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('scans nested subdirectories', () => {
  const result = runGuard({
    'demo-vault/build-something.mjs': NAIVE,
    'check-ok.mjs': SAFE_FILEURLTOPATH,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /demo-vault\/build-something\.mjs/);
});

test('comment-only mentions of the trap do not trigger the rule', () => {
  const result = runGuard({
    'check-foo.mjs':
      '// never use new URL(import.meta.url).pathname for filesystem paths\n' +
      '/* new URL(import.meta.url).pathname is /D:/... on windows */\n' +
      'console.log(1);\n',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('fails loudly when there are no scripts to scan', () => {
  const result = runGuard({});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no scripts found/);
});

test('the real scripts/ directory currently passes the guard', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
});
