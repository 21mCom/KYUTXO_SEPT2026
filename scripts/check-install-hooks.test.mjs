// Offline tests for the pre-commit hook installer. Runs the real
// scripts/install-hooks.sh inside a temp git repo against a fresh hook, a
// legacy untagged hook with stale variants, and a hook with an outdated
// tagged command, so a future edit can't quietly reintroduce duplicate or
// stale managed-check lines.
//
// Run with: node --test scripts/check-install-hooks.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const INSTALLER = path.resolve(path.dirname(__filename), 'install-hooks.sh');

// Managed check keys the installer must maintain (kept in sync with the
// `install_check` calls in scripts/install-hooks.sh — parsed, not hardcoded,
// so adding a check there is automatically covered here).
const installerSource = fs.readFileSync(INSTALLER, 'utf8');
const MANAGED_KEYS = [...installerSource.matchAll(/^install_check "([^"]+)"/gm)].map(
  (m) => m[1]
);

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hooks-test-'));
  const init = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

function runInstaller(repoDir) {
  const result = spawnSync('sh', [INSTALLER], { cwd: repoDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function hookPath(repoDir) {
  return path.join(repoDir, '.git', 'hooks', 'pre-commit');
}

function readHook(repoDir) {
  return fs.readFileSync(hookPath(repoDir), 'utf8');
}

function hookLines(repoDir) {
  return readHook(repoDir).split('\n').filter((l) => l.length > 0);
}

function linesForKey(lines, key) {
  return lines.filter((l) => l.endsWith(`# managed-check: ${key}`));
}

function assertExactlyOneLinePerKey(lines) {
  for (const key of MANAGED_KEYS) {
    const matches = linesForKey(lines, key);
    assert.equal(matches.length, 1, `expected exactly 1 line for key "${key}", got ${matches.length}`);
  }
}

function withRepo(fn) {
  const repo = makeRepo();
  try {
    fn(repo);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('installer source declares managed checks', () => {
  assert.ok(MANAGED_KEYS.length >= 1, 'no install_check calls found in install-hooks.sh');
  assert.equal(new Set(MANAGED_KEYS).size, MANAGED_KEYS.length, 'duplicate managed-check keys');
});

test('fresh repo: hook is created with exactly one tagged line per check', () => {
  withRepo((repo) => {
    runInstaller(repo);
    const lines = hookLines(repo);
    assert.equal(lines[0], '#!/bin/sh');
    assertExactlyOneLinePerKey(lines);
    // No untagged command lines besides the shebang.
    assert.equal(
      lines.length,
      1 + MANAGED_KEYS.length,
      `unexpected extra lines in fresh hook:\n${lines.join('\n')}`
    );
    // Executable bit set.
    assert.ok(fs.statSync(hookPath(repo)).mode & 0o111, 'hook is not executable');
  });
});

test('legacy untagged hook with stale variants: replaced, user lines preserved', () => {
  withRepo((repo) => {
    const legacy = [
      '#!/bin/sh',
      'echo "user added line" # keep me',
      // Untagged exact current command (older installer format).
      'node scripts/check-crud-guards.js',
      // Untagged stale variant matching a legacy prefix (old vitest file list).
      'npx vitest run client/src/pages/ProofOfFundsDeclaration.documentIntegrity.test.tsx',
      // Another untagged stale prefix variant.
      'node scripts/check-lockfile-urls.js --old-flag',
      'npm run user-custom-check',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(hookPath(repo)), { recursive: true });
    fs.writeFileSync(hookPath(repo), legacy);

    runInstaller(repo);
    const lines = hookLines(repo);

    assertExactlyOneLinePerKey(lines);
    assert.ok(lines.includes('echo "user added line" # keep me'), 'user line dropped');
    assert.ok(lines.includes('npm run user-custom-check'), 'user check dropped');
    // Stale untagged variants must be gone.
    assert.ok(
      !lines.includes('node scripts/check-crud-guards.js'),
      'untagged legacy line not replaced with tagged form'
    );
    assert.ok(
      !lines.some((l) => l === 'node scripts/check-lockfile-urls.js --old-flag'),
      'stale legacy-prefix variant survived'
    );
    assert.ok(
      !lines.some(
        (l) =>
          l.startsWith('npx vitest run client/src/pages/ProofOfFundsDeclaration.') &&
          !l.includes('# managed-check:')
      ),
      'untagged vitest legacy variant survived'
    );
  });
});

test('outdated tagged command: replaced with current command, no duplicates', () => {
  withRepo((repo) => {
    const stale = [
      '#!/bin/sh',
      'node scripts/check-crud-guards-old.js # managed-check: crud-guards',
      'npx vitest run some/old/file.test.tsx # managed-check: pof-page-tests',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(hookPath(repo)), { recursive: true });
    fs.writeFileSync(hookPath(repo), stale);

    runInstaller(repo);
    const lines = hookLines(repo);

    assertExactlyOneLinePerKey(lines);
    assert.ok(
      !lines.some((l) => l.includes('check-crud-guards-old.js')),
      'stale tagged crud-guards command survived'
    );
    assert.ok(
      !lines.some((l) => l.includes('some/old/file.test.tsx')),
      'stale tagged pof-page-tests command survived'
    );
  });
});

test('repeated runs are idempotent', () => {
  withRepo((repo) => {
    runInstaller(repo);
    const first = readHook(repo);
    runInstaller(repo);
    const second = readHook(repo);
    runInstaller(repo);
    const third = readHook(repo);
    assert.equal(second, first, 'second run changed the hook');
    assert.equal(third, first, 'third run changed the hook');
    assertExactlyOneLinePerKey(hookLines(repo));
  });
});

test('duplicate identical tagged lines are collapsed to one', () => {
  withRepo((repo) => {
    // Simulate the pre-fix failure mode: the same tagged line appended twice.
    runInstaller(repo);
    const content = readHook(repo);
    const crudLine = content
      .split('\n')
      .find((l) => l.endsWith('# managed-check: crud-guards'));
    fs.writeFileSync(hookPath(repo), content + crudLine + '\n');

    runInstaller(repo);
    assertExactlyOneLinePerKey(hookLines(repo));
  });
});

// ---------------------------------------------------------------------------
// Build-mode split: hook must run check-crud-guards in full-scan mode
// (without --production-only) so test-file violations are caught pre-commit.
// ---------------------------------------------------------------------------

const SCANNER = path.resolve(path.dirname(__filename), 'check-crud-guards.js');
const scannerSource = fs.readFileSync(SCANNER, 'utf8');

test('install-hooks.sh wires crud-guards without --production-only', () => {
  // The CRUD_CMD variable must be the plain invocation, not the build-time
  // variant.  If --production-only crept in, test-file violations would
  // silently pass through every developer pre-commit check.
  const match = installerSource.match(/^CRUD_CMD="([^"]+)"/m);
  assert.ok(match, 'CRUD_CMD not found in install-hooks.sh');
  assert.ok(
    !match[1].includes('--production-only'),
    `CRUD_CMD includes --production-only; hook would miss test-file violations: "${match[1]}"`
  );
});

test('installed hook crud-guards line omits --production-only', () => {
  withRepo((repo) => {
    runInstaller(repo);
    const lines = hookLines(repo);
    const crudLine = lines.find((l) => l.includes('# managed-check: crud-guards'));
    assert.ok(crudLine, 'crud-guards managed-check line not found in hook after install');
    assert.ok(
      !crudLine.includes('--production-only'),
      `hook crud-guards line includes --production-only; hook would miss test-file violations:\n  ${crudLine}`
    );
  });
});

test('check-crud-guards.js gates test-file skipping on PRODUCTION_ONLY flag', () => {
  // The scanner must only bypass test files when the --production-only argv
  // flag is active.  Without it (the hook invocation), every test file is
  // included in the scan.
  assert.ok(
    /const PRODUCTION_ONLY\s*=\s*process\.argv\.includes\(['"]--production-only['"]\)/.test(
      scannerSource
    ),
    'check-crud-guards.js does not derive PRODUCTION_ONLY from --production-only argv'
  );
  assert.ok(
    /PRODUCTION_ONLY\s*&&\s*isTestFile/.test(scannerSource),
    'check-crud-guards.js does not gate test-file skipping on PRODUCTION_ONLY; ' +
      'removing the flag would break hook coverage of test files'
  );
});

test('scanner in full-scan mode flags a raw-Dexie write inside a .test.ts file', () => {
  // Create a temporary fixture file inside the real scan directory that
  // contains a direct db.records.add() call (a guarded-table write outside
  // any CRUD layer).  Running the scanner without --production-only must
  // detect it and exit non-zero.  The fixture is cleaned up in a finally
  // block regardless of the outcome.
  const ROOT = path.resolve(path.dirname(__filename), '..');
  const fixtureDir = path.join(ROOT, 'client', 'src', '__crud_guard_violation_fixture__');
  const fixtureFile = path.join(fixtureDir, 'violation.test.ts');

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    fixtureFile,
    '// CRUD-guard fixture — do not commit\ndb.records.add({ id: "x" });\n'
  );

  let result;
  try {
    result = spawnSync('node', [SCANNER], { cwd: ROOT, encoding: 'utf8' });
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  assert.equal(
    result.status,
    1,
    'scanner should exit 1 when a test file contains a guarded-table write, ' +
      'but it exited ' + result.status + '\nstdout: ' + result.stdout +
      '\nstderr: ' + result.stderr
  );
  assert.ok(
    result.stderr.includes('violation.test.ts') || result.stdout.includes('violation.test.ts'),
    'scanner output does not mention the violating test file'
  );
});

test('scanner in --production-only mode ignores a raw-Dexie write inside a .test.ts file', () => {
  // Create the same fixture as the full-scan test above, but run the scanner
  // with --production-only.  Build mode must skip test files entirely so that
  // seeding helpers used only in tests never block CI builds.
  const ROOT = path.resolve(path.dirname(__filename), '..');
  const fixtureDir = path.join(ROOT, 'client', 'src', '__crud_guard_violation_fixture__');
  const fixtureFile = path.join(fixtureDir, 'violation.test.ts');

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    fixtureFile,
    '// CRUD-guard fixture — do not commit\ndb.records.add({ id: "x" });\n'
  );

  let result;
  try {
    result = spawnSync('node', [SCANNER, '--production-only'], { cwd: ROOT, encoding: 'utf8' });
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  assert.equal(
    result.status,
    0,
    'scanner with --production-only should exit 0 when the only violation is inside a .test.ts file, ' +
      'but it exited ' + result.status + '\nstdout: ' + result.stdout +
      '\nstderr: ' + result.stderr
  );
});

test('scanner in --production-only mode flags a raw-Dexie write inside a non-test source file', () => {
  // This test guards against a regression where the isTestFile predicate is
  // widened so broadly that --production-only accidentally skips ALL files and
  // stops catching real production violations.  A non-test source file
  // (violation.ts, not violation.test.ts) containing a direct db.records.add()
  // call must still cause the scanner to exit non-zero even when
  // --production-only is active.
  const ROOT = path.resolve(path.dirname(__filename), '..');
  const fixtureDir = path.join(ROOT, 'client', 'src', '__crud_guard_violation_fixture__');
  const fixtureFile = path.join(fixtureDir, 'violation.ts');

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    fixtureFile,
    '// CRUD-guard fixture — do not commit\ndb.records.add({ id: "x" });\n'
  );

  let result;
  try {
    result = spawnSync('node', [SCANNER, '--production-only'], { cwd: ROOT, encoding: 'utf8' });
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  assert.equal(
    result.status,
    1,
    'scanner with --production-only should exit 1 when a non-test source file contains a guarded-table write, ' +
      'but it exited ' + result.status + '\nstdout: ' + result.stdout +
      '\nstderr: ' + result.stderr
  );
  assert.ok(
    result.stderr.includes('violation.ts') || result.stdout.includes('violation.ts'),
    'scanner output does not mention the violating non-test source file'
  );
});
