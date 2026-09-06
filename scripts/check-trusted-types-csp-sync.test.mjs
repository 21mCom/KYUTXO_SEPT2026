// Offline tests for the CSP drift guard (scripts/check-trusted-types-csp-sync.js).
// The guard's parsing is regex/anchor-based, so refactors of the three files it
// cross-checks (electron/main.cjs, scripts/check-trusted-types-browser.mjs,
// scripts/check-packaged-electron-browser.mjs) could make it stop matching and
// pass vacuously. These tests run the real guard against fixture copies via
// the CHECK_TT_CSP_SYNC_ROOT hook and assert it fails when it must.
//
// Run with: node --test scripts/check-trusted-types-csp-sync.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(path.dirname(__filename), 'check-trusted-types-csp-sync.js');

// ── Fixture templates (mirror the real files' relevant shapes) ──────────────

const MAIN_CJS = `
const PACKAGED_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://mempool.space https://blockstream.info",
  "require-trusted-types-for 'script'",
  "trusted-types kyutxo-app default",
].join('; ');
module.exports = { PACKAGED_CSP };
`;

const BROWSER_CHECK = `
const ENFORCING_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss: http://localhost:* https://mempool.space https://blockstream.info",
  "require-trusted-types-for 'script'",
  "trusted-types kyutxo-app default",
].join('; ');
`;

const PACKAGED_GATE = `
function checkCsp(csp) {
  const ok =
    csp.includes("require-trusted-types-for 'script'") &&
    csp.includes('trusted-types kyutxo-app default') &&
    csp.includes("'wasm-unsafe-eval'") &&
    !/script-src [^;]*'unsafe-inline'/.test(csp) &&
    !/script-src [^;]*'unsafe-eval'(?!')/.test(csp.replace(/'wasm-unsafe-eval'/g, ''));
  return ok;
}
`;

// Run the real guard against a fixture root built from (possibly overridden)
// copies of the three files.
function runGuard({ mainCjs = MAIN_CJS, browserCheck = BROWSER_CHECK, packagedGate = PACKAGED_GATE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-csp-sync-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'electron'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'electron/main.cjs'), mainCjs);
    fs.writeFileSync(path.join(dir, 'scripts/check-trusted-types-browser.mjs'), browserCheck);
    fs.writeFileSync(path.join(dir, 'scripts/check-packaged-electron-browser.mjs'), packagedGate);
    return spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CHECK_TT_CSP_SYNC_ROOT: dir },
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Clean pass ───────────────────────────────────────────────────────────────

test('passes on in-sync fixture copies of all three files', () => {
  const result = runGuard();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /directives match/);
});

// ── Trusted-types directive drift ────────────────────────────────────────────

test('fails when the browser check trusted-types allowlist drifts', () => {
  const result = runGuard({
    browserCheck: BROWSER_CHECK.replace(
      'trusted-types kyutxo-app default',
      'trusted-types kyutxo-app default rogue-policy',
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /'trusted-types' directive drift/);
});

test('fails when main.cjs drops require-trusted-types-for', () => {
  const result = runGuard({
    mainCjs: MAIN_CJS.replace(`  "require-trusted-types-for 'script'",\n`, ''),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing the 'require-trusted-types-for' directive/);
});

test('fails on a quoted trusted-types policy name', () => {
  const result = runGuard({
    mainCjs: MAIN_CJS.replace('trusted-types kyutxo-app default', "trusted-types kyutxo-app 'default'"),
    browserCheck: BROWSER_CHECK.replace('trusted-types kyutxo-app default', "trusted-types kyutxo-app 'default'"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /quoted policy name/);
});

// ── Packaged-gate assertion literal not present in PACKAGED_CSP ─────────────

test('fails when a gate assertion literal is not a substring of PACKAGED_CSP', () => {
  const result = runGuard({
    packagedGate: PACKAGED_GATE.replace(
      'trusted-types kyutxo-app default',
      'trusted-types kyutxo-app default extra-policy',
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not contain it/);
});

// ── Dropped critical-token assertion in the gate ─────────────────────────────

test('fails when the gate drops the trusted-types allowlist assertion', () => {
  const result = runGuard({
    packagedGate: PACKAGED_GATE.replace(
      "    csp.includes('trusted-types kyutxo-app default') &&\n",
      '',
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no longer asserts csp\.includes\("trusted-types kyutxo-app default"\)/);
});

test('fails when the gate drops the wasm-unsafe-eval assertion', () => {
  const result = runGuard({
    packagedGate: PACKAGED_GATE.replace(`    csp.includes("'wasm-unsafe-eval'") &&\n`, ''),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wasm-unsafe-eval/);
});

// ── Dropped negative unsafe-inline / unsafe-eval assertions ──────────────────

test('fails when the gate drops the negative unsafe-inline assertion', () => {
  const result = runGuard({
    packagedGate: PACKAGED_GATE.replace(
      `    !/script-src [^;]*'unsafe-inline'/.test(csp) &&\n`,
      '',
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no longer rejects 'unsafe-inline' in script-src/);
});

test('fails when the gate drops the negative unsafe-eval assertion', () => {
  const result = runGuard({
    packagedGate: PACKAGED_GATE.replace(
      `    !/script-src [^;]*'unsafe-eval'(?!')/.test(csp.replace(/'wasm-unsafe-eval'/g, ''));\n`,
      '    true;\n',
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no longer rejects 'unsafe-eval' in script-src/);
});

// ── PACKAGED_CSP strictness ───────────────────────────────────────────────────

test('fails when PACKAGED_CSP script-src loses wasm-unsafe-eval', () => {
  const result = runGuard({
    mainCjs: MAIN_CJS.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self'"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lost 'wasm-unsafe-eval'/);
});

test('fails when PACKAGED_CSP script-src gains unsafe-inline', () => {
  const result = runGuard({
    mainCjs: MAIN_CJS.replace(
      "script-src 'self' 'wasm-unsafe-eval'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
    ),
    // keep gate literals consistent so THIS failure is what fires
    packagedGate: PACKAGED_GATE.replace(
      "!/script-src [^;]*'unsafe-inline'/.test(csp) &&",
      "!/script-src [^;]*'unsafe-inline'/.test('') &&",
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not contain 'unsafe-inline'/);
});

test('fails when PACKAGED_CSP script-src gains unsafe-eval', () => {
  const result = runGuard({
    mainCjs: MAIN_CJS.replace(
      "script-src 'self' 'wasm-unsafe-eval'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not contain 'unsafe-eval'/);
});

// ── Anchors not found must FAIL, never pass vacuously ────────────────────────

test('fails when PACKAGED_CSP is renamed away in main.cjs', () => {
  const result = runGuard({
    mainCjs: MAIN_CJS.replace('const PACKAGED_CSP =', 'const RENAMED_CSP ='),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not locate CSP array/);
});

test('fails when ENFORCING_CSP is renamed away in the browser check', () => {
  const result = runGuard({
    browserCheck: BROWSER_CHECK.replace('const ENFORCING_CSP =', 'const RENAMED_CSP ='),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not locate CSP array/);
});

test('fails when the gate has zero csp.includes assertions', () => {
  const result = runGuard({
    packagedGate: PACKAGED_GATE.replace(/csp\.includes/g, 'cspAsserted'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no csp\.includes\(\.\.\.\) assertions found/);
});

test('fails when the PACKAGED_CSP array contains no string literals', () => {
  const result = runGuard({
    mainCjs: `const PACKAGED_CSP = [].join('; ');\n`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contained no string literals/);
});
