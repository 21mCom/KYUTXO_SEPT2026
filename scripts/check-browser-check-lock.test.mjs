// Offline tests for the browser-check serialization-lock guard. Runs the real
// scripts/check-browser-check-lock.js against fixture script directories via
// CHECK_BROWSER_CHECK_LOCK_SCRIPTS_DIR, so extension and exclusion changes
// cannot silently stop protecting new browser checks.
//
// Run with: node --test scripts/check-browser-check-lock.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT = path.resolve(
  path.dirname(__filename),
  'check-browser-check-lock.js',
);
const LOCK_MODULE = pathToFileURL(
  path.resolve(path.dirname(__filename), 'browser-check-lock.mjs'),
).href;

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

function createLockDir(name) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `browser-check-lock-${name}-`),
  );
  const lockDir = path.join(root, 'lock');
  fs.mkdirSync(lockDir);
  return { root, lockDir };
}

function acquireCommand(label, hold = false) {
  const command = [
    `import { acquireBrowserCheckLock } from ${JSON.stringify(LOCK_MODULE)};`,
    `await acquireBrowserCheckLock(${JSON.stringify(label)});`,
    'console.log("ACQUIRED");',
  ];
  if (hold) {
    command.push('setInterval(() => {}, 1000);');
    command.push('await new Promise(() => {});');
  }
  return command.join('\n');
}

function startAcquirer(lockDir, label, hold = false) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', acquireCommand(label, hold)],
    {
      env: { ...process.env, BROWSER_CHECK_LOCK_DIR: lockDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function waitForOutput(run, text, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.stdout.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(text)}; stdout=${JSON.stringify(
      run.stdout,
    )}; stderr=${JSON.stringify(run.stderr)}`,
  );
}

async function stopChild(run) {
  if (run.child.exitCode === null) {
    run.child.kill('SIGTERM');
    await new Promise((resolve) => run.child.once('exit', resolve));
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

test('creates a missing parent directory before acquiring the lock', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-check-lock-missing-parent-'),
  );
  const lockDir = path.join(root, 'missing', 'nested', 'lock');
  try {
    assert.equal(fs.existsSync(path.dirname(lockDir)), false);
    const res = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', acquireCommand('missing-parent-check')],
      {
        env: { ...process.env, BROWSER_CHECK_LOCK_DIR: lockDir },
        encoding: 'utf8',
        timeout: 5000,
      },
    );

    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /ACQUIRED/);
    assert.equal(fs.existsSync(path.dirname(lockDir)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reaps a lock whose recorded owner process has died', () => {
  const { root, lockDir } = createLockDir('dead-owner');
  try {
    const exitedOwner = spawnSync(process.execPath, ['-e', ''], {
      encoding: 'utf8',
    });
    assert.equal(exitedOwner.status, 0, exitedOwner.stderr);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({
        pid: exitedOwner.pid,
        label: 'crashed-check',
      }),
    );

    const res = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', acquireCommand('recovery-check')],
      {
        env: { ...process.env, BROWSER_CHECK_LOCK_DIR: lockDir },
        encoding: 'utf8',
        timeout: 5000,
      },
    );

    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    assert.match(
      res.stdout,
      /reaped stale lock \(owner pid \d+ "crashed-check" is gone\)/,
    );
    assert.match(res.stdout, /ACQUIRED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'does not reap an ownerless lock until it is older than the orphan threshold',
  async () => {
    const { root, lockDir } = createLockDir('orphan-age');
    const waiter = startAcquirer(lockDir, 'young-orphan-waiter');
    try {
      await waitForOutput(waiter, 'waiting for another browser check');
      await new Promise((resolve) => setTimeout(resolve, 2100));
      assert.doesNotMatch(waiter.stdout, /ACQUIRED/);
      assert.equal(fs.existsSync(lockDir), true);
    } finally {
      await stopChild(waiter);
      fs.rmSync(root, { recursive: true, force: true });
    }

    const aged = createLockDir('aged-orphan');
    try {
      const old = new Date(Date.now() - 65_000);
      fs.utimesSync(aged.lockDir, old, old);

      const res = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', acquireCommand('aged-orphan-recovery')],
        {
          env: { ...process.env, BROWSER_CHECK_LOCK_DIR: aged.lockDir },
          encoding: 'utf8',
          timeout: 5000,
        },
      );

      assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
      assert.match(res.stdout, /reaped stale lock \(owner unknown\/orphaned\)/);
      assert.match(res.stdout, /ACQUIRED/);
    } finally {
      fs.rmSync(aged.root, { recursive: true, force: true });
    }
  },
);

test('never reaps a lock while its owner process is still live', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-check-lock-live-owner-'),
  );
  const lockDir = path.join(root, 'lock');
  const owner = startAcquirer(lockDir, 'live-check-owner', true);
  let waiter;
  try {
    await waitForOutput(owner, 'ACQUIRED');
    waiter = startAcquirer(lockDir, 'live-check-waiter');
    await waitForOutput(waiter, 'waiting for another browser check');
    await new Promise((resolve) => setTimeout(resolve, 2100));

    assert.doesNotMatch(waiter.stdout, /ACQUIRED/);
    assert.equal(fs.existsSync(lockDir), true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'))).pid,
      owner.child.pid,
    );
  } finally {
    if (waiter) await stopChild(waiter);
    await stopChild(owner);
    fs.rmSync(root, { recursive: true, force: true });
  }
});