// Offline tests for the IPC error-sanitization guard's handler-coverage
// analyzer. Runs the real scripts/check-ipc-error-sanitization.js against
// fixture electron dirs via the CHECK_IPC_SANITIZATION_DIR hook, so a subtly
// broken hand-rolled parser (e.g. it stops recognizing a callback shape and
// silently skips it) can't leave validation passing while guarding nothing.
//
// Run with: node --test scripts/check-ipc-error-sanitization.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(path.dirname(__filename), 'check-ipc-error-sanitization.js');

// Minimal stub satisfying the script's self-check that the sanitization
// helpers still exist in the scanned directory.
const SECURITY_UTILS_STUB = `
function sanitizeIpcError(error, fallback) { return fallback; }
module.exports = { sanitizeIpcError };
`;

// Run the guard against a fixture dir containing the given main.cjs source.
function runGuard(handlerSource, { includeSecurityUtils = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-sanitize-test-'));
  try {
    if (includeSecurityUtils) {
      fs.writeFileSync(path.join(dir, 'security-utils.cjs'), SECURITY_UTILS_STUB);
    }
    fs.writeFileSync(path.join(dir, 'main.cjs'), handlerSource);
    return spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CHECK_IPC_SANITIZATION_DIR: dir },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// Accepted shapes
// --------------------------------------------------------------------------

test('accepts a sanctioned wrap(...) callback', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('good:wrap', wrap(async (event, args) => {
  return doWork(args);
}));
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clean/);
});

test('accepts an async arrow whose whole body is one try/catch', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('good:trycatch', async (event, args) => {
  try {
    const value = await doWork(args);
    return { success: true, value };
  } catch (error) {
    return { success: false, error: sanitizeIpcError(error, 'Failed to do work') };
  }
});
`);
  assert.equal(result.status, 0, result.stderr);
});

test('accepts a function expression with try/catch/finally body', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('good:function', async function handler(event) {
  try {
    return { success: true };
  } catch (error) {
    return { success: false, error: sanitizeIpcError(error, 'Failed') };
  } finally {
    cleanup();
  }
});
`);
  assert.equal(result.status, 0, result.stderr);
});

test('accepts try/catch bodies containing strings, comments, and templates', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('good:tricky', async (event, { id }) => {
  try {
    // comment with a stray brace }
    const s = "string with } and \\" escape";
    const t = \`template \${id ? '{' : compute({ nested: true })} tail\`;
    return { success: true, s, t };
  } catch (error) {
    return { success: false, error: sanitizeIpcError(error, 'Failed') };
  }
});
`);
  assert.equal(result.status, 0, result.stderr);
});

// --------------------------------------------------------------------------
// Rejected shapes
// --------------------------------------------------------------------------

test('rejects a prelude statement before the try', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('bad:prelude', async (event, args) => {
  const parsed = JSON.parse(args); // can throw before the try
  try {
    return { success: true, parsed };
  } catch (error) {
    return { success: false, error: sanitizeIpcError(error, 'Failed') };
  }
});
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must START with try/);
});

test('rejects an expression-bodied arrow handler', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('bad:expression', async (event, args) => doWork(args));
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expression-bodied arrow/);
});

test('rejects statements after the try/catch', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('bad:trailing', async (event) => {
  try {
    return { success: true };
  } catch (error) {
    return { success: false, error: sanitizeIpcError(error, 'Failed') };
  }
  audit(event); // can throw outside the catch
});
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AFTER the try\/catch/);
});

test('rejects a try with no catch', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('bad:nocatch', async () => {
  try {
    return { success: true };
  } finally {
    cleanup();
  }
});
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no catch/);
});

test('rejects an unsanctioned wrapper call', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('bad:wrapper', otherWrap(async () => {
  return doWork();
}));
`);
  assert.equal(result.status, 1);
});

test('rejects a bare function reference callback', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('bad:bare-ref', handleThing);
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bare reference/);
});

test('single-parameter arrow without parens is still analyzed', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('bad:single-param', async event => {
  doWork(event);
});
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must START with try/);
});

// --------------------------------------------------------------------------
// Pass 1 (raw error text on the error: field) still works via the hook
// --------------------------------------------------------------------------

test('rejects raw error.message on an IPC error field', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
ipcMain.handle('bad:raw-message', async () => {
  try {
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /raw error\.message/);
});

// --------------------------------------------------------------------------
// Self-checks keep failing closed against fixture dirs too
// --------------------------------------------------------------------------

test('fails closed when security-utils.cjs is missing from the scanned dir', () => {
  const result = runGuard(
    `const { ipcMain } = require('electron');\nipcMain.handle('x', wrap(fn));\n`,
    { includeSecurityUtils: false },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /security-utils\.cjs not found/);
});

test('fails closed when no ipcMain.handle registrations are found', () => {
  const result = runGuard(`module.exports = {};\n`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no ipcMain\.handle found/);
});
