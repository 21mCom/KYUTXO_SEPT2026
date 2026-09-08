#!/usr/bin/env node
// Packaged-desktop release gate for the device-local network activity log.
//
// The browser check proves reload persistence, but a real Electron process
// restart exercises the desktop profile/lifecycle boundary as well. This gate
// seeds representative activity in the packaged renderer's own IndexedDB,
// closes and reopens the packaged app against the same isolated profile, then
// commits another entry, force-kills Electron without its graceful-close path,
// and verifies the activity UI, raw rows, and provider settings after reopening.
//
// Usage:
//   node scripts/check-packaged-network-privacy-activity-browser.mjs
//   KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-network-privacy-activity-browser.mjs

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';
import {
  assertPackagedAsarFresh,
  assertPackagedBundleFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';
import { prepareWindowsPortableLaunch } from './packaged-windows-portable.mjs';
import {
  clearPackagedCdpOwnership,
  packagedCdpLaunchArgs,
  waitForOwnedPackagedCdp,
  waitForPackagedCdpDown,
} from './packaged-cdp.mjs';

await acquireBrowserCheckLock();

const ROOT = repoRootFromModuleUrl(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const UNPACKED_DIR = path.join(ROOT, 'release', IS_WINDOWS ? 'win-unpacked' : 'linux-unpacked');
const ASAR = path.join(UNPACKED_DIR, 'resources', 'app.asar');
const PACKAGED_EXECUTABLE = path.join(UNPACKED_DIR, IS_WINDOWS ? 'KYUTXO.exe' : 'kyutxo');
const TAG = '[packaged-network-privacy-activity]';
const PASSWORD = 'packaged-network-privacy-activity-check';
const PROVIDER_URL = 'https://provider.example.test/api';
const BUILD_COMMAND_TIMEOUT_MS = 15 * 60_000;
const TASKKILL_TIMEOUT_MS = 15_000;
const FIXTURE_ADDRESS = 'bc1qpackagednetworkprivacyfixture';
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
    if (!fs.existsSync(ASAR)) {
      throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} is missing`);
    }
    assertPackagedBundleFresh({ root: ROOT, tag: TAG });
    assertPackagedAsarFresh({ root: ROOT, asarPath: ASAR, tag: TAG });
    return;
  }

  run('npm', ['run', 'build']);
  assertPackagedBundleFresh({ root: ROOT, tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', [
    'electron-builder',
    '--config',
    'electron-builder.json',
    '--dir',
    IS_WINDOWS ? '--win' : '--linux',
    '-c.npmRebuild=false',
  ]);
  if (!fs.existsSync(ASAR)) {
    throw new Error(`${TAG} packaging produced no ${ASAR}`);
  }
}

async function waitForRendererPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) =>
        candidate.url().startsWith('kyutxo-app://bundle/'),
      );
      if (page) return page;
    }
    await sleep(250);
  }
  throw new Error(`${TAG} packaged renderer page did not appear`);
}

function attachPageDiagnostics(page) {
  console.log(`${TAG} renderer page: ${page.url()}`);
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.log(`${TAG}[renderer-console-${message.type()}] ${message.text().slice(0, 500)}`);
    }
  });
  page.on('pageerror', (error) => {
    console.log(`${TAG}[renderer-pageerror] ${String(error?.stack || error).slice(0, 500)}`);
  });
  page.on('crash', () => console.log(`${TAG}[renderer-crashed] renderer process crashed`));
}

function killWindowsProcessTree(child, force) {
  if (!child?.pid) return;
  const args = ['/PID', String(child.pid), '/T'];
  if (force) args.push('/F');
  const result = spawnSync('taskkill', args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    timeout: TASKKILL_TIMEOUT_MS,
  });
  console.log(`${TAG} taskkill (${force ? 'forced' : 'graceful'}) exit=${result.status}`);
}

async function stopPackagedProcess(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    killWindowsProcessTree(child, false);
    await sleep(2_000);
    killWindowsProcessTree(child, true);
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // The process may already have exited.
  }
  await sleep(2_000);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already have exited.
    }
  }
}

async function forceStopPackagedProcess(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    killWindowsProcessTree(child, true);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already have exited.
    }
  }
}

async function readActivityState(page) {
  return page.evaluate(async () => {
    const repository = window.electronAPI?.protectedStore?.repository;
    if (!repository) throw new Error('Protected repository bridge is unavailable');
    const unwrap = (envelope) => {
      if (!envelope?.ok || envelope.result === undefined) {
        throw new Error(envelope?.error || 'Protected repository operation failed');
      }
      return envelope.result;
    };
    const activity = [];
    let after;
    do {
      const result = unwrap(await repository.page('networkPrivacyActivity', after, 1000, 'asc'));
      activity.push(...result.items);
      after = result.next === null ? undefined : result.next;
    } while (after !== undefined);
    const settings = unwrap(await repository.find('nodeSettings', 'default'));
    return { activity, settings };
  });
}

async function seedActivityState(page, { settings, activity }) {
  await page.evaluate(async ({ settings, activity }) => {
    const repository = window.electronAPI?.protectedStore?.repository;
    if (!repository) throw new Error('Protected repository bridge is unavailable');
    const unwrap = (envelope) => {
      if (!envelope?.ok || envelope.result === undefined) {
        throw new Error(envelope?.error || 'Protected repository operation failed');
      }
      return envelope.result;
    };
    unwrap(await repository.clear('networkPrivacyActivity'));
    unwrap(await repository.save('nodeSettings', settings));
    unwrap(await repository.saveBatch('networkPrivacyActivity', activity));
  }, { settings, activity });
}

async function appendCommittedActivity(page, activity) {
  await page.evaluate(async (activity) => {
    const repository = window.electronAPI?.protectedStore?.repository;
    if (!repository) throw new Error('Protected repository bridge is unavailable');
    const envelope = await repository.save('networkPrivacyActivity', activity);
    if (!envelope?.ok || envelope.result === undefined) {
      throw new Error(envelope?.error || 'Protected repository operation failed');
    }
  }, activity);
}

function assertActivityRows(rows, expectedCount, label) {
  assert.equal(
    rows.length,
    expectedCount,
    `${label}: expected ${expectedCount} persisted activity entries`,
  );
  for (const row of rows) {
    const keys = Object.keys(row).sort();
    const validKeys = row.addressCount === undefined
      ? ['action', 'id', 'providerClass', 'timestamp']
      : ['action', 'addressCount', 'id', 'providerClass', 'timestamp'];
    assert.deepEqual(keys, validKeys, `${label}: activity row contains unexpected fields`);
    assert.equal(typeof row.timestamp, 'number', `${label}: timestamp is not numeric`);
    assert.equal(typeof row.providerClass, 'string', `${label}: provider class is not textual`);
    assert.equal(typeof row.action, 'string', `${label}: action is not textual`);
  }
  const serialized = JSON.stringify(rows);
  for (const forbidden of [FIXTURE_ADDRESS, PROVIDER_URL]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `${label}: persisted activity contains forbidden value ${JSON.stringify(forbidden)}`,
    );
  }
  for (const row of rows) {
    const sensitiveKeys = Object.keys(row).filter(
      (key) => key !== 'addressCount' && /(address|url|response|txid)/i.test(key),
    );
    assert.deepEqual(sensitiveKeys, [], `${label}: activity row contains sensitive field names`);
  }
}

async function main() {
  buildPackage();

  let electronBin = null;
  let xvfbBin = null;
  if (IS_WINDOWS) {
    if (!fs.existsSync(PACKAGED_EXECUTABLE)) {
      throw new Error(`${TAG} packaged Windows executable is missing: ${PACKAGED_EXECUTABLE}`);
    }
  } else {
    ({ electronBin, xvfbBin } = findPackagedBinaries({ tag: TAG }));
    console.log(`${TAG} electron: ${electronBin}`);
    console.log(`${TAG} Xvfb: ${xvfbBin}`);
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-network-privacy-'));
  const portableSetup = IS_WINDOWS ? prepareWindowsPortableLaunch({
    root: ROOT, asarPath: ASAR, home: tempHome, tag: TAG,
  }) : null;
  const cdpUserDataDir = IS_WINDOWS
    ? path.join(portableSetup.launchDir, 'KYUTXO_Data')
    : path.join(tempHome, 'cdp-profile');
  const env = {
    ...(portableSetup?.env || process.env),
    HOME: tempHome,
    XDG_CONFIG_HOME: path.join(tempHome, '.config'),
    XDG_CACHE_HOME: path.join(tempHome, '.cache'),
    XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(tempHome, '.local', 'state'),
    NODE_ENV: 'production',
  };
  if (IS_WINDOWS) {
  }

  let xvfb = null;
  let child = null;
  let browser = null;
  const display = process.env.KYUTXO_PACKAGED_DISPLAY || ':101';
  const launchExecutable = IS_WINDOWS ? portableSetup.executable : electronBin;
  if (!IS_WINDOWS) {
    xvfb = spawn(xvfbBin, [display, '-screen', '0', '1280x800x24'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    xvfb.stderr.on('data', (data) => process.stdout.write(`${TAG}[xvfb] ${data}`));
    await sleep(2_000);
  }

  const launchArgs = IS_WINDOWS
    ? ['--disable-gpu', ...packagedCdpLaunchArgs(cdpUserDataDir)]
    : [ASAR, '--no-sandbox', '--disable-gpu', ...packagedCdpLaunchArgs(cdpUserDataDir)];
  const launchPackagedProcess = () => {
    child = spawn(launchExecutable, launchArgs, {
      cwd: IS_WINDOWS ? portableSetup.launchDir : tempHome,
      env: IS_WINDOWS ? env : { ...env, DISPLAY: display },
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => process.stdout.write(`${TAG}[app] ${data}`));
    child.stderr.on('data', (data) => process.stdout.write(`${TAG}[app-err] ${data}`));
    child.on('exit', (code, signal) => {
      console.log(`${TAG} app process exited (code=${code} signal=${signal})`);
    });
  };

  try {
    launchPackagedProcess();
    let cdp = await waitForOwnedPackagedCdp({ userDataDir: cdpUserDataDir, timeoutMs: 90_000 });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    let page = await waitForRendererPage(browser);
    attachPageDiagnostics(page);
    await unlockIfNeeded(page, PASSWORD, {
      appearTimeoutMs: 60_000,
      label: 'packaged-network-privacy-activity-setup',
    });

    const now = Date.now();
    const settings = {
      id: 'default',
      providerType: 'custom-mempool',
      customUrl: PROVIDER_URL,
      useTor: false,
      requestTimeout: 15_000,
      network: 'mainnet',
      allowLocalNetwork: true,
      trustedLocalHosts: ['node.local.example'],
      useElectrum: false,
      electrumPort: 50_001,
      electrumSSL: false,
      networkPrivacyMode: 'own-node',
      networkAccessEnabled: true,
      networkOnboardingStage: 'complete',
      networkPrivacyChosenAt: now - 1_000,
      firstSyncConfirmedAt: now - 500,
    };
    const activity = [
      {
        timestamp: now - 300,
        providerClass: 'own-node',
        action: 'sync',
        addressCount: 3,
      },
      {
        timestamp: now - 200,
        providerClass: 'own-node',
        action: 'address-check',
        addressCount: 2,
      },
      {
        timestamp: now - 100,
        providerClass: 'own-node',
        action: 'provider-test',
      },
    ];
    await seedActivityState(page, { settings, activity });
    const seeded = await readActivityState(page);
    assertActivityRows(seeded.activity, activity.length, 'before desktop restart');
    assert.deepEqual(seeded.settings, settings, 'seeded provider settings were not stored');

    await browser.close();
    browser = null;
    await stopPackagedProcess(child);
    child = null;
    if (!(await waitForPackagedCdpDown(cdp.port, 30_000))) {
      throw new Error(`${TAG} packaged Electron CDP endpoint stayed up after close`);
    }
    clearPackagedCdpOwnership(cdpUserDataDir);

    launchPackagedProcess();
    cdp = await waitForOwnedPackagedCdp({ userDataDir: cdpUserDataDir, timeoutMs: 90_000 });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    page = await waitForRendererPage(browser);
    attachPageDiagnostics(page);
    await unlockIfNeeded(page, PASSWORD, {
      appearTimeoutMs: 60_000,
      label: 'packaged-network-privacy-activity-reopen',
    });

    const reopened = await readActivityState(page);
    assertActivityRows(reopened.activity, activity.length, 'after graceful desktop restart');
    assert.deepEqual(
      reopened.activity.map(({ id, ...row }) => row),
      activity,
      'activity entries changed across the desktop restart',
    );
    assert.deepEqual(
      reopened.settings,
      settings,
      'provider settings changed across the desktop restart',
    );

    const postRestartActivity = {
      timestamp: now,
      providerClass: 'public-tor',
      action: 'price-source',
    };
    await appendCommittedActivity(page, postRestartActivity);
    const beforeForcedTermination = await readActivityState(page);
    assertActivityRows(
      beforeForcedTermination.activity,
      activity.length + 1,
      'before forced desktop termination',
    );
    assert.deepEqual(
      beforeForcedTermination.settings,
      settings,
      'provider settings changed before forced desktop termination',
    );

    // Do not close CDP first or send SIGTERM: kill the whole detached process
    // group so Electron cannot run before-quit or Chromium's graceful shutdown.
    const abruptlyTerminatedCdp = cdp;
    console.log(
      `${TAG} recorded abruptly terminated CDP ownership ` +
        `${abruptlyTerminatedCdp.browserPath} on port ${abruptlyTerminatedCdp.port}`,
    );
    await forceStopPackagedProcess(child);
    child = null;
    browser = null;
    if (!(await waitForPackagedCdpDown(abruptlyTerminatedCdp.port, 30_000))) {
      throw new Error(`${TAG} packaged Electron CDP endpoint stayed up after forced termination`);
    }
    clearPackagedCdpOwnership(cdpUserDataDir);

    launchPackagedProcess();
    cdp = await waitForOwnedPackagedCdp({ userDataDir: cdpUserDataDir, timeoutMs: 90_000 });
    assert.notEqual(
      cdp.browserPath,
      abruptlyTerminatedCdp.browserPath,
      `${TAG} relaunch reused stale packaged CDP ownership file/token ` +
        `${abruptlyTerminatedCdp.browserPath}`,
    );
    console.log(
      `${TAG} same-profile relaunch established fresh CDP ownership ` +
        `${cdp.browserPath} before Playwright connected`,
    );
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    page = await waitForRendererPage(browser);
    attachPageDiagnostics(page);
    await unlockIfNeeded(page, PASSWORD, {
      appearTimeoutMs: 60_000,
      label: 'packaged-network-privacy-activity-forced-reopen',
    });

    const forceReopened = await readActivityState(page);
    assertActivityRows(
      forceReopened.activity,
      activity.length + 1,
      'after forced desktop termination',
    );
    assert.deepEqual(
      forceReopened.activity.map(({ id, ...row }) => row),
      [...activity, postRestartActivity],
      'fully committed activity entries changed across forced desktop termination',
    );
    assert.deepEqual(
      forceReopened.settings,
      settings,
      'provider settings changed across forced desktop termination',
    );

    await page.getByTestId('button-network-privacy-activity').click();
    const dialog = page.getByTestId('network-privacy-activity-dialog');
    await dialog.waitFor({ state: 'visible' });
    const activityRows = dialog.locator('[data-testid^="network-privacy-activity-row-"]');
    await activityRows.nth(activity.length).waitFor({ state: 'visible' });
    assert.equal(
      await activityRows.count(),
      activity.length + 1,
      'activity dialog rendered an unexpected number of rows',
    );
    const dialogText = await dialog.innerText();
    for (const expected of [
      'Local network activity',
      'Own node',
      'Sync',
      'Address check',
      'Provider test',
      'Price source',
      '3',
      '2',
      'not included in backups',
    ]) {
      assert(dialogText.includes(expected), `activity dialog is missing ${JSON.stringify(expected)}`);
    }

    await page.getByTestId('button-clear-network-privacy-activity').click();
    await page.getByTestId('network-privacy-activity-empty').waitFor({ state: 'visible' });
    const cleared = await readActivityState(page);
    assert.equal(cleared.activity.length, 0, 'clearing activity did not remove all activity entries');
    assert.deepEqual(
      cleared.settings,
      settings,
      'clearing activity changed provider settings',
    );
    console.log(
      `${TAG} graceful restart, forced-termination persistence, sensitive-data, and clear-isolation checks passed`,
    );
  } finally {
    await browser?.close().catch(() => {});
    await stopPackagedProcess(child);
    try {
      process.kill(-xvfb?.pid, 'SIGTERM');
    } catch {
      xvfb?.kill?.('SIGTERM');
    }
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(`${TAG} FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});