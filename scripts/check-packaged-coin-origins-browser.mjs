#!/usr/bin/env node
// Packaged-desktop regression gate for Coin Origins wallet-scoped counts.
//
// The Coin Origins page has two related but intentionally different counts:
// acquisition lots are the known source lots, while holdings also include the
// synthetic UNKNOWN_ORIGIN_ID holding when an output has an unresolved input.
// This check launches the real packaged renderer, seeds both the native engine
// and its matching repository fingerprints, and verifies that the visible page
// uses the native getCoinOriginsPage response across the Electron bridge.
//
// Usage:
//   node scripts/check-packaged-coin-origins-browser.mjs
//   KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-coin-origins-browser.mjs

import { chromium } from 'playwright-core';
import { spawnSync, spawn } from 'node:child_process';
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
const TAG = '[packaged-coin-origins]';
const SETUP_PASSWORD = 'packaged-coin-origins-check';
const BUILD_COMMAND_TIMEOUT_MS = 15 * 60_000;
const TASKKILL_TIMEOUT_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', timeout: BUILD_COMMAND_TIMEOUT_MS });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    throw new Error(`${TAG} timed out during package build command ${command} after ${BUILD_COMMAND_TIMEOUT_MS}ms`);
  }
  if (result.status !== 0) throw new Error(`${TAG} command failed (exit ${result.status}): ${command}`);
}

function buildPackage() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) throw new Error(`${TAG} ${ASAR} is missing`);
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
    IS_WINDOWS ? '--win' : '--linux',
  ]);
  if (!fs.existsSync(ASAR)) throw new Error(`${TAG} packaging produced no ${ASAR}`);
}

function txid(prefix) {
  return `${prefix}${'0'.repeat(64 - prefix.length)}`;
}

const TX_ALPHA = txid('aa11aa11');
const TX_BETA = txid('bb22bb22');
const TX_MIXED = txid('cc33cc33');
const ALPHA_ADDRESS = 'bc1qpackagedoriginsalpha000000000000000';
const BETA_ADDRESS = 'bc1qpackagedoriginsbeta00000000000000';
const UNKNOWN_INPUT_ADDRESS = 'bc1qpackagedoriginsunknown00000000000';
const NATIVE_ALPHA_LABEL = 'Native engine Alpha acquisition';

function buildFixture() {
  const records = [
    {
      id: 1,
      type: 'address',
      inputString: ALPHA_ADDRESS,
      inputStringLower: ALPHA_ADDRESS,
      label: NATIVE_ALPHA_LABEL,
      walletName: 'Alpha wallet',
      addressImportance: 'manual',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 2,
      type: 'address',
      inputString: BETA_ADDRESS,
      inputStringLower: BETA_ADDRESS,
      label: 'Native engine Beta acquisition',
      walletName: 'Beta wallet',
      addressImportance: 'manual',
      createdAt: 2,
      updatedAt: 2,
    },
  ];
  const transactions = [
    { id: 1, txid: TX_ALPHA, blockHeight: 1, blockTime: 1_700_000_001, fee: 0 },
    { id: 2, txid: TX_BETA, blockHeight: 2, blockTime: 1_700_000_002, fee: 0 },
    { id: 3, txid: TX_MIXED, blockHeight: 3, blockTime: 1_700_000_003, fee: 0 },
  ];
  const transactionParticipants = [
    // Deterministic Alpha acquisition lot.
    { id: 1, txid: TX_ALPHA, role: 'output', address: ALPHA_ADDRESS, amount: 1_000, vout: 0, recordId: 1 },
    // Deterministic Beta acquisition lot.
    { id: 2, txid: TX_BETA, role: 'output', address: BETA_ADDRESS, amount: 2_000, vout: 0, recordId: 2 },
    // Alpha receives a mixed output: the known lot plus one unresolved input.
    { id: 3, txid: TX_MIXED, role: 'input', address: ALPHA_ADDRESS, amount: 1_000, prevTxid: TX_ALPHA, prevVout: 0, recordId: 1 },
    { id: 4, txid: TX_MIXED, role: 'input', address: UNKNOWN_INPUT_ADDRESS, amount: 500, prevTxid: txid('dd44dd44'), prevVout: 0 },
    { id: 5, txid: TX_MIXED, role: 'output', address: ALPHA_ADDRESS, amount: 1_500, vout: 0, recordId: 1 },
  ];
  return { records, transactions, transactionParticipants };
}

function buildDexieFixture(fixture) {
  return {
    records: fixture.records.map((record) => ({
      ...record,
      label: record.label.replace('Native engine', 'Dexie fallback'),
      tags: [],
      categories: [],
    })),
    transactions: fixture.transactions.map((transaction) => ({
      ...transaction,
      feeRate: 0,
      vsize: 100,
      syncedAt: 1,
      rawFingerprintCaptured: true,
    })),
    transactionParticipants: fixture.transactionParticipants.map((participant) => ({
      ...participant,
      amount: participant.amount,
      scriptType: 'v0_p2wpkh',
    })),
  };
}

async function waitForPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => candidate.url().startsWith('kyutxo-app://bundle/'));
      if (page) return page;
    }
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

function assert(condition, message) {
  if (!condition) throw new Error(`${TAG} ${message}`);
  console.log(`${TAG} PASS ${message}`);
}

async function seedRepository(page, fixture) {
  return page.evaluate(async (data) => {
    const repository = window.electronAPI?.protectedStore?.repository;
    if (!repository) throw new Error('protected repository bridge is unavailable');
    const save = async (collection, rows) => {
      const envelope = await repository.saveBatch(collection, rows);
      if (!envelope?.ok) throw new Error(`${collection} saveBatch: ${envelope?.error || 'missing response'}`);
    };
    await save('records', data.records);
    await save('blockchainTransactions', data.transactions);
    await save('transactionParticipants', data.transactionParticipants);
    return {
      kind: 'protected',
      records: data.records.length,
      transactions: data.transactions.length,
      participants: data.transactionParticipants.length,
    };
  }, fixture);
}

async function seedEngine(page, fixture) {
  return page.evaluate(async (data) => {
    const engine = window.electronAPI.engine;
    const unwrap = (envelope, label) => {
      if (!envelope?.ok) throw new Error(`${label}: ${envelope?.error || 'missing engine envelope'}`);
      return envelope.result;
    };
    unwrap(await engine.init(), 'init');
    unwrap(await engine.seedBegin(), 'seedBegin');
    unwrap(await engine.seedBatch('records', data.records), 'seed records');
    unwrap(await engine.seedBatch('blockchainTransactions', data.transactions), 'seed transactions');
    unwrap(await engine.seedBatch('transactionParticipants', data.transactionParticipants), 'seed participants');
    return unwrap(await engine.seedFinish({
      records: data.records.length,
      blockchainTransactions: data.transactions.length,
      transactionParticipants: data.transactionParticipants.length,
    }), 'seedFinish');
  }, fixture);
}

async function waitForCard(page, testId, expected) {
  await page.waitForFunction(
    ({ testId: id, value }) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() === value,
    { testId, value: expected },
    { timeout: 30_000 },
  );
}

async function readScope(page, expected) {
  await waitForCard(page, 'origin-lots', String(expected.lots));
  await waitForCard(page, 'origin-total', `${expected.current.toLocaleString('en-US')} sats`);
  await waitForCard(page, 'origin-unknown', `${expected.unknown.toLocaleString('en-US')} sats`);
  return {
    lots: (await page.getByTestId('origin-lots').innerText()).trim(),
    current: (await page.getByTestId('origin-total').innerText()).trim(),
    unknown: (await page.getByTestId('origin-unknown').innerText()).trim(),
    holdings: await page.locator('[data-testid^="origin-holding-"]').count(),
  };
}

async function selectWallet(page, name, expected) {
  await page.getByTestId('coin-origin-wallet').click();
  await page.getByRole('option', { name, exact: true }).click();
  return readScope(page, expected);
}

async function main() {
  buildPackage();
  const binaries = IS_WINDOWS ? { electronBin: null, xvfbBin: null } : findPackagedBinaries({ tag: TAG });
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-origins-'));
  const portableSetup = IS_WINDOWS ? prepareWindowsPortableLaunch({
    root: ROOT, asarPath: ASAR, home: tempHome, tag: TAG,
  }) : null;
  const cdpUserDataDir = IS_WINDOWS
    ? path.join(portableSetup.launchDir, 'KYUTXO_Data')
    : path.join(tempHome, 'cdp-profile');
  const display = `:${500 + (process.pid % 300)}`;
  let xvfb;
  let child;
  let browser;
  let cdpPort = null;

  try {
    if (!IS_WINDOWS) {
      xvfb = spawn(binaries.xvfbBin, [display, '-screen', '0', '1280x800x24'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      xvfb.stderr.on('data', (chunk) => process.stdout.write(`${TAG}[xvfb] ${chunk}`));
      await sleep(2_000);
    }

    const env = {
      ...(portableSetup?.env || process.env),
      HOME: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_CACHE_HOME: path.join(tempHome, '.cache'),
      XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
      APPDATA: tempHome,
      LOCALAPPDATA: tempHome,
      NODE_ENV: 'production',
    };
    let launchExecutable = PACKAGED_EXECUTABLE;
    if (IS_WINDOWS) {
      launchExecutable = portableSetup.executable;
      console.log(`${TAG} portable launch copy: ${launchExecutable}`);
    }

    child = spawn(launchExecutable, packagedCdpLaunchArgs(cdpUserDataDir), {
      cwd: IS_WINDOWS ? portableSetup.launchDir : tempHome,
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
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log(`${TAG}[renderer-${message.type()}] ${message.text().slice(0, 500)}`);
      }
    });
    page.on('pageerror', (error) => console.log(`${TAG}[renderer-error] ${String(error?.stack || error).slice(0, 800)}`));
    await page.waitForFunction(() => Boolean(window.electronAPI?.engine), null, { timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 60_000, submitTimeoutMs: 60_000, label: 'packaged-coin-origins' });
    await completeFreshVaultOnboardingIfPresent(page, { label: 'packaged-coin-origins' });

    const fixture = buildFixture();
    const dexieFixture = buildDexieFixture(fixture);
    const repositorySeed = await seedRepository(page, dexieFixture);
    assert(
      repositorySeed.records === 2 &&
        repositorySeed.transactions === 3 &&
        repositorySeed.participants === 5,
      'vault repository contains the two-wallet fixture for freshness and wallet options',
    );

    const seeded = await seedEngine(page, fixture);
    assert(seeded?.state === 'READY', 'native worker finalizes the two-wallet Coin Origins fixture');

    // Query through the real preload → main → worker bridge before rendering the
    // page. These independent responses are the expected card/row baselines.
    const bridgePages = await page.evaluate(async () => {
      const response = async (args) => {
        const envelope = await window.electronAPI.engine.query('getCoinOriginsPage', args);
        if (!envelope?.ok) throw new Error(envelope?.error || 'missing engine response');
        return envelope.result;
      };
      return {
        all: await response({ limit: 250 }),
        alpha: await response({ walletName: 'Alpha wallet', limit: 250 }),
        beta: await response({ walletName: 'Beta wallet', limit: 250 }),
      };
    });
    assert(
      bridgePages.all.lotsTotal === 2 &&
        bridgePages.all.holdingsTotal === 3 &&
        bridgePages.alpha.lotsTotal === 1 &&
        bridgePages.alpha.holdingsTotal === 2 &&
        bridgePages.beta.lotsTotal === 1 &&
        bridgePages.beta.holdingsTotal === 1,
      'native page response separates acquisition-lot totals from holding totals in each wallet scope',
    );
    assert(
      bridgePages.alpha.summary.unknownSats === 500 &&
        bridgePages.beta.summary.unknownSats === 0 &&
        bridgePages.all.summary.unknownSats === 500,
      'native page response keeps the unresolved allocation in Alpha and the entire-vault scope only',
    );

    // Navigate through the real app link so the deferred route boundary keeps
    // the authenticated renderer state and observes the lazy-route commit.
    await page.getByTestId('link-coin-origins').click();
    const routeOutcome = await Promise.race([
      page.getByTestId('coin-origins-page').waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'page'),
      page.getByTestId('route-navigation-error').waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'error'),
    ]);
    if (routeOutcome === 'error') {
      const diagnostic = await page.evaluate(() => ({
        href: window.location.href,
        body: document.body.innerText.slice(0, 2_000),
      }));
      throw new Error(`Coin Origins route failed: ${JSON.stringify(diagnostic)}`);
    }

    const allScope = await readScope(page, { lots: 2, current: 3_500, unknown: 500 });
    assert(
      allScope.holdings === 3 &&
        allScope.lots === '2' &&
        allScope.current === '3,500 sats' &&
        allScope.unknown === '500 sats',
      'entire-vault cards show two acquisition lots independently from three holdings including UNKNOWN',
    );
    assert(
      await page.getByText(NATIVE_ALPHA_LABEL, { exact: true }).count() > 0 &&
        await page.getByText(/Dexie fallback Alpha acquisition/, { exact: false }).count() === 0,
      'Coin Origins rendered the native engine page payload rather than the Dexie fallback',
    );

    const alphaScope = await selectWallet(page, 'Alpha wallet', { lots: 1, current: 1_500, unknown: 500 });
    assert(
      alphaScope.holdings === 2 &&
        alphaScope.lots === '1' &&
        alphaScope.current === '1,500 sats' &&
        alphaScope.unknown === '500 sats' &&
        await page.getByTestId('origin-holding-unknown').count() === 1,
      'Alpha wallet shows one acquisition lot separately from its known plus unresolved holdings',
    );

    const betaScope = await selectWallet(page, 'Beta wallet', { lots: 1, current: 2_000, unknown: 0 });
    assert(
      betaScope.holdings === 1 &&
        betaScope.lots === '1' &&
        betaScope.current === '2,000 sats' &&
        betaScope.unknown === '0 sats' &&
        await page.getByTestId('origin-holding-unknown').count() === 0,
      'Beta wallet shows its independent acquisition lot and no unresolved holding',
    );

    console.log(`${TAG} all packaged Coin Origins wallet-scope checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    killTree(child);
    if (cdpPort !== null && !(await waitForPackagedCdpDown(cdpPort, 30_000))) {
      throw new Error(`${TAG} packaged process still owns CDP port ${cdpPort} after shutdown`);
    }
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