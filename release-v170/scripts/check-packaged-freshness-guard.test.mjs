// Offline tests for the packaged bundle-freshness usage guard. Runs the real
// scripts/check-packaged-freshness-guard.js against fixture script directories
// via the CHECK_PACKAGED_FRESHNESS_SCRIPTS_DIR hook, so a badly-edited regex
// can't silently pass everything and stop protecting packaged checks.
//
// Run with: node --test scripts/check-packaged-freshness-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(path.dirname(__filename), 'check-packaged-freshness-guard.js');

const FULL_IMPORT =
  "import { assertPackagedBundleFresh, assertPackagedAsarFresh } from './packaged-bundle-freshness.mjs';\n";

const COMPLIANT_PACKAGED_CHECK =
  FULL_IMPORT +
  "if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {\n" +
  "  assertPackagedBundleFresh({ tag: TAG });\n" +
  "  assertPackagedAsarFresh({ tag: TAG, asarPath: ASAR });\n" +
  '} else {\n' +
  "  run('npm', ['run', 'build']);\n" +
  '  assertPackagedBundleFresh({ tag: TAG });\n' +
  "  run('npx', ['electron-builder', '--dir']);\n" +
  '}\n';

function runGuard(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-freshness-guard-test-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    return spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CHECK_PACKAGED_FRESHNESS_SCRIPTS_DIR: dir },
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('passes when packaged checks import and call both guards', () => {
  const result = runGuard({
    'check-foo-packaged.mjs': COMPLIANT_PACKAGED_CHECK,
    'check-unrelated-browser.mjs': "await page.goto('/');\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('fails when a packaged check is missing the freshness import entirely', () => {
  const result = runGuard({
    'check-foo-packaged.mjs':
      "run('npx', ['electron-builder', '--dir']);\nconst ASAR = 'release/linux-unpacked/resources/app.asar';\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing import/);
  assert.match(result.stderr, /check-foo-packaged\.mjs/);
});

test('fails when the guard is imported but never called', () => {
  const result = runGuard({
    'check-foo-packaged.mjs':
      "import { assertPackagedBundleFresh } from './packaged-bundle-freshness.mjs';\n" +
      "run('npx', ['electron-builder', '--dir']);\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /never calls it/);
});

test('fails when a skip-build reuse path lacks assertPackagedAsarFresh', () => {
  const result = runGuard({
    'check-foo-packaged.mjs':
      "import { assertPackagedBundleFresh } from './packaged-bundle-freshness.mjs';\n" +
      "if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {\n" +
      '  assertPackagedBundleFresh({});\n' +
      '}\n' +
      'assertPackagedBundleFresh({});\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /assertPackagedAsarFresh/);
});

test('fails when assertPackagedAsarFresh is imported but never called', () => {
  const result = runGuard({
    'check-foo-packaged.mjs':
      FULL_IMPORT +
      "if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {}\n" +
      'assertPackagedBundleFresh({});\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /imports assertPackagedAsarFresh but never calls it/);
});

test('app.asar usage alone marks a script as packaged and requires the guard', () => {
  const result = runGuard({
    'check-foo-packaged.mjs':
      "const ASAR = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing import/);
});

test('comment-only mentions of packaged markers do not trigger the rules', () => {
  const result = runGuard({
    'check-foo-packaged.mjs': COMPLIANT_PACKAGED_CHECK,
    'check-docs-only.mjs':
      '// This check is unrelated; unlike electron-builder / app.asar checks it\n' +
      '// does not use KYUTXO_PACKAGED_SKIP_BUILD.\n' +
      "await page.goto('/');\n",
  });
  assert.equal(result.status, 0, result.stderr);
});

test('prose mention of electron-builder inside a longer string does not trigger', () => {
  const result = runGuard({
    'check-foo-packaged.mjs': COMPLIANT_PACKAGED_CHECK,
    'check-audit-like.js':
      "console.error('never npm audit fix --force — it downgrades electron-builder');\n",
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a comment cannot satisfy the import/call requirements', () => {
  const result = runGuard({
    'check-foo-packaged.mjs':
      "// import { assertPackagedBundleFresh } from './packaged-bundle-freshness.mjs';\n" +
      '// assertPackagedBundleFresh({});\n' +
      "run('npx', ['electron-builder', '--dir']);\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing import/);
});

test('test companions (check-*.test.mjs) are ignored', () => {
  const result = runGuard({
    'check-foo-packaged.mjs': COMPLIANT_PACKAGED_CHECK,
    'check-something.test.mjs': "const marker = 'app.asar';\n",
  });
  assert.equal(result.status, 0, result.stderr);
});

test('fails closed when no packaged check scripts are found', () => {
  const result = runGuard({
    'check-unrelated-browser.mjs': "await page.goto('/');\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no packaged check scripts found/);
});

test('the real scripts directory still passes the guard', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CHECK_PACKAGED_FRESHNESS_SCRIPTS_DIR: '' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});
