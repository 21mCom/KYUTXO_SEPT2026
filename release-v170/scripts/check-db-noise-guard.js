#!/usr/bin/env node

// Guard: hidden database errors in tests must fail loudly.
//
// The vitest setup hook client/src/test/failOnDbErrorNoise.ts turns unhandled
// promise rejections and Dexie "DatabaseClosedError" console noise into hard
// test failures. This script keeps that protection honest:
//
//   1. Static check — the setup file exists and is wired into
//      vitest.config.ts setupFiles (so it can't be silently removed).
//   2. Dynamic check — a temporary canary test that fires an unhandled
//      DatabaseClosedError rejection is written into the test tree; the guard
//      asserts vitest FAILS it with the [db-error-noise] message, then the
//      canary is deleted. If vitest ever passes the canary, the hook has
//      stopped working and this script exits non-zero.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const SETUP_FILE = path.join(ROOT, 'client/src/test/failOnDbErrorNoise.ts');
const VITEST_CONFIG = path.join(ROOT, 'vitest.config.ts');
const CANARY = path.join(ROOT, 'client/src/test/__dbNoiseGuardCanary__.test.ts');

let failed = false;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failed = true;
}

// --- 1. static wiring checks -------------------------------------------------

if (!fs.existsSync(SETUP_FILE)) {
  fail(`missing setup file ${path.relative(ROOT, SETUP_FILE)}`);
}
const config = fs.readFileSync(VITEST_CONFIG, 'utf8');
if (!/setupFiles\s*:\s*\[[^\]]*failOnDbErrorNoise/.test(config)) {
  fail('vitest.config.ts no longer wires client/src/test/failOnDbErrorNoise.ts into test.setupFiles');
}
if (fs.existsSync(SETUP_FILE)) {
  const setup = fs.readFileSync(SETUP_FILE, 'utf8');
  if (!setup.includes('unhandledRejection')) {
    fail('failOnDbErrorNoise.ts no longer listens for unhandledRejection');
  }
  if (!/DatabaseClosedError/.test(setup)) {
    fail('failOnDbErrorNoise.ts no longer matches DatabaseClosedError console noise');
  }
}

if (failed) {
  process.exit(1);
}

// --- 2. dynamic canary: an unmocked-Dexie-style rejection must fail ----------

const canarySource = `// @vitest-environment jsdom
// TEMPORARY canary written by scripts/check-db-noise-guard.js.
// If you are reading this in the repo, a guard run crashed mid-flight; delete it.
import { it } from "vitest";

class DatabaseClosedError extends Error {
  constructor() {
    super("DatabaseClosedError: canary — simulated unmocked Dexie CRUD call");
    this.name = "DatabaseClosedError";
  }
}

it("fires a hidden database rejection (must be failed by failOnDbErrorNoise)", async () => {
  // Fire-and-forget rejection, exactly what an unmocked getSettings() call
  // from a mounted component produces in jsdom.
  Promise.reject(new DatabaseClosedError());
  await new Promise((resolve) => setTimeout(resolve, 0));
});
`;

fs.writeFileSync(CANARY, canarySource);
let result;
try {
  result = spawnSync('npx', ['vitest', 'run', path.relative(ROOT, CANARY)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, CI: 'true' },
  });
} finally {
  fs.rmSync(CANARY, { force: true });
}

const output = `${result.stdout || ''}\n${result.stderr || ''}`;

if (result.error) {
  fail(`canary vitest run failed to spawn: ${result.error.message}`);
} else if (result.status === 0) {
  fail(
    'canary test with a hidden DatabaseClosedError rejection PASSED — ' +
      'failOnDbErrorNoise.ts is no longer failing tests on hidden database errors',
  );
} else if (!output.includes('[db-error-noise]')) {
  fail(
    'canary vitest run failed, but not with the [db-error-noise] guard message — ' +
      'the setup hook may be broken. Output tail:\n' +
      output.slice(-2000),
  );
}

if (failed) {
  process.exit(1);
}

console.log('OK: db-error-noise guard is wired and the canary rejection fails as expected.');
