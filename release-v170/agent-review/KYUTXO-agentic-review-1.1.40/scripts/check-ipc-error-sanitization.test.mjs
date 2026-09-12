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

// Minimal engine-handlers stub whose `wrap` matches the sanctioned shape the
// guard's lockstep wrapper-definition check verifies: a whole-body try/catch
// routing through sanitizeIpcError.
const ENGINE_HANDLERS_STUB = `
const { sanitizeIpcError } = require('./security-utils.cjs');
const wrap = (fn) => async (_event, payload) => {
  try {
    return { ok: true, result: await fn(payload) };
  } catch (err) {
    return { ok: false, error: sanitizeIpcError(err, 'Engine operation failed') };
  }
};
module.exports = { wrap };
`;

// Run the guard against a fixture dir containing the given main.cjs source.
// `engineHandlersSource` overrides the stub; pass null to omit the file.
function runGuard(
  handlerSource,
  { includeSecurityUtils = true, engineHandlersSource = ENGINE_HANDLERS_STUB } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-sanitize-test-'));
  try {
    if (includeSecurityUtils) {
      fs.writeFileSync(path.join(dir, 'security-utils.cjs'), SECURITY_UTILS_STUB);
    }
    if (engineHandlersSource !== null) {
      fs.writeFileSync(path.join(dir, 'engine-handlers.cjs'), engineHandlersSource);
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

test('accepts a sanctioned wrap(...) callback imported from engine-handlers', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
const { wrap } = require('./engine-handlers.cjs');
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
// Wrapper binding resolution: `wrap(...)` is only sanctioned when it is the
// verified wrapper — not any identifier that happens to be spelled `wrap`.
// --------------------------------------------------------------------------

test('rejects a locally declared lookalike wrap', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
const wrap = (fn) => (event, payload) => fn(payload); // no sanitization
ipcMain.handle('bad:local-wrap', wrap(async () => doWork()));
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /declared locally/);
});

test('rejects wrap imported from a noncanonical module', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
const { wrap } = require('./other-helpers.cjs');
ipcMain.handle('bad:noncanonical-import', wrap(async () => doWork()));
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not imported from \.\/engine-handlers\.cjs/);
});

test('rejects shadowing a canonical wrap import with a local declaration', () => {
  const result = runGuard(`
const { ipcMain } = require('electron');
const { wrap: realWrap } = require('./engine-handlers.cjs');
function wrap(fn) { return fn; } // shadows with a leaky lookalike
ipcMain.handle('bad:shadowed', wrap(async () => doWork()));
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /declared locally/);
});

test('rejects a second wrap declaration inside engine-handlers.cjs itself', () => {
  const result = runGuard(
    `module.exports = {};\n`,
    {
      engineHandlersSource: `
const { ipcMain } = require('electron');
const { sanitizeIpcError } = require('./security-utils.cjs');
const wrap = (fn) => async (_event, payload) => {
  try {
    return { ok: true, result: await fn(payload) };
  } catch (err) {
    return { ok: false, error: sanitizeIpcError(err, 'Failed') };
  }
};
{
  const wrap = (fn) => fn; // shadowing lookalike
  ipcMain.handle('bad:inner-shadow', wrap(async () => doWork()));
}
`,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /multiple local declarations/);
});

test('accepts wrap used inside engine-handlers.cjs itself', () => {
  const result = runGuard(
    `module.exports = {};\n`,
    {
      engineHandlersSource: `
const { ipcMain } = require('electron');
const { sanitizeIpcError } = require('./security-utils.cjs');
const wrap = (fn) => async (_event, payload) => {
  try {
    return { ok: true, result: await fn(payload) };
  } catch (err) {
    return { ok: false, error: sanitizeIpcError(err, 'Failed') };
  }
};
ipcMain.handle('good:canonical', wrap(async () => doWork()));
module.exports = { wrap };
`,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

// --------------------------------------------------------------------------
// Sanctioned wrapper definition lockstep check
// --------------------------------------------------------------------------

const WRAP_HANDLER = `
const { ipcMain } = require('electron');
const { wrap } = require('./engine-handlers.cjs');
ipcMain.handle('good:wrap', wrap(async (event, args) => {
  return doWork(args);
}));
`;

test('fails closed when engine-handlers.cjs is missing but wrap(...) is used', () => {
  const result = runGuard(WRAP_HANDLER, { engineHandlersSource: null });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /engine-handlers\.cjs not found/);
});

test('fails closed when a lookalike wrap has no try/catch', () => {
  const result = runGuard(WRAP_HANDLER, {
    engineHandlersSource: `
const wrap = (fn) => async (_event, payload) => {
  return { ok: true, result: await fn(payload) };
};
module.exports = { wrap };
`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must START with try/);
});

test('fails closed when wrap returns an expression-bodied handler', () => {
  const result = runGuard(WRAP_HANDLER, {
    engineHandlersSource: `
const wrap = (fn) => (event, payload) => fn(payload);
module.exports = { wrap };
`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expression-bodied handler/);
});

test('fails closed when the wrap catch stops routing through sanitizeIpcError', () => {
  const result = runGuard(WRAP_HANDLER, {
    engineHandlersSource: `
const wrap = (fn) => async (_event, payload) => {
  try {
    return { ok: true, result: await fn(payload) };
  } catch (err) {
    return { ok: false, error: 'failed: ' + err.stack };
  }
};
module.exports = { wrap };
`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sanitizeIpcError/);
});

test('fails closed when the wrap definition is renamed away', () => {
  const result = runGuard(WRAP_HANDLER, {
    engineHandlersSource: `
const wrapUnsafe = (fn) => fn;
module.exports = { wrapUnsafe };
`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no `const wrap =` definition/);
});

test('fails closed when wrap has statements after the try/catch', () => {
  const result = runGuard(WRAP_HANDLER, {
    engineHandlersSource: `
const wrap = (fn) => async (_event, payload) => {
  try {
    return { ok: true, result: await fn(payload) };
  } catch (err) {
    return { ok: false, error: sanitizeIpcError(err, 'Failed') };
  }
  audit(payload);
};
module.exports = { wrap };
`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AFTER the try\/catch/);
});

test('skips the wrapper-definition check when no handler uses wrap(...)', () => {
  const result = runGuard(
    `
const { ipcMain } = require('electron');
ipcMain.handle('good:trycatch', async (event) => {
  try {
    return { success: true };
  } catch (error) {
    return { success: false, error: sanitizeIpcError(error, 'Failed') };
  }
});
`,
    { engineHandlersSource: null },
  );
  assert.equal(result.status, 0, result.stderr);
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
