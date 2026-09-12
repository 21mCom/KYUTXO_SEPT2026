// Offline tests for the waitForFunction options-position guard. Runs the real
// scripts/check-waitforfunction-options.js against fixture script directories
// via the CHECK_WAITFORFUNCTION_SCRIPTS_DIR hook, so a badly-edited parser
// can't silently pass everything and stop protecting browser checks.
//
// Run with: node --test scripts/check-waitforfunction-options.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(path.dirname(__filename), 'check-waitforfunction-options.js');

function runGuard(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wff-options-guard-test-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    return spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CHECK_WAITFORFUNCTION_SCRIPTS_DIR: dir },
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('passes the good pattern: fn, undefined, { timeout }', () => {
  const res = runGuard({
    'check-good-browser.mjs':
      'await page.waitForFunction(() => window.ready === true, undefined, { timeout: 60_000 });\n',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK/);
});

test('passes null as the arg placeholder', () => {
  const res = runGuard({
    'check-null-browser.mjs':
      'await page.waitForFunction(() => document.title, null, { timeout: 45000 });\n',
  });
  assert.equal(res.status, 0, res.stderr);
});

test('passes a one-argument call', () => {
  const res = runGuard({
    'check-one-arg.mjs': 'await page.waitForFunction(() => window.done);\n',
  });
  assert.equal(res.status, 0, res.stderr);
});

test('passes an object-literal arg payload when a third options arg is present', () => {
  const res = runGuard({
    'check-arg-payload.mjs':
      'await page.waitForFunction(({ id }) => !!document.getElementById(id), { id: someId }, { timeout: 15_000 });\n',
  });
  assert.equal(res.status, 0, res.stderr);
});

test('ignores test fixture files in the scanned directory', () => {
  const res = runGuard({
    'something.test.mjs': 'await page.waitForFunction(() => 1, { timeout: 1 });\n',
    'something.test.js': 'await page.waitForFunction(() => 2, { timeout: 1 });\n',
    'something.test.ts': 'await page.waitForFunction(() => 3, { timeout: 1 });\n',
  });
  assert.equal(res.status, 0, res.stderr);
});

test('fails the bad pattern: fn, { timeout } with file:line', () => {
  const res = runGuard({
    'check-bad-browser.mjs':
      '// header comment\n' +
      'await page.waitForFunction(\n' +
      '  () => window.__count >= 5,\n' +
      '  { timeout: 60_000 },\n' +
      ');\n',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check-bad-browser\.mjs:2/);
  assert.match(res.stderr, /SECOND argument is an object literal/);
});

test('fails a single-line bad call', () => {
  const res = runGuard({
    'check-bad-inline.mjs':
      'await frame.waitForFunction(() => !!window.x, { timeout: 5000 });\n',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check-bad-inline\.mjs:1/);
});

test('detects the bad pattern in every supported script extension', () => {
  const badCall =
    'await page.waitForFunction(() => window.ready, { timeout: 60_000 });\n';
  const res = runGuard({
    'check-bad.js': badCall,
    'check-bad.mjs': badCall,
    'check-bad.ts': badCall,
  });
  assert.equal(res.status, 1);
  for (const extension of ['js', 'mjs', 'ts']) {
    assert.match(res.stderr, new RegExp(`check-bad\\.${extension}:1`));
  }
  assert.match(res.stderr, /SECOND argument is an object literal/);
});

test('is not fooled by object literals inside the function body', () => {
  const res = runGuard({
    'check-body-object.mjs':
      'await page.waitForFunction(() => {\n' +
      '  const o = { timeout: 1, nested: { a: [1, 2] } };\n' +
      '  return o.timeout === 1;\n' +
      '}, undefined, { timeout: 30000 });\n',
  });
  assert.equal(res.status, 0, res.stderr);
});

test('is not fooled by commas/braces inside strings and templates', () => {
  const res = runGuard({
    'check-strings.mjs':
      "await page.waitForFunction((sel) => !!document.querySelector(sel), '[data-x=\"a,b\"]', { timeout: 1000 });\n" +
      'await page.waitForFunction(() => `${window.a}, { fake: 1 }` === window.b, undefined, { timeout: 2000 });\n',
  });
  assert.equal(res.status, 0, res.stderr);
});

test('reports multiple violations across files', () => {
  const res = runGuard({
    'check-a.mjs': 'await page.waitForFunction(() => 1, { timeout: 1 });\n',
    'check-b.mjs':
      'await page.waitForFunction(() => 2, undefined, { timeout: 2 });\n' +
      'await page.waitForFunction(() => 3, { polling: 100 });\n',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check-a\.mjs:1/);
  assert.match(res.stderr, /check-b\.mjs:2/);
  assert.doesNotMatch(res.stderr, /check-b\.mjs:1:/);
});

test('the real scripts directory currently passes the guard', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(res.status, 0, res.stderr);
});
