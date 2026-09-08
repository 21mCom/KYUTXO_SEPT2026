#!/usr/bin/env node
/*
 * Protected-vault migration release gate.
 *
 * This is intentionally a real packaged-app check. The app must expose the
 * test-only protectedVaultTest.runScenario bridge from the main process. The
 * bridge must execute each scenario against a disposable vault and return
 * evidence, not a boolean. Missing capability is a hard failure: a plaintext
 * or partially implemented app must never pass this release gate.
 *
 * Usage:
 *   node scripts/check-packaged-vault-migration-browser.mjs
 *   KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-vault-migration-browser.mjs
 */

import { chromium } from 'playwright-core';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  assertBackupRecoverySuccessReport,
  assertBackupRecoveryReport,
  assertFailureRecoveryReport,
  assertFreshLifecycleReport,
  assertProtectedVaultReport,
  assertRewrapReport,
  assertSuccessfulMigrationReport,
  assertTamperRejectedReport,
  GENERATION_SWAP_PHASES,
  MIGRATION_PHASES,
  PROTECTED_VAULT_SCENARIOS,
  PROTECTED_VAULT_TEST_API,
  PROTECTED_VAULT_TEST_METHOD,
  PLAINTEXT_MIGRATION_SOURCE_ROOT,
} from './protected-vault-migration-contract.mjs';
import {
  assertPackagedAsarFresh,
  assertPackagedBundleFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';
import {
  packagedCdpLaunchArgs,
  waitForOwnedPackagedCdp,
  waitForPackagedCdpDown,
} from './packaged-cdp.mjs';

await acquireBrowserCheckLock();

const ROOT = repoRootFromModuleUrl(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const RELEASE_DIR = path.join(ROOT, 'release');
const UNPACKED_DIR = path.join(RELEASE_DIR, IS_WINDOWS ? 'win-unpacked' : 'linux-unpacked');
const ASAR = path.join(UNPACKED_DIR, 'resources', 'app.asar');
const PACKAGED_EXECUTABLE = path.join(UNPACKED_DIR, IS_WINDOWS ? 'KYUTXO.exe' : 'kyutxo');
const TAG = '[packaged-vault-migration]';
const BUILD_COMMAND_TIMEOUT_MS = 15 * 60_000;
const TASKKILL_TIMEOUT_MS = 15_000;
const FIXTURE_TOKENS = [
  'KYUTXO_PROTECTED_ROW_6d974c29f24a',
  'KYUTXO_PROTECTED_ATTACHMENT_3ac89e7441bf',
  'KYUTXO_V44_ENTITY_1f32a',
  'KYUTXO_V44_WALLET_2d45b',
  'KYUTXO_V44_OWNERSHIP_3e56c',
  'KYUTXO_V44_TRANSACTION_METADATA_4f67d',
  'KYUTXO_V44_TRANSACTION_LEG_5a78e',
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', timeout: BUILD_COMMAND_TIMEOUT_MS });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    throw new Error(`${TAG} timed out during package build command ${command} after ${BUILD_COMMAND_TIMEOUT_MS}ms`);
  }
  if (result.status !== 0) {
    throw new Error(`${TAG} command failed (exit ${result.status}): ${command}`);
  }
}

function buildPackage() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) throw new Error(`${TAG} requested skip-build but ${ASAR} is missing`);
    assertPackagedBundleFresh({ root: ROOT, tag: TAG });
    assertPackagedAsarFresh({ root: ROOT, asarPath: ASAR, tag: TAG });
    return;
  }
  run('npm', ['run', 'build']);
  assertPackagedBundleFresh({ root: ROOT, tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', [
    'electron-builder', '--config', 'electron-builder.json', '--dir',
    IS_WINDOWS ? '--win' : '--linux', '-c.npmRebuild=false',
  ]);
  if (!fs.existsSync(ASAR)) throw new Error(`${TAG} packaging produced no ${ASAR}`);
}

async function waitForPage(browser) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url());
    if (page) return page;
    await sleep(250);
  }
  throw new Error(`${TAG} packaged renderer page did not start`);
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { timeout: TASKKILL_TIMEOUT_MS });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill?.('SIGTERM');
  }
}

function isWithin(relativePath, relativeRoot) {
  const normalizedPath = relativePath.split(path.sep).join('/');
  const normalizedRoot = relativeRoot.split(path.sep).join('/').replace(/\/+$/, '');
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function readFileWithTransientRetries(file, attempts = 20, delayMs = 100) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.readFileSync(file);
    } catch (error) {
      const transient = error && ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
      if (!transient || attempt >= attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

function scanDisposableProfile(root) {
  const files = [];
  const matches = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${TAG} disposable profile contains a symbolic link`);
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      // Chromium can briefly retain a Windows file handle while updating its
      // profile. Never skip the file: retry the read, then fail closed.
      const bytes = readFileWithTransientRetries(absolutePath);
      const relativePath = path.relative(root, absolutePath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      files.push({ relativePath, bytes: bytes.length, digest });
      for (const token of FIXTURE_TOKENS) {
        if (bytes.includes(Buffer.from(token, 'utf8'))) matches.push({ relativePath, token });
      }
    }
  };
  walk(root);
  if (files.length === 0) throw new Error(`${TAG} disposable profile scan found no files`);
  const inventoryDigest = createHash('sha256')
    .update(files
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((file) => `${file.relativePath}\0${file.bytes}\0${file.digest}\n`)
      .join(''))
    .digest('hex');
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    inventoryDigest,
    matches,
  };
}

function classifyAndAssert(report, scenario) {
  if (scenario === 'fresh-lifecycle') return assertFreshLifecycleReport(report);
  if (scenario === 'migration-success') return assertSuccessfulMigrationReport(report);
  if (scenario === 'password-rewrap') return assertRewrapReport(report);
  if (scenario === 'encrypted-backup-recovery') {
    return assertBackupRecoverySuccessReport(report);
  }
  if (scenario === 'tamper-database' || scenario === 'tamper-attachment' ||
      scenario === 'wrong-password') {
    return assertTamperRejectedReport(report, scenario);
  }
  if (scenario.endsWith('-backup') || scenario === 'disk-full-restore') {
    return assertBackupRecoveryReport(report, scenario);
  }
  if (scenario.startsWith('migration-failure:') ||
      scenario.startsWith('crash-') ||
      scenario === 'disk-full-migration') {
    return assertFailureRecoveryReport(report, scenario);
  }
  return assertProtectedVaultReport(report, scenario);
}

async function main() {
  buildPackage();
  const { electronBin = null, xvfbBin = null } = IS_WINDOWS
    ? {}
    : findPackagedBinaries({ tag: TAG });
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-protected-gate-'));
  const cdpUserDataDir = path.join(tempHome, 'cdp-profile');
  const display = `:${100 + (process.pid % 400)}`;
  let xvfb;
  let child;
  let browser;
  let cdpPort = null;
  const results = [];

  try {
    if (!IS_WINDOWS) {
      xvfb = spawn(xvfbBin, [display, '-screen', '0', '1280x800x24'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      xvfb.stderr.on('data', (chunk) => process.stdout.write(`${TAG}[xvfb] ${chunk}`));
    }

    const env = {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_CACHE_HOME: path.join(tempHome, '.cache'),
      XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
      APPDATA: tempHome,
      LOCALAPPDATA: tempHome,
      TMPDIR: path.join(tempHome, 'os-temp'),
      TEMP: path.join(tempHome, 'os-temp'),
      TMP: path.join(tempHome, 'os-temp'),
      KYUTXO_PROTECTED_VAULT_TEST: '1',
    };
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    const args = IS_WINDOWS
      ? [...packagedCdpLaunchArgs(cdpUserDataDir)]
      : [ASAR, '--no-sandbox', '--disable-gpu', ...packagedCdpLaunchArgs(cdpUserDataDir)];
    const executable = IS_WINDOWS ? PACKAGED_EXECUTABLE : electronBin;
    child = spawn(executable, args, {
      cwd: tempHome,
      env: IS_WINDOWS ? env : { ...env, DISPLAY: display },
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => process.stdout.write(`${TAG}[app] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stdout.write(`${TAG}[app-err] ${chunk}`));

    const cdp = await waitForOwnedPackagedCdp({ userDataDir: cdpUserDataDir, timeoutMs: 90_000 });
    cdpPort = cdp.port;
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    const page = await waitForPage(browser);
    await page.waitForFunction(() => document.readyState === 'interactive' || document.readyState === 'complete', null, {
      timeout: 60_000,
    });

    const capability = await page.evaluate(({ apiName, methodName }) => {
      const api = window.electronAPI?.[apiName];
      return {
        present: !!api,
        method: typeof api?.[methodName],
      };
    }, { apiName: PROTECTED_VAULT_TEST_API, methodName: PROTECTED_VAULT_TEST_METHOD });
    if (!capability.present || capability.method !== 'function') {
      throw new Error(
        `${TAG} missing ${PROTECTED_VAULT_TEST_API}.${PROTECTED_VAULT_TEST_METHOD}; ` +
        'the packaged app has no protected-vault proof bridge',
      );
    }

    for (const scenario of PROTECTED_VAULT_SCENARIOS) {
      const report = await page.evaluate(
        async ({ apiName, methodName, scenario, fixtureTokens }) => {
          return window.electronAPI[apiName][methodName]({ scenario, fixtureTokens });
        },
        {
          apiName: PROTECTED_VAULT_TEST_API,
          methodName: PROTECTED_VAULT_TEST_METHOD,
          scenario,
          fixtureTokens: FIXTURE_TOKENS,
        },
      );
      classifyAndAssert(report, scenario);
      const scan = scanDisposableProfile(tempHome);
      if (report.recoveryAction === 'source-preserved') {
        if (report.plaintextSourceRelativeRoot !== PLAINTEXT_MIGRATION_SOURCE_ROOT) {
          throw new Error(`${TAG} ${scenario} reported an invalid plaintext source root`);
        }
        const sourceAbsolute = path.join(tempHome, PLAINTEXT_MIGRATION_SOURCE_ROOT);
        if (!fs.existsSync(sourceAbsolute) || !fs.statSync(sourceAbsolute).isDirectory()) {
          throw new Error(`${TAG} ${scenario} preserved source root does not exist`);
        }
        if (scan.matches.length === 0) {
          throw new Error(`${TAG} ${scenario} did not preserve the plaintext source`);
        }
        const outsideSource = scan.matches.filter(
          (match) => !isWithin(match.relativePath, report.plaintextSourceRelativeRoot),
        );
        if (outsideSource.length > 0) {
          throw new Error(`${TAG} ${scenario} leaked fixture plaintext outside the source`);
        }
      } else if (scan.matches.length > 0) {
        throw new Error(`${TAG} ${scenario} left fixture plaintext in the locked profile`);
      }
      results.push({ scenario, passed: true });
      console.log(
        `${TAG} PASS ${scenario} ` +
        `(scanned ${scan.files} files/${scan.bytes} bytes, inventory ${scan.inventoryDigest})`,
      );
    }

    // Keep this explicit in the gate output: reviewers can see that the two
    // phase families were not silently reduced to a single smoke test.
    console.log(
      `${TAG} covered ${MIGRATION_PHASES.length} migration phases and ` +
      `${GENERATION_SWAP_PHASES.length} generation-swap phases`,
    );
  } finally {
    await browser?.close().catch(() => {});
    killTree(child);
    if (cdpPort !== null && !(await waitForPackagedCdpDown(cdpPort, 30_000))) {
      throw new Error(`${TAG} packaged process still owns CDP port ${cdpPort} after shutdown`);
    }
    try { process.kill(-xvfb?.pid, 'SIGTERM'); } catch { xvfb?.kill?.('SIGTERM'); }
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }

  if (results.length !== PROTECTED_VAULT_SCENARIOS.length) {
    throw new Error(`${TAG} incomplete scenario matrix`);
  }
  console.log(`${TAG} all ${results.length} protected-vault scenarios passed`);
}

main().catch((error) => {
  console.error(`${TAG} FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});
