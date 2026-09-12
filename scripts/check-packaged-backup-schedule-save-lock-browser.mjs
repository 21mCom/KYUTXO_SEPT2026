#!/usr/bin/env node
// Packaged Electron regression check for a folder picker that resolves after a
// schedule save. The main-process test seam holds the real IPC result until a
// marker exists; the renderer must ignore that stale result.

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { completeFreshVaultOnboardingIfPresent } from './browser-check-utils.mjs';
import {
  assertPackagedAsarFresh,
  assertPackagedBundleFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import { packagedCdpLaunchArgs, waitForOwnedPackagedCdp } from './packaged-cdp.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';
import {
  packagedCdpLaunchArgs,
  waitForOwnedPackagedCdp,
} from './packaged-cdp.mjs';

await acquireBrowserCheckLock();

const ROOT = repoRootFromModuleUrl(import.meta.url);
const ASAR = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');
const TAG = '[backup-schedule-late-picker-packaged]';
const PASSWORD = 'backup-schedule-late-picker-check';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${TAG} command failed (${result.status}): ${command}`);
}

function buildPackage() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) throw new Error(`${TAG} packaged asar does not exist: ${ASAR}`);
    assertPackagedBundleFresh({ tag: TAG });
    assertPackagedAsarFresh({ tag: TAG, asarPath: ASAR });
    return;
  }
  run('npm', ['run', 'build']);
  assertPackagedBundleFresh({ tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', ['electron-builder', '--config', 'electron-builder.json', '--dir', '--linux', '-c.npmRebuild=false']);
  if (!fs.existsSync(ASAR)) throw new Error(`${TAG} electron-builder did not produce ${ASAR}`);
}

async function findPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => candidate.url().startsWith('kyutxo-app://bundle/'));
      if (page) return page;
    }
    await sleep(500);
  }
  throw new Error(`${TAG} packaged renderer did not appear`);
}

function stop(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
}

async function createFreshVault(page) {
  const password = page.getByTestId('input-password');
  const confirmation = page.getByTestId('input-confirm-password');
  await confirmation.waitFor({ state: 'visible', timeout: 60_000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await password.fill(PASSWORD);
    await confirmation.fill(PASSWORD);
    await sleep(500);
    if (
      await password.inputValue() === PASSWORD &&
      await confirmation.inputValue() === PASSWORD
    ) {
      await page.getByTestId('button-submit').click();
      if (await password.waitFor({ state: 'detached', timeout: 30_000 }).then(() => true).catch(() => false)) return;
    }
    await sleep(1_000);
  }
  const state = await page.evaluate(() => ({
    error: document.querySelector('[data-testid="text-error"]')?.textContent ?? null,
    submit: document.querySelector('[data-testid="button-submit"]')?.textContent ?? null,
    body: document.body?.innerText.slice(0, 500) ?? null,
  }));
  throw new Error(`${TAG} fresh vault setup never completed: ${JSON.stringify(state)}`);
}

async function main() {
  buildPackage();
  const { xvfbBin } = findPackagedBinaries({ tag: TAG });
  const packagedAppBin = path.resolve(
    ROOT,
    process.env.KYUTXO_PACKAGED_APP_BIN || 'release/linux-unpacked/kyutxo',
  );
  if (!fs.existsSync(packagedAppBin)) {
    throw new Error(`${TAG} packaged executable does not exist: ${packagedAppBin}`);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-backup-picker-check-'));
  const cdpUserDataDir = path.join(home, 'cdp-profile');
  const selectedDirectory = path.join(home, 'late-backup-folder');
  const releaseMarker = path.join(home, 'release-picker');
  const cdpUserDataDir = path.join(home, 'cdp-profile');
  fs.mkdirSync(selectedDirectory, { recursive: true });
  fs.writeFileSync(releaseMarker, 'release initial picker');
  const display = process.env.KYUTXO_PACKAGED_DISPLAY || ':113';
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    NODE_ENV: 'production',
    KYUTXO_BACKUP_FOLDER_PICKER_TEST: '1',
    KYUTXO_BACKUP_FOLDER_PICKER_TEST_DIRECTORY: selectedDirectory,
    KYUTXO_BACKUP_FOLDER_PICKER_TEST_RELEASE: releaseMarker,
  };
  let xvfb;
  let child;
  let browser;
  try {
    xvfb = spawn(xvfbBin, [display, '-screen', '0', '1280x800x24'], {
      env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await sleep(2_000);
    child = spawn(packagedAppBin, [
      '--no-sandbox', '--disable-gpu', '--in-process-gpu',
      '--disable-gpu-compositing', '--disable-software-rasterizer',
      ...packagedCdpLaunchArgs(cdpUserDataDir),
    ], {
      cwd: home, env: { ...env, DISPLAY: display }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => process.stdout.write(`${TAG}[app] ${data}`));
    child.stderr.on('data', (data) => process.stdout.write(`${TAG}[app-err] ${data}`));
    const cdp = await waitForOwnedPackagedCdp({
      userDataDir: cdpUserDataDir,
      timeoutMs: 90_000,
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    const page = await findPage(browser);
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log(`${TAG}[console-${message.type()}] ${message.text().slice(0, 300)}`);
      }
    });
    page.on('pageerror', (error) => console.log(`${TAG}[pageerror] ${error.message}`));

    await createFreshVault(page);
    await completeFreshVaultOnboardingIfPresent(page, { label: TAG });
    await page.evaluate(() => { window.location.hash = '/settings'; });
    await page.getByTestId('backup-schedule-section').waitFor({ state: 'visible', timeout: 60_000 });

    // Establish one saved destination through the real packaged IPC handler.
    await page.getByTestId('button-add-backup-folder').click();
    await page.getByText(selectedDirectory).waitFor();
    await page.getByTestId('button-save-backup-schedule').click();
    await page.getByText('Backup schedule saved').first().waitFor();

    // Hold the next picker in the main process, save another field, then release
    // the stale picker result only after persistence has completed.
    fs.rmSync(releaseMarker, { force: true });
    await page.getByTestId('button-add-backup-folder').click();
    await page.getByTestId('input-backup-retention').fill('12');
    await page.getByTestId('button-save-backup-schedule').click();
    await page.getByText('Backup schedule saved').first().waitFor();
    fs.writeFileSync(releaseMarker, 'release late picker');
    await sleep(1_000);

    assert.equal(await page.getByText(selectedDirectory).count(), 1, 'late picker changed rendered destinations');
    await page.evaluate(() => { window.location.hash = '/'; });
    await page.getByTestId('backup-schedule-section').waitFor({ state: 'detached' });
    await page.evaluate(() => { window.location.hash = '/settings'; });
    await page.getByTestId('backup-schedule-section').waitFor({ state: 'visible' });
    assert.equal(
      await page.getByTestId('input-backup-retention').inputValue(),
      '12',
      'save did not persist before picker release',
    );
    assert.equal(await page.getByText(selectedDirectory).count(), 1, 'late picker changed persisted destinations');
    console.log('PASS: packaged desktop ignores a folder picker result released after schedule save');
  } finally {
    await browser?.close().catch(() => {});
    stop(child);
    stop(xvfb);
    await sleep(1_000);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${TAG} fatal:`, error);
  process.exit(1);
});