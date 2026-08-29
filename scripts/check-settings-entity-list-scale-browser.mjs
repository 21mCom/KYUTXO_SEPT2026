#!/usr/bin/env node
// Real-browser check for the large Privacy Audit entity-list import flow.
//
// The Settings entity-list suites cover the preview math, diff controls, and
// confirmation behavior in Vitest. This check covers what jsdom cannot: a
// large import rendered by the real @tanstack/react-virtual list in Chromium.
// It:
//   1. creates/unlocks a fresh vault and opens Settings
//   2. imports 1,200 deterministic, checksum-valid Bitcoin addresses
//   3. verifies the exact replace-mode summary and that the first render is
//      virtualized rather than mounting all 1,200 rows
//   4. scrolls the Added and Removed lists to their deep ends and confirms the
//      last rows render
//   5. exercises the search and category controls after scrolling
//   6. confirms the import and verifies the completion state and stored count
//
// Usage: node scripts/check-settings-entity-list-scale-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import * as bitcoin from 'bitcoinjs-lib';
import ecc from '@bitcoinerlab/secp256k1';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel checks share port 5000 and system
// resources. Keep the lock for the whole check, including server startup.
await acquireBrowserCheckLock();

bitcoin.initEccLib(ecc);

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETTINGS_URL = `${BASE_URL}settings`;
const SETUP_PASSWORD = 'entity-list-scale-check-123';
const IMPORT_COUNT = 1_200;
const CATEGORIES = [
  'exchange',
  'payment-service',
  'gambling',
  'scam',
  'darknet',
  'mining-pool',
  'mixer',
  'p2p-exchange',
];

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.',
    );
  }
}

async function isServerUp(url) {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function launchWithRetry(executablePath, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
      }
    }
  }
  throw lastError;
}

function scalarFor(index) {
  const scalar = new Uint8Array(32);
  let value = index + 1;
  for (let byte = scalar.length - 1; byte >= 0; byte -= 1) {
    scalar[byte] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return scalar;
}

function makeImportedEntries(count) {
  return Array.from({ length: count }, (_, index) => {
    const pubkey = ecc.pointFromScalar(scalarFor(index), true);
    if (!pubkey) throw new Error(`Could not derive test public key ${index}`);
    const address = bitcoin.payments.p2wpkh({
      pubkey,
      network: bitcoin.networks.bitcoin,
    }).address;
    if (!address) throw new Error(`Could not derive test address ${index}`);
    return {
      address,
      name: `Large import entity ${String(index).padStart(4, '0')}`,
      category: CATEGORIES[index % CATEGORIES.length],
    };
  });
}

function numericText(value) {
  return Number((value ?? '').replace(/[^0-9]/g, ''));
}

async function waitUntil(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not become true${lastError ? `: ${lastError.message}` : ''}`);
}

async function main() {
  let devProc = null;
  let browser = null;
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed: Boolean(passed), detail: detail ?? '' });
  };

  try {
    if (!(await isServerUp(BASE_URL))) {
      console.log('[settings-entity-list-scale-browser] starting dev server ...');
      devProc = spawn('npm', ['run', 'dev'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
        detached: true,
      });
      if (!(await waitForServer(BASE_URL, 120_000))) {
        throw new Error(`Dev server did not become ready at ${BASE_URL} within 120s.`);
      }
    } else {
      console.log(`[settings-entity-list-scale-browser] reusing dev server at ${BASE_URL}`);
    }

    browser = await launchWithRetry(resolveChromium());
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (error) =>
      console.log(`[settings-entity-list-scale-browser] pageerror: ${error.message}`),
    );

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 90_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 15_000,
      label: 'settings-entity-list-scale',
    });

    await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 90_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 15_000,
      label: 'settings-entity-list-scale',
    });
    const importButton = page.getByTestId('button-import-entities');
    await importButton.waitFor({ state: 'visible', timeout: 60_000 });

    const bundledCount = await page.evaluate(async () => {
      const { getBundledEntityCount } = await import('/src/lib/privacy-entity-list.ts');
      return getBundledEntityCount();
    });
    const entries = makeImportedEntries(IMPORT_COUNT);
    const uniqueAddresses = new Set(entries.map((entry) => entry.address)).size;
    record(
      `generated ${IMPORT_COUNT.toLocaleString()} unique valid import entries`,
      entries.length === IMPORT_COUNT && uniqueAddresses === IMPORT_COUNT,
      `entries=${entries.length}, uniqueAddresses=${uniqueAddresses}`,
    );

    await page.getByTestId('input-entity-file').setInputFiles({
      name: 'large-entity-list.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(entries)),
    });
    await page.getByTestId('text-preview-incoming').waitFor({
      state: 'visible',
      timeout: 60_000,
    });

    const incomingText = await page.getByTestId('text-preview-incoming').textContent();
    const currentText = await page.getByTestId('text-preview-current').textContent();
    const addedText = await page.getByTestId('badge-preview-added').textContent();
    const removedText = await page.getByTestId('badge-preview-removed').textContent();
    const changedText = await page.getByTestId('badge-preview-changed').textContent();
    const unchangedText = await page.getByTestId('badge-preview-unchanged').textContent();
    record(
      'replace preview shows the expected large-import summary',
      numericText(incomingText) === IMPORT_COUNT &&
        numericText(currentText) === bundledCount &&
        addedText?.includes(`+${IMPORT_COUNT.toLocaleString()} added`) &&
        removedText?.includes(`−${bundledCount.toLocaleString()} removed`) &&
        changedText?.includes('0 changed') &&
        unchangedText?.includes('0 unchanged'),
      JSON.stringify({
        incomingText,
        currentText,
        bundledCount,
        addedText,
        removedText,
        changedText,
        unchangedText,
      }),
    );

    await page.getByTestId('button-toggle-entity-diff').click();
    const addedList = page.getByTestId('list-entity-diff-added');
    await addedList.waitFor({ state: 'visible', timeout: 30_000 });
    const initialAddedState = await addedList.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      renderedRows: element.querySelectorAll('[data-testid^="row-entity-diff-added-"]').length,
    }));
    record(
      'large Added diff is scrollable and virtualized',
      initialAddedState.scrollHeight > initialAddedState.clientHeight &&
        initialAddedState.renderedRows > 0 &&
        initialAddedState.renderedRows < IMPORT_COUNT,
      JSON.stringify(initialAddedState),
    );

    await addedList.evaluate((element) => {
      element.scrollTop = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.getByTestId('row-entity-diff-added-600').waitFor({
      state: 'attached',
      timeout: 30_000,
    });
    record('Added diff remains responsive at its midpoint', true, 'row 600 rendered');

    await addedList.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const addedLastRow = page.getByTestId(`row-entity-diff-added-${IMPORT_COUNT - 1}`);
    await addedLastRow.waitFor({ state: 'attached', timeout: 30_000 });
    const addedLastName = await page
      .getByTestId(`text-entity-diff-name-added-${IMPORT_COUNT - 1}`)
      .textContent();
    record(
      'deep-scrolling Added reaches the final imported row',
      addedLastName === `Large import entity ${String(IMPORT_COUNT - 1).padStart(4, '0')}`,
      `lastName=${JSON.stringify(addedLastName)}`,
    );

    const search = page.getByTestId('input-entity-diff-search');
    await search.fill(`Large import entity ${IMPORT_COUNT - 1}`);
    const addedTab = page.getByTestId('tab-entity-diff-added');
    await waitUntil('search-filtered Added tab count', async () =>
      (await addedTab.textContent())?.includes('Added (1)'),
    );
    const filteredName = await page.getByTestId('text-entity-diff-name-added-0').textContent();
    record(
      'search control filters the large diff after scrolling',
      filteredName === `Large import entity ${String(IMPORT_COUNT - 1).padStart(4, '0')}`,
      `filteredName=${JSON.stringify(filteredName)}`,
    );

    await search.fill('');
    await page.getByTestId('select-entity-diff-category').click();
    await page.getByTestId('option-entity-diff-category-mixer').click();
    await waitUntil('category-filtered Added tab count', async () =>
      (await addedTab.textContent())?.includes('Added (150)'),
    );
    record(
      'category control filters the large diff',
      (await addedTab.textContent())?.includes('Added (150)'),
      await addedTab.textContent(),
    );

    await page.getByTestId('select-entity-diff-category').click();
    await page.getByTestId('option-entity-diff-category-all').click();
    await waitUntil('reset category filter', async () =>
      (await addedTab.textContent())?.includes(`Added (${IMPORT_COUNT.toLocaleString()})`),
    );

    await page.getByTestId('tab-entity-diff-removed').click();
    const removedList = page.getByTestId('list-entity-diff-removed');
    await removedList.waitFor({ state: 'visible', timeout: 30_000 });
    const initialRemovedState = await removedList.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      renderedRows: element.querySelectorAll('[data-testid^="row-entity-diff-removed-"]').length,
    }));
    record(
      'large Removed diff is scrollable and virtualized',
      initialRemovedState.scrollHeight > initialRemovedState.clientHeight &&
        initialRemovedState.renderedRows > 0 &&
        initialRemovedState.renderedRows < bundledCount,
      JSON.stringify(initialRemovedState),
    );

    await removedList.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const removedLastRow = page.getByTestId(`row-entity-diff-removed-${bundledCount - 1}`);
    await removedLastRow.waitFor({ state: 'attached', timeout: 30_000 });
    record(
      'deep-scrolling Removed reaches the final current-list row',
      (await removedLastRow.count()) === 1,
      `row-entity-diff-removed-${bundledCount - 1} rendered`,
    );

    await page.getByTestId('button-confirm-entity-import').click();
    await page.getByTestId('text-preview-incoming').waitFor({
      state: 'detached',
      timeout: 60_000,
    });
    await waitUntil('Settings import completion state', async () => {
      const badge = await page.getByTestId('badge-entity-source').textContent();
      const count = await page.getByTestId('text-entity-count').textContent();
      return badge?.includes('Imported') && numericText(count) === IMPORT_COUNT;
    });
    const importedBadge = await page.getByTestId('badge-entity-source').textContent();
    const activeCountText = await page.getByTestId('text-entity-count').textContent();
    const storedState = await page.evaluate(async () => {
      const { getSettings } = await import('/src/lib/data/settings-crud.ts');
      const { getActiveEntityList, getActiveEntitySource } = await import(
        '/src/lib/privacy-entity-list.ts'
      );
      const settings = await getSettings('default');
      return {
        activeCount: getActiveEntityList().length,
        activeSource: getActiveEntitySource(),
        snapshotMode: settings?.entityListSnapshot?.mode ?? null,
        snapshotEntries: settings?.entityListSnapshot?.entries.length ?? 0,
      };
    });
    record(
      'confirm closes the dialog and completes the large import',
      importedBadge?.includes('Imported') &&
        numericText(activeCountText) === IMPORT_COUNT &&
        storedState.activeCount === IMPORT_COUNT &&
        storedState.activeSource === 'imported' &&
        storedState.snapshotMode === 'replace' &&
        storedState.snapshotEntries === IMPORT_COUNT,
      JSON.stringify({ importedBadge, activeCountText, storedState }),
    );

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          // Best-effort cleanup for a server this script started.
        }
      }
    }
  }

  const failed = steps.filter((step) => !step.passed);
  console.log(`[settings-entity-list-scale-browser] checks=${steps.length} failed=${failed.length}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} browser check(s) failed`);
  }
  console.log(
    '[settings-entity-list-scale-browser] PASSED: large entity-list imports remain virtualized, interactive while scrolling, and complete with the expected summary.',
  );
}

main().catch((error) => {
  console.error(
    '[settings-entity-list-scale-browser] ERROR:',
    error && error.stack ? error.stack : error,
  );
  process.exit(1);
});