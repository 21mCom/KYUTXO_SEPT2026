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

await acquireBrowserCheckLock();

const ROOT = repoRootFromModuleUrl(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const RELEASE_DIR = path.join(ROOT, 'release');
const UNPACKED_DIR = path.join(RELEASE_DIR, IS_WINDOWS ? 'win-unpacked' : 'linux-unpacked');
const ASAR = path.join(UNPACKED_DIR, 'resources', 'app.asar');
const PACKAGED_EXECUTABLE = path.join(UNPACKED_DIR, IS_WINDOWS ? 'KYUTXO.exe' : 'kyutxo');
const CDP_PORT = Number(process.env.KYUTXO_PACKAGED_NETWORK_PRIVACY_CDP_PORT || 9227);
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

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) return true;
    } catch {
      // The packaged app may need several seconds to start.
    }
    await sleep(250);
  }
  return false;
}

async function waitForCdpDown(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) {
        await sleep(250);
        continue;
      }
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
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
    const requestResult = (request) => new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
      request.onsuccess = () => resolve(request.result);
    });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('KYUTXODatabase');
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = database.transaction(['networkPrivacyActivity', 'nodeSettings'], 'readonly');
    const activity = await requestResult(transaction.objectStore('networkPrivacyActivity').getAll());
    const settings = await requestResult(transaction.objectStore('nodeSettings').get('default'));
    database.close();
    return { activity, settings };
  });
}

async function seedActivityState(page, { settings, activity }) {
  await page.evaluate(async ({ settings, activity }) => {
    const requestResult = (request) => new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
      request.onsuccess = () => resolve(request.result);
    });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('KYUTXODatabase');
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = database.transaction(['networkPrivacyActivity', 'nodeSettings'], 'readwrite');
    transaction.objectStore('networkPrivacyActivity').clear();
    transaction.objectStore('nodeSettings').put(settings);
    for (const row of activity) transaction.objectStore('networkPrivacyActivity').add(row);
    await new Promise((resolve, reject) => {
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
      transaction.oncomplete = resolve;
    });
    database.close();
  }, { settings, activity });
}

async function appendCommittedActivity(page, activity) {
  await page.evaluate(async (activity) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('KYUTXODatabase');
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = database.transaction('networkPrivacyActivity', 'readwrite');
    transaction.objectStore('networkPrivacyActivity').add(activity);
    await new Promise((resolve, reject) => {
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
      transaction.oncomplete = resolve;
    });
    database.close();
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
  const portableLaunchDir = path.join(tempHome, 'portable-launch');
  const tempDir = path.join(tempHome, 'temp');
  fs.mkdirSync(portableLaunchDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const { PORTABLE_EXECUTABLE_DIR: _portableExecutableDir, ...inheritedEnv } = process.env;
  const env = {
    ...inheritedEnv,
    HOME: tempHome,
    XDG_CONFIG_HOME: path.join(tempHome, '.config'),
    XDG_CACHE_HOME: path.join(tempHome, '.cache'),
    XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(tempHome, '.local', 'state'),
    NODE_ENV: 'production',
  };
  if (IS_WINDOWS) {
    env.USERPROFILE = tempHome;
    env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
    env.TEMP = tempDir;
    env.TMP = tempDir;
  }

  let xvfb = null;
  let child = null;
  let browser = null;
  const display = process.env.KYUTXO_PACKAGED_DISPLAY || ':101';
  const launchExecutable = IS_WINDOWS
    ? path.join(portableLaunchDir, path.basename(
        path.join(RELEASE_DIR, `KYUTXO-${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version}-Portable.exe`),
      ))
    : electronBin;
  if (IS_WINDOWS) {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const portableArtifact = path.join(RELEASE_DIR, `KYUTXO-${version}-Portable.exe`);
    if (!fs.existsSync(portableArtifact)) {
      throw new Error(`${TAG} portable artifact is missing: ${portableArtifact}`);
    }
    fs.copyFileSync(portableArtifact, launchExecutable);
  } else {
    xvfb = spawn(xvfbBin, [display, '-screen', '0', '1280x800x24'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    xvfb.stderr.on('data', (data) => process.stdout.write(`${TAG}[xvfb] ${data}`));
    await sleep(2_000);
  }

  const launchArgs = IS_WINDOWS
    ? ['--disable-gpu', `--remote-debugging-port=${CDP_PORT}`]
    : [ASAR, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`];
  const launchPackagedProcess = () => {
    child = spawn(launchExecutable, launchArgs, {
      cwd: IS_WINDOWS ? portableLaunchDir : tempHome,
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
    if (!(await waitForCdp(90_000))) {
      throw new Error(`${TAG} packaged Electron CDP endpoint did not start`);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
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
    if (!(await waitForCdpDown(30_000))) {
      throw new Error(`${TAG} packaged Electron CDP endpoint stayed up after close`);
    }

    launchPackagedProcess();
    if (!(await waitForCdp(90_000))) {
      throw new Error(`${TAG} packaged Electron CDP endpoint did not return after reopen`);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
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
    await forceStopPackagedProcess(child);
    child = null;
    browser = null;
    if (!(await waitForCdpDown(30_000))) {
      throw new Error(`${TAG} packaged Electron CDP endpoint stayed up after forced termination`);
    }

    launchPackagedProcess();
    if (!(await waitForCdp(90_000))) {
      throw new Error(`${TAG} packaged Electron CDP endpoint did not return after forced termination`);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
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
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${TAG} FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});