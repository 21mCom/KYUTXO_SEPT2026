// Offline tests for the browser-check serialization-lock guard. Runs the real
// scripts/check-browser-check-lock.js against fixture script directories via
// CHECK_BROWSER_CHECK_LOCK_SCRIPTS_DIR, so extension and exclusion changes
// cannot silently stop protecting new browser checks.
//
// Run with: node --test scripts/check-browser-check-lock.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(
  path.dirname(__filename),
  'check-browser-check-lock.js',
);

const LOCK_IMPORT =
  "import { acquireBrowserCheckLock } from './browser-check-lock.mjs';";
const LOCK_CALL = 'await acquireBrowserCheckLock();';

function runGuard(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-check-lock-test-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    return spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CHECK_BROWSER_CHECK_LOCK_SCRIPTS_DIR: dir },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('requires the shared lock in every supported browser-check extension', () => {
  const contents = `${LOCK_IMPORT}\n${LOCK_CALL}\n`;
  const res = runGuard({
    'check-good-browser.js': contents,
    'check-good-browser.mjs': contents,
    'check-good-browser.ts': contents,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK — 3 browser check script\(s\)/);
});

test('excludes test fixtures from every supported browser-check extension', () => {
  const contents = `${LOCK_IMPORT}\n${LOCK_CALL}\n`;
  const res = runGuard({
    'check-real-browser.mjs': contents,
    'check-fixture-browser.test.js': 'missing lock\n',
    'check-fixture-browser.test.mjs': 'missing lock\n',
    'check-fixture-browser.test.ts': 'missing lock\n',
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK — 1 browser check script\(s\)/);
});

test('reports missing import and call with the correct fixture filename', () => {
  const res = runGuard({
    'check-missing-browser.js': 'await doWork();\n',
    'check-missing-browser.mjs': LOCK_IMPORT,
    'check-missing-browser.ts': LOCK_CALL,
  });

  assert.equal(res.status, 1);
  assert.match(
    res.stderr,
    /scripts\/check-missing-browser\.js: missing import: import \{ acquireBrowserCheckLock \}/,
  );
  assert.match(
    res.stderr,
    /scripts\/check-missing-browser\.js: missing call: await acquireBrowserCheckLock\(\);/,
  );
  assert.match(
    res.stderr,
    /scripts\/check-missing-browser\.mjs: missing call: await acquireBrowserCheckLock\(\);/,
  );
  assert.match(
    res.stderr,
    /scripts\/check-missing-browser\.ts: missing import: import \{ acquireBrowserCheckLock \}/,
  );
});

test('the real scripts directory currently passes the guard', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
});