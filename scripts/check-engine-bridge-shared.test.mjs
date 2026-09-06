// Offline tests for the engine-bridge sharing guard. Runs the real
// scripts/check-engine-bridge-shared.js against fixture script directories via
// the CHECK_ENGINE_BRIDGE_SCRIPTS_DIR hook, so a badly-edited regex can't
// silently pass everything and stop protecting engine browser checks.
//
// Run with: node --test scripts/check-engine-bridge-shared.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(path.dirname(__filename), 'check-engine-bridge-shared.js');

const SHARED_IMPORT =
  "import { buildEngineBridgeInitScript } from './engine-bridge-mock.mjs';\n";

const COMPLIANT_ENGINE_CHECK =
  SHARED_IMPORT +
  'const initScript = buildEngineBridgeInitScript({ fingerprint: true });\n' +
  'await context.addInitScript(initScript);\n';

function runGuard(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-bridge-guard-test-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    return spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CHECK_ENGINE_BRIDGE_SCRIPTS_DIR: dir },
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('passes when engine checks share the bridge builder', () => {
  const result = runGuard({
    'check-foo-engine-browser-check.mjs': COMPLIANT_ENGINE_CHECK,
    'check-unrelated-browser.mjs': "await page.goto('/');\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('fails when an engine browser check is missing the shared import', () => {
  const result = runGuard({
    'check-foo-engine-browser-check.mjs':
      "await context.addInitScript('/* no bridge at all */');\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing import/);
  assert.match(result.stderr, /check-foo-engine-browser-check\.mjs/);
});

test('fails on inline `window.electronAPI = { ... engine` bridge in any check script', () => {
  const result = runGuard({
    'check-foo-engine-browser-check.mjs': COMPLIANT_ENGINE_CHECK,
    'check-other-browser.mjs':
      'await context.addInitScript(() => {\n' +
      '  window.electronAPI = {\n' +
      '    isElectron: true,\n' +
      '    engine: { getFingerprint: async () => ({}) },\n' +
      '  };\n' +
      '});\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inline engine bridge/);
  assert.match(result.stderr, /check-other-browser\.mjs/);
});

test('fails on inline `window.electronAPI.engine =` assignment in any check script', () => {
  const result = runGuard({
    'check-foo-engine-browser-check.mjs': COMPLIANT_ENGINE_CHECK,
    'check-sneaky-browser.mjs':
      'window.electronAPI.engine = { getPage: async () => [] };\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inline engine bridge/);
  assert.match(result.stderr, /check-sneaky-browser\.mjs/);
});

test('an engine check with the import but also its own inline bridge still fails', () => {
  const result = runGuard({
    'check-foo-engine-browser-check.mjs':
      COMPLIANT_ENGINE_CHECK + 'window.electronAPI.engine = {};\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inline engine bridge/);
});

test('fails closed when no engine browser check scripts match the glob', () => {
  const result = runGuard({
    'check-unrelated-browser.mjs': "await page.goto('/');\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no scripts\/check-\*engine-browser\*\.mjs files found/);
});

test('the real scripts directory still passes the guard', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CHECK_ENGINE_BRIDGE_SCRIPTS_DIR: '' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});
