#!/usr/bin/env node
// Release gate for the protected desktop vault's "Forget network source" path.
// Unlike the browser equivalent, this deliberately drives a real packaged
// Electron profile through a process restart.

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';
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
const TAG = '[packaged-forgotten-network-source]';
const PASSWORD = 'PackagedForgottenSource#2026';
const CUSTOM_URL = 'https://node.forgotten-source.test';
const TOR_PROXY = 'socks5h://127.0.0.1:19050';
const ELECTRUM_HOST = 'electrum.forgotten-source.test';
const BUILD_COMMAND_TIMEOUT_MS = 15 * 60_000;
const TASKKILL_TIMEOUT_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', timeout: BUILD_COMMAND_TIMEOUT_MS });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    throw new Error(`${TAG} timed out during package build command ${command} after ${BUILD_COMMAND_TIMEOUT_MS}ms`);
  }
  if (result.status !== 0) {
    throw new Error(`${TAG} command failed: ${command}`);
  }
}

function buildPackage() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} is missing`);
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
    ...(IS_WINDOWS ? ['--win'] : ['--dir', '--linux', '-c.npmRebuild=false']),
  ]);
  if (!fs.existsSync(ASAR)) throw new Error(`${TAG} packaging produced no ${ASAR}`);
}

async function rendererPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => candidate.url().startsWith('kyutxo-app://bundle/'));
      if (page) return page;
    }
    await sleep(250);
  }
  throw new Error(`${TAG} packaged renderer did not appear`);
}

async function navigateToNodeSettings(page) {
  await page.evaluate(() => {
    window.location.hash = '/node-settings';
  });
  await page.getByRole('heading', { name: 'Node Connection' }).waitFor({ state: 'visible' });
}

async function readProtectedNodeSettings(page) {
  return page.evaluate(async () => {
    const repository = window.electronAPI?.protectedStore?.repository;
    if (!repository) throw new Error('Protected repository bridge is unavailable');
    const envelope = await repository.find('nodeSettings', 'default');
    if (!envelope?.ok || envelope.result === undefined) {
      throw new Error(envelope?.error || 'Protected repository operation failed');
    }
    return envelope.result;
  });
}

async function completeFreshVaultOnboardingWithSource(page) {
  const sourceStep = page.getByTestId('network-onboarding-source');
  const appeared = await sourceStep
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await page.evaluate(async () => {
      const repository = window.electronAPI?.protectedStore?.repository;
      if (!repository) throw new Error('Protected repository bridge is unavailable');
      const current = await repository.find('nodeSettings', 'default');
      if (!current?.ok || current.result === undefined) {
        throw new Error(current?.error || 'Protected repository read failed');
      }
      const saved = await repository.save('nodeSettings', {
        ...current.result,
        networkPrivacyMode: undefined,
        networkAccessEnabled: false,
        networkOnboardingStage: 'source',
      });
      if (!saved?.ok || saved.result === undefined) {
        throw new Error(saved?.error || 'Protected repository write failed');
      }
      await window.electronAPI.protectedStore.lock();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await unlockIfNeeded(page, PASSWORD, {
      appearTimeoutMs: 60_000,
      label: 'packaged-forgotten-source-seeded-onboarding',
    });
  }
  await sourceStep.waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByTestId('choice-network-own-node').click();
  await page.getByTestId('input-onboarding-node-url').fill(CUSTOM_URL);
  await page.getByTestId('button-save-network-choice').click();
  await page.getByTestId('network-onboarding-import').waitFor({ state: 'visible' });
  await page.getByTestId('button-onboarding-finish').click();
  await sourceStep.waitFor({ state: 'detached' });
}

async function stop(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      cwd: ROOT, stdio: 'inherit', timeout: TASKKILL_TIMEOUT_MS,
    });
    return;
  }
  try { child.kill('SIGTERM'); } catch {}
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

async function main() {
  buildPackage();
  let electronBin;
  let xvfbBin;
  if (!IS_WINDOWS) ({ electronBin, xvfbBin } = findPackagedBinaries({ tag: TAG }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-forgotten-source-'));
  const portableSetup = IS_WINDOWS ? prepareWindowsPortableLaunch({
    root: ROOT, asarPath: ASAR, home, tag: TAG,
  }) : null;
  const cdpUserDataDir = IS_WINDOWS
    ? path.join(portableSetup.launchDir, 'KYUTXO_Data')
    : path.join(home, 'cdp-profile');
  const env = {
    ...(portableSetup?.env || process.env), HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), NODE_ENV: 'production',
    KYUTXO_PROVIDER_TEST_PROBE: '1',
  };
  const display = process.env.KYUTXO_PACKAGED_DISPLAY || ':102';
  let xvfb;
  let child;
  let browser;
  const executable = IS_WINDOWS ? portableSetup.executable : electronBin;
  const launch = () => {
    const args = IS_WINDOWS
      ? ['--disable-gpu', ...packagedCdpLaunchArgs(cdpUserDataDir)]
      : [ASAR, '--no-sandbox', '--disable-gpu', ...packagedCdpLaunchArgs(cdpUserDataDir)];
    child = spawn(executable, args, {
      cwd: IS_WINDOWS ? portableSetup.launchDir : home,
      env: IS_WINDOWS ? env : { ...env, DISPLAY: display },
      detached: !IS_WINDOWS, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (data) => process.stdout.write(`${TAG}[app] ${data}`));
  };
  try {
    if (!IS_WINDOWS) {
      xvfb = spawn(xvfbBin, [display, '-screen', '0', '1280x800x24'], {
        env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      await sleep(2_000);
    }
    launch();
    let cdp = await waitForOwnedPackagedCdp({ userDataDir: cdpUserDataDir, timeoutMs: 90_000 });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    let page = await rendererPage(browser);
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, label: 'packaged-forgotten-source-setup' });
    await completeFreshVaultOnboardingWithSource(page);
    await navigateToNodeSettings(page);
    await page.getByTestId('radio-provider-custom-electrs').click();
    await page.getByTestId('input-custom-url').fill(CUSTOM_URL);
    await page.getByTestId('switch-use-tor').click();
    await page.getByTestId('input-tor-proxy').fill(TOR_PROXY);
    await page.getByTestId('switch-use-electrum').click();
    await page.getByTestId('input-electrum-host').fill(ELECTRUM_HOST);
    await page.getByTestId('radio-fulcrum').click();
    assert.equal(
      await page.evaluate(() => window.electronAPI.providerTestProbe.count()),
      0,
      'packaged provider test IPC ran before the source was first explicitly enabled',
    );
    await page.getByTestId('button-save-settings').click();
    await page.getByText('Settings Saved').first().waitFor();
    await page.getByTestId('button-forget-network-source').click();
    await page.getByTestId('dialog-forget-network-source').waitFor({ state: 'visible' });
    await page.getByTestId('button-confirm-forget-network-source').click();
    await page.getByText('Network Source Forgotten').first().waitFor();

    await browser.close();
    browser = null;
    await stop(child);
    child = null;
    if (!(await waitForPackagedCdpDown(cdp.port, 30_000))) {
      throw new Error(`${TAG} CDP endpoint did not become unavailable`);
    }
    clearPackagedCdpOwnership(cdpUserDataDir);
    launch();
    cdp = await waitForOwnedPackagedCdp({ userDataDir: cdpUserDataDir, timeoutMs: 90_000 });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    page = await rendererPage(browser);
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, label: 'packaged-forgotten-source-reopen' });
    await page.getByText('Choose before KYUTXO connects').waitFor();

    const reopenedSettings = await readProtectedNodeSettings(page);
    const consent = [
      reopenedSettings?.networkPrivacyMode,
      reopenedSettings?.networkAccessEnabled,
      reopenedSettings?.networkOnboardingStage,
    ];
    assert.deepEqual(consent, [undefined, false, 'source'], 'forgotten source consent did not survive desktop restart');
    assert.equal(
      await completeFreshVaultOnboardingIfPresent(page, { label: 'packaged-forgotten-source-reopen' }),
      true,
      'forgotten source onboarding did not appear after desktop restart',
    );
    await navigateToNodeSettings(page);
    await page.getByText('No network source configured').first().waitFor();
    await page.getByTestId('text-network-privacy-state').getByText('Offline').waitFor();

    for (const [id, expected] of [
      ['input-custom-url', CUSTOM_URL], ['input-tor-proxy', TOR_PROXY],
      ['input-electrum-host', ELECTRUM_HOST], ['input-electrum-port', '50002'],
    ]) assert.equal(await page.getByTestId(id).inputValue(), expected, `${id} was not retained`);
    const retainedSettings = await readProtectedNodeSettings(page);
    const retained = {
      provider: retainedSettings?.provider,
      useTor: retainedSettings?.useTor,
      useElectrum: retainedSettings?.useElectrum,
      electrumSSL: retainedSettings?.electrumSSL,
      electrumServerType: retainedSettings?.electrumServerType,
    };
    assert.deepEqual(retained, {
      provider: 'custom-electrs',
      useTor: true,
      useElectrum: true,
      electrumSSL: true,
      electrumServerType: 'fulcrum',
    }, 'retained desktop provider details changed after Forget and restart');

    // The actual preload bridge supplies this opt-in, process-local counter.
    // It observes test IPC after the renderer has loaded and does not replace
    // the bridge or network implementation under test.
    const beforeTestClicks = await page.evaluate(() => window.electronAPI.providerTestProbe.count());
    assert.equal(
      beforeTestClicks,
      0,
      'packaged provider test IPC ran before the user explicitly enabled a source',
    );
    for (const id of ['button-test-connection', 'button-test-tor', 'button-test-electrum']) {
      const button = page.getByTestId(id);
      await button.waitFor({ state: 'visible' });
      assert.equal(await button.isEnabled(), false, `${id} is enabled before source activation`);
      await button.dispatchEvent('click');
    }
    await sleep(500);
    const providerCalls = await page.evaluate(() => window.electronAPI.providerTestProbe.calls());
    assert.equal(
      providerCalls.length,
      beforeTestClicks,
      `disabled controls invoked packaged provider IPC: ${providerCalls.join(', ')}`,
    );
    console.log(`${TAG} protected-vault restart, retained settings, offline consent, and disabled-provider checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    await stop(child);
    try { process.kill(-xvfb?.pid, 'SIGTERM'); } catch { xvfb?.kill?.('SIGTERM'); }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(`${TAG} FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});