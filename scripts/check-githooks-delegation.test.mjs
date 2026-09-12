// Offline tests for the hook-delegation guard itself. Runs the real
// scripts/check-githooks-delegation.js against temp fixture hooks dirs
// (via the CHECK_GITHOOKS_DIR override) so a refactor can't quietly loosen
// its delegation regexes and let a broken shim pass.
//
// Run with: node --test scripts/check-githooks-delegation.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const GUARD = path.resolve(path.dirname(__filename), 'check-githooks-delegation.js');

const GOOD_PRE_COMMIT = [
  '#!/bin/sh',
  'legacy_hook="$(git rev-parse --git-dir)/hooks/pre-commit"',
  'if [ -x "$legacy_hook" ]; then',
  '  exec "$legacy_hook" "$@"',
  'fi',
  'exit 0',
  '',
].join('\n');

const GOOD_PRE_PUSH = [
  '#!/bin/sh',
  'node scripts/check-lockfile-urls.js || {',
  '  echo "Push blocked"',
  '  exit 1',
  '}',
  '',
].join('\n');

function makeFixtureDir({ preCommit = GOOD_PRE_COMMIT, prePush = GOOD_PRE_PUSH, mode = 0o755 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githooks-guard-test-'));
  if (preCommit !== null) {
    fs.writeFileSync(path.join(dir, 'pre-commit'), preCommit, { mode });
  }
  if (prePush !== null) {
    fs.writeFileSync(path.join(dir, 'pre-push'), prePush, { mode });
  }
  return dir;
}

function runGuard(hooksDir) {
  return spawnSync(process.execPath, [GUARD], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CHECK_GITHOOKS_DIR: hooksDir },
  });
}

function withFixture(opts, fn) {
  const dir = makeFixtureDir(opts);
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertFails(result, messagePattern) {
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stderr, /check-githooks-delegation: FAILED/);
  assert.match(result.stderr, messagePattern);
}

test('passing fixture: valid delegating hooks exit 0', () => {
  withFixture({}, (dir) => {
    const result = runGuard(dir);
    assert.equal(result.status, 0, `expected exit 0\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /check-githooks-delegation: OK/);
  });
});

test('missing pre-commit fails', () => {
  withFixture({ preCommit: null }, (dir) => {
    assertFails(runGuard(dir), /pre-commit is missing/);
  });
});

test('missing pre-push fails', () => {
  withFixture({ prePush: null }, (dir) => {
    assertFails(runGuard(dir), /pre-push is missing/);
  });
});

test(
  'non-executable hooks fail',
  { skip: process.platform === 'win32' ? 'Windows does not expose POSIX execute bits' : false },
  () => {
    withFixture({ mode: 0o644 }, (dir) => {
      const result = runGuard(dir);
      assertFails(result, /pre-commit is not executable/);
      assert.match(result.stderr, /pre-push is not executable/);
    });
  },
);

test('missing shebang fails', () => {
  const noShebang = GOOD_PRE_COMMIT.replace('#!/bin/sh\n', '# not a shebang\n');
  withFixture({ preCommit: noShebang }, (dir) => {
    assertFails(runGuard(dir), /pre-commit is missing a shebang/);
  });
});

test('pre-commit that never references the legacy hook path fails', () => {
  const broken = ['#!/bin/sh', 'echo "doing nothing useful" "$@"', 'exit 0', ''].join('\n');
  withFixture({ preCommit: broken }, (dir) => {
    const result = runGuard(dir);
    assertFails(result, /no longer references the legacy \.git\/hooks\/pre-commit path/);
    assert.match(result.stderr, /no longer `exec`s the legacy hook/);
  });
});

test('pre-commit that resolves the legacy hook but never execs it fails', () => {
  const broken = [
    '#!/bin/sh',
    'legacy_hook="$(git rev-parse --git-dir)/hooks/pre-commit"',
    'echo "would run $legacy_hook" "$@"',
    'exit 0',
    '',
  ].join('\n');
  withFixture({ preCommit: broken }, (dir) => {
    assertFails(runGuard(dir), /no longer `exec`s the legacy hook/);
  });
});

test('pre-commit that execs the legacy hook without "$@" fails', () => {
  const broken = [
    '#!/bin/sh',
    'legacy_hook="$(git rev-parse --git-dir)/hooks/pre-commit"',
    'if [ -x "$legacy_hook" ]; then',
    '  exec "$legacy_hook"',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  withFixture({ preCommit: broken }, (dir) => {
    assertFails(runGuard(dir), /must forward hook arguments with "\$@"/);
  });
});

test('pre-push without check-lockfile-urls.js fails', () => {
  const broken = ['#!/bin/sh', 'echo "no lockfile gate here"', 'exit 0', ''].join('\n');
  withFixture({ prePush: broken }, (dir) => {
    assertFails(runGuard(dir), /no longer runs scripts\/check-lockfile-urls\.js/);
  });
});

test('pre-commit that is a directory fails as not a regular file', () => {
  withFixture({ preCommit: null }, (dir) => {
    fs.mkdirSync(path.join(dir, 'pre-commit'));
    assertFails(runGuard(dir), /exists but is not a regular file/);
  });
});

test('guard still passes against the real repo .githooks (no override)', () => {
  const result = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `real .githooks failed the guard:\n${result.stderr}`);
});
