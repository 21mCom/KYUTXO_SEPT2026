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

await acquireBrowserCheckLock();

const ROOT = repoRootFromModuleUrl(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const RELEASE_DIR = path.join(ROOT, 'release');
const UNPACKED_DIR = path.join(RELEASE_DIR, IS_WINDOWS ? 'win-unpacked' : 'linux-unpacked');
const ASAR = path.join(UNPACKED_DIR, 'resources', 'app.asar');
const CDP_PORT = Number(process.env.KYUTXO_PACKAGED_FORGOTTEN_SOURCE_CDP_PORT || 9231);
const TAG = '[packaged-forgotten-network-source]';
const PASSWORD = 'PackagedForgottenSource#2026';
const CUSTOM_URL = 'https://node.forgotten-source.test';
const TOR_PROXY = 'socks5h://127.0.0.1:19050';
const ELECTRUM_HOST = 'electrum.forgotten-source.test';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  if (spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
    throw new Error(`${TAG} command failed: ${command}`);
  }
}

function buildPackage() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} is missing`);
    assertPackagedBundleFresh({ root: ROOT, tag: TAG });
    assertPackagedAsarFresh({ root: ROOT, asarPath: ASAR, tag: TAG });
    if (IS_WINDOWS) findPortableArtifact();
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
  if (IS_WINDOWS) findPortableArtifact();
}

function findPortableArtifact() {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const expected = path.join(RELEASE_DIR, `KYUTXO-${version}-Portable.exe`);
  if (fs.existsSync(expected) && fs.statSync(expected).size > 0) {
    if (fs.statSync(expected).mtimeMs + 1_000 < fs.statSync(ASAR).mtimeMs) {
      throw new Error(`${TAG} portable artifact predates the validated app.asar: ${expected}`);
    }
    return expected;
  }
  const candidates = fs.existsSync(RELEASE_DIR)
    ? fs.readdirSync(RELEASE_DIR).filter((name) => /^KYUTXO-.+-Portable\.exe$/i.test(name))
    : [];
  throw new Error(
    `${TAG} generated portable artifact is missing or empty: ${expected}; ` +
      `portable candidates found: ${candidates.join(', ') || 'none'}`,
  );
}

async function cdpIsUp() {
  try {
    return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function waitForCdp(expectedUp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cdpIsUp()) === expectedUp) return;
    await sleep(250);
  }
  throw new Error(`${TAG} CDP endpoint did not become ${expectedUp ? 'available' : 'unavailable'}`);
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

async function stop(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { cwd: ROOT, stdio: 'inherit' });
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
  const portableLaunchDir = path.join(home, 'portable-launch');
  const tempDir = path.join(home, 'temp');
  fs.mkdirSync(portableLaunchDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const { PORTABLE_EXECUTABLE_DIR: _portable, ...inheritedEnv } = process.env;
  const env = {
    ...inheritedEnv, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), NODE_ENV: 'production',
    KYUTXO_PROVIDER_TEST_PROBE: '1',
  };
  if (IS_WINDOWS) Object.assign(env, {
    USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TEMP: tempDir, TMP: tempDir,
  });
  const display = process.env.KYUTXO_PACKAGED_DISPLAY || ':102';
  let xvfb;
  let child;
  let browser;
  const executable = IS_WINDOWS
    ? path.join(portableLaunchDir, path.basename(findPortableArtifact()))
    : electronBin;
  if (IS_WINDOWS) fs.copyFileSync(findPortableArtifact(), executable);
  const launch = () => {
    const args = IS_WINDOWS
      ? ['--disable-gpu', `--remote-debugging-port=${CDP_PORT}`]
      : [ASAR, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`];
    child = spawn(executable, args, {
      cwd: IS_WINDOWS ? portableLaunchDir : home,
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
    await waitForCdp(true, 90_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    let page = await rendererPage(browser);
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, label: 'packaged-forgotten-source-setup' });
    await completeFreshVaultOnboardingIfPresent(page, { label: 'packaged-forgotten-source-setup' });
    await page.goto('kyutxo-app://bundle/#/node-settings');
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
    await page.getByTestId('button-enable-selected-source').click();
    await page.getByText('Settings Saved').first().waitFor();
    await page.getByTestId('button-forget-network-source').click();
    await page.getByTestId('dialog-forget-network-source').waitFor({ state: 'visible' });
    await page.getByTestId('button-confirm-forget-network-source').click();
    await page.getByText('Network Source Forgotten').first().waitFor();

    await browser.close();
    browser = null;
    await stop(child);
    child = null;
    await waitForCdp(false, 30_000);
    launch();
    await waitForCdp(true, 90_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    page = await rendererPage(browser);
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, label: 'packaged-forgotten-source-reopen' });
    await page.getByTestId('network-onboarding-source').waitFor({ state: 'visible' });
    await page.getByText('Choose before KYUTXO connects').waitFor();

    const consent = await page.evaluate(async () => {
      const { getNodeSettings } = await import('/src/lib/data/node-settings-crud.ts');
      const settings = await getNodeSettings('default');
      return [settings?.networkPrivacyMode, settings?.networkAccessEnabled, settings?.networkOnboardingStage];
    });
    assert.deepEqual(consent, [undefined, false, 'source'], 'forgotten source consent did not survive desktop restart');
    await page.getByTestId('choice-network-offline').click();
    await page.getByTestId('network-onboarding-import').waitFor({ state: 'visible' });
    await page.getByTestId('button-onboarding-finish').click();
    await page.goto('kyutxo-app://bundle/#/node-settings');
    await page.getByText('No network source configured').first().waitFor();
    await page.getByTestId('text-network-privacy-state').getByText('Offline').waitFor();

    for (const [id, expected] of [
      ['input-custom-url', CUSTOM_URL], ['input-tor-proxy', TOR_PROXY],
      ['input-electrum-host', ELECTRUM_HOST], ['input-electrum-port', '50002'],
    ]) assert.equal(await page.getByTestId(id).inputValue(), expected, `${id} was not retained`);
    const retained = await page.evaluate(async () => {
      const { getNodeSettings } = await import('/src/lib/data/node-settings-crud.ts');
      const settings = await getNodeSettings('default');
      return {
        provider: settings?.provider,
        useTor: settings?.useTor,
        useElectrum: settings?.useElectrum,
        electrumSSL: settings?.electrumSSL,
        electrumServerType: settings?.electrumServerType,
      };
    });
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
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${TAG} FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});