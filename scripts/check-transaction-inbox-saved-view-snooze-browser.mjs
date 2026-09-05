#!/usr/bin/env node
// Real-browser regression guard for the Transaction Inbox saved-view and
// snooze controls.
//
// This drives the actual /transaction-inbox page in Chromium:
//   1. creates a fresh vault and seeds two new, annotated transaction rows;
//   2. uses the real Radix date/amount filter popover and saves a named view;
//   3. changes the search and amount filters, saves the same name again, and
//      verifies that the existing view is updated rather than duplicated;
//   4. creates and deletes a second view, exports a password-encrypted real
//      backup, and injects stale local view state;
//   5. attempts the real Settings restore with a wrong password and proves the
//      stale live view plus both transactions remain byte-for-byte unchanged;
//   6. retries with the correct password and verifies the restored view has the
//      updated filters exactly once, the
//      deleted view is absent, and both underlying transactions remain intact;
//   7. builds a representative encrypted legacy backup, injects stale live
//      settings/transaction state, and proves a wrong password cannot open the
//      confirmation stage or mutate either table;
//   8. retries the legacy restore with the correct password and verifies the
//      backed-up settings and transactions replace the stale live state;
//   9. reloads, unlocks again, selects the restored view, and verifies that its
//      tab, search, date, and amount filters are restored;
//  10. snoozes one row with the one-week preset and the other with the native
//      custom date input, then verifies the persisted state/timestamps.
//
// Everything runs offline against local IndexedDB.
//
// Usage: node scripts/check-transaction-inbox-saved-view-snooze-browser.mjs
// Requires: a `chromium` binary on PATH and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}transaction-inbox`;
const SETUP_PASSWORD = 'transaction-inbox-check-123';
const BACKUP_PASSWORD = 'transaction-inbox-backup-456';
const WRONG_BACKUP_PASSWORD = 'transaction-inbox-backup-wrong';
const LEGACY_BACKUP_PASSWORD = 'transaction-inbox-legacy-backup-789';
const WRONG_LEGACY_BACKUP_PASSWORD = 'transaction-inbox-legacy-backup-wrong';
const VIEW_NAME = 'Inbox review today';
const DELETED_VIEW_NAME = 'Deleted before backup';

// The shared "24" prefix makes the saved search match both rows while the
// first eight characters remain different, so each TransactionCard has a
// unique test id.
const TX_PRESET = '24'.repeat(32);
const TX_CUSTOM = '24' + '25'.repeat(31);
const ADDR_PRESET = 'bc1qinboxpreset' + 'a'.repeat(27);
const ADDR_CUSTOM = 'bc1qinboxcustom' + 'b'.repeat(27);
const PRESET_SATS = 50_000_000; // 0.5 BTC
const CUSTOM_SATS = 75_000_000; // 0.75 BTC
const SNOOZE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CUSTOM_DATE = '2099-12-31';
const LEGACY_PBKDF2_ITERATIONS = 100_000;

async function buildEncryptedLegacyBackup(data, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await webcrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: LEGACY_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(data)),
    ),
  );
  const encrypted = new Uint8Array(iv.length + ciphertext.length);
  encrypted.set(iv);
  encrypted.set(ciphertext, iv.length);

  const zip = new JSZip();
  zip.file('backup.json', JSON.stringify({
    encrypted: true,
    exportDate: new Date().toISOString(),
    salt: Buffer.from(salt).toString('base64'),
    data: Buffer.from(encrypted).toString('base64'),
  }));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

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
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function launchWithRetry(exe) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      console.log(
        `[transaction-inbox-browser] chromium launch attempt ${attempt} failed, retrying: ${error.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

// Dispatching avoids Playwright actionability polling against portal-rendered
// Radix controls. The event still goes through the production React handler.
async function clickEl(page, testId) {
  const element = page.getByTestId(testId);
  await element.waitFor({ state: 'visible', timeout: 15_000 });
  await element.dispatchEvent('click');
}

async function activateTab(page, testId) {
  const element = page.getByTestId(testId);
  await element.waitFor({ state: 'attached', timeout: 15_000 });
  await element.dispatchEvent('mousedown');
  await element.dispatchEvent('click');
}

async function setInputValue(page, testId, value) {
  const element = page.getByTestId(testId);
  await element.waitFor({ state: 'attached', timeout: 15_000 });
  await element.evaluate((node, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(node, nextValue);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateLabel(date) {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Select a real react-day-picker date, navigating by its accessible month
 * buttons so this remains correct at month and year boundaries.
 */
async function pickCalendarDate(page, triggerTestId, targetKey) {
  const [year, month, day] = targetKey.split('-').map(Number);
  const targetMonth = new Date(year, month - 1, 1);
  const expectedCaption = targetMonth.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  await clickEl(page, triggerTestId);
  for (let attempt = 0; attempt < 24; attempt++) {
    const calendar = page.locator('[id^="react-day-picker-"]:visible').first();
    await calendar.waitFor({ state: 'visible', timeout: 2000 });
    const caption = ((await calendar.textContent()) ?? '').trim();
    if (caption === expectedCaption) {
      const targetDay = page
        .locator('button[name="day"]:not(.day-outside):visible')
        .filter({ hasText: new RegExp(`^${day}$`) })
        .first();
      await targetDay.waitFor({ state: 'visible', timeout: 2000 });
      await targetDay.dispatchEvent('click');
      return;
    }

    const displayedMonth = new Date(`${caption} 1`);
    const direction = targetMonth < displayedMonth ? 'previous' : 'next';
    const navigation = page.getByRole('button', {
      name: `Go to ${direction} month`,
    });
    await navigation.waitFor({ state: 'visible', timeout: 2000 });
    await navigation.dispatchEvent('click');
    await page.waitForTimeout(50);
  }
  throw new Error(`Could not find calendar date ${targetKey} (${expectedCaption}).`);
}

async function waitForCuration(page, txid, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await page.evaluate(async (id) => {
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      return txCrud.getTransactionCurationState(id);
    }, txid);
    if (predicate(state)) return state;
    await page.waitForTimeout(300);
  }
  return state;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[transaction-inbox-browser] chromium: ${exe}`);

  let devProc = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[transaction-inbox-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[transaction-inbox-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[transaction-inbox-browser] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  const today = new Date();
  const todayKey = dateKey(today);
  const todayLabel = dateLabel(today);
  const blockTime = Math.floor(new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    12,
  ).getTime() / 1000);

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 2200 },
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.log(`[transaction-inbox-browser][page-console] ${message.text()}`);
      }
    });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      dismissMigration: false,
    });
    if (await completeFreshVaultOnboardingIfPresent(page, {
      label: 'transaction-inbox-browser',
    })) {
      await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
      await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    }
    await page.getByTestId('transaction-curation-inbox').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    record('vault', true, 'fresh vault created/unlocked and Transaction Inbox opened');

    // Use live Vite module singletons so this writes to the same Dexie
    // database instance that the page queries.
    const seed = await page.evaluate(
      async ({ txPreset, txCustom, addrPreset, addrCustom, block, presetSats, customSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        await txCrud.bulkAddTransactions([
          {
            txid: txPreset,
            blockHeight: 900_001,
            blockTime: block,
            fee: 500,
            feeRate: 2,
            syncedAt: Date.now(),
            curationState: 'new',
          },
          {
            txid: txCustom,
            blockHeight: 900_002,
            blockTime: block,
            fee: 600,
            feeRate: 2,
            syncedAt: Date.now(),
            curationState: 'new',
          },
        ]);
        await txCrud.bulkAddParticipants([
          { txid: txPreset, role: 'output', address: addrPreset, amount: presetSats, vout: 0 },
          { txid: txCustom, role: 'output', address: addrCustom, amount: customSats, vout: 0 },
        ]);
        // Transaction records make the saved search human-readable and also
        // exercise the inbox's real record lookup while cards render.
        await recordCrud.createRecord({
          type: 'transaction',
          inputString: txPreset,
          label: 'Inbox preset review',
          tags: [],
          categories: [],
        });
        await recordCrud.createRecord({
          type: 'transaction',
          inputString: txCustom,
          label: 'Inbox custom review',
          tags: [],
          categories: [],
        });
        return {
          transactionCount: await txCrud.countTransactions(),
          preset: await txCrud.getTransactionByTxid(txPreset),
          custom: await txCrud.getTransactionByTxid(txCustom),
        };
      },
      {
        txPreset: TX_PRESET,
        txCustom: TX_CUSTOM,
        addrPreset: ADDR_PRESET,
        addrCustom: ADDR_CUSTOM,
        block: blockTime,
        presetSats: PRESET_SATS,
        customSats: CUSTOM_SATS,
      },
    );
    record(
      'seed',
      seed.transactionCount === 2 &&
        seed.preset?.curationState === 'new' &&
        seed.custom?.curationState === 'new',
      `seeded ${seed.transactionCount} new transactions with outputs ${PRESET_SATS} and ${CUSTOM_SATS} sats`,
    );

    // Let the clean page mount see the seeded rows and avoid a race with the
    // initial live query's empty result.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    await page.getByTestId(`button-inbox-snooze-${TX_PRESET}`).waitFor({
      state: 'visible',
      timeout: 30_000,
    });

    // ── Save a named view through the real filters UI ───────────────────────
    await clickEl(page, 'button-advanced-filters');
    await page.getByTestId('tab-date-exact').waitFor({ state: 'visible' });
    await activateTab(page, 'tab-date-exact');
    await pickCalendarDate(page, 'button-date-exact', todayKey);
    await activateTab(page, 'tab-amount-range');
    await setInputValue(page, 'input-amount-min', '0.4');
    await setInputValue(page, 'input-amount-max', '0.8');
    await clickEl(page, 'button-apply-filters');
    await page.getByTestId('tab-amount-any').waitFor({
      state: 'detached',
      timeout: 10_000,
    }).catch(() => {});

    await setInputValue(page, 'input-inbox-search', '24');
    await page.getByTestId('input-inbox-view-name').fill(VIEW_NAME);
    await clickEl(page, 'button-inbox-save-view');

    const saved = await page.evaluate(async (name) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      const views = Array.isArray(settings?.savedInboxViews) ? settings.savedInboxViews : [];
      const view = views.find((candidate) => candidate.name === name);
      return view
        ? {
            id: view.id,
            tab: view.tab,
            search: view.search,
            filters: view.filters,
            createdAt: view.createdAt,
            createdAtType: typeof view.createdAt,
          }
        : undefined;
    }, VIEW_NAME);
    const savedHasToday = saved?.filters?.dateExact?.startsWith(todayKey) ?? false;
    record(
      'save-view',
      !!saved &&
        saved.tab === 'new' &&
        saved.search === '24' &&
        saved.filters?.dateMode === 'exact' &&
        savedHasToday &&
        saved.filters?.amountMode === 'range' &&
        saved.filters?.amountMinBtc === 0.4 &&
        saved.filters?.amountMaxBtc === 0.8 &&
        saved.createdAtType === 'number',
      `persisted tab=${saved?.tab} search=${JSON.stringify(saved?.search)} date=${saved?.filters?.dateExact} amount=${saved?.filters?.amountMinBtc}-${saved?.filters?.amountMaxBtc}`,
    );

    // Change two persisted filter values and save the exact same name. This
    // exercises the case-insensitive update-in-place path rather than creating
    // a duplicate saved view.
    await clickEl(page, 'button-advanced-filters');
    await activateTab(page, 'tab-amount-range');
    await setInputValue(page, 'input-amount-min', '0.45');
    await setInputValue(page, 'input-amount-max', '0.8');
    await clickEl(page, 'button-apply-filters');
    await setInputValue(page, 'input-inbox-search', 'Inbox');
    await page.getByTestId('input-inbox-view-name').fill(VIEW_NAME);
    await clickEl(page, 'button-inbox-save-view');

    const updated = await page.evaluate(async (name) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      const views = Array.isArray(settings?.savedInboxViews) ? settings.savedInboxViews : [];
      const matching = views.filter((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      const view = matching[0];
      return view
        ? {
            count: views.length,
            matchingCount: matching.length,
            id: view.id,
            search: view.search,
            filters: view.filters,
            createdAt: view.createdAt,
          }
        : { count: views.length, matchingCount: matching.length };
    }, VIEW_NAME);
    record(
      'update-view-in-place',
      updated.count === 1 &&
        updated.matchingCount === 1 &&
        updated.id === saved?.id &&
        updated.createdAt === saved?.createdAt &&
        updated.search === 'Inbox' &&
        updated.filters?.dateMode === 'exact' &&
        updated.filters?.amountMode === 'range' &&
        updated.filters?.amountMinBtc === 0.45 &&
        updated.filters?.amountMaxBtc === 0.8,
      `views=${updated.count} matching=${updated.matchingCount} id=${updated.id} search=${JSON.stringify(updated.search)} amount=${updated.filters?.amountMinBtc}-${updated.filters?.amountMaxBtc}`,
    );

    // Create a second view and delete it before the backup. The stale local
    // state injected below contains this deleted view, so a restore that
    // merges or resurrects local settings instead of applying the backup
    // snapshot will fail the post-restore assertion.
    await page.getByTestId('input-inbox-view-name').fill(DELETED_VIEW_NAME);
    await clickEl(page, 'button-inbox-save-view');
    await page.getByTestId('select-inbox-saved-view').selectOption({ label: DELETED_VIEW_NAME });
    await clickEl(page, 'button-inbox-delete-view');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="select-inbox-saved-view"]')?.value === '',
      null,
      { timeout: 10_000 },
    );
    const beforeBackupViews = await page.evaluate(async ({ viewName, deletedViewName }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      const views = Array.isArray(settings?.savedInboxViews) ? settings.savedInboxViews : [];
      return {
        viewCount: views.length,
        updatedCount: views.filter((view) => view.name.toLowerCase() === viewName.toLowerCase()).length,
        deletedCount: views.filter((view) => view.name.toLowerCase() === deletedViewName.toLowerCase()).length,
      };
    }, { viewName: VIEW_NAME, deletedViewName: DELETED_VIEW_NAME });
    record(
      'delete-view-before-backup',
      beforeBackupViews.viewCount === 1 &&
        beforeBackupViews.updatedCount === 1 &&
        beforeBackupViews.deletedCount === 0,
      `views=${beforeBackupViews.viewCount} updated=${beforeBackupViews.updatedCount} deleted=${beforeBackupViews.deletedCount}`,
    );

    // Export the exact live settings through the production backup pipeline.
    // Returning base64 keeps the ZIP bytes transportable across Playwright's
    // page boundary and lets the same script feed them to the real restore
    // file input below.
    const backupB64 = await page.evaluate(async (password) => {
      const { exportBackup } = await import('/src/lib/backup/export.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');
      const sink = new MemorySink();
      await exportBackup({
        sink,
        encrypted: true,
        password,
        batchSize: 25,
        attachmentIO: {
          async listAll() { return []; },
          async read() { return null; },
        },
      });
      const bytes = new Uint8Array(await sink.blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, BACKUP_PASSWORD);
    record(
      'backup-export',
      backupB64.length > 100,
      `password-encrypted v3 backup bytes=${Math.round(backupB64.length * 0.75)}`,
    );

    // Make the current vault disagree with the exported snapshot. Replace
    // restore must remove the deleted view and replace the old filters with
    // the updated view from the backup, rather than preserving these rows.
    await page.evaluate(async ({ oldView, deletedViewName }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      await settingsCrud.updateSettings('default', {
        savedInboxViews: [
          oldView,
          {
            id: 'stale-deleted-view',
            name: deletedViewName,
            tab: 'ignored',
            search: 'stale',
            filters: { dateMode: 'any', amountMode: 'any' },
            createdAt: 2,
          },
        ],
      }, { skipNotification: true });
    }, {
      oldView: saved,
      deletedViewName: DELETED_VIEW_NAME,
    });

    const beforeWrongPassword = await page.evaluate(async ({ txPreset, txCustom }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      const transactions = await Promise.all([
        txCrud.getTransactionByTxid(txPreset),
        txCrud.getTransactionByTxid(txCustom),
      ]);
      return {
        savedInboxViews: settings?.savedInboxViews,
        transactionCount: await txCrud.countTransactions(),
        transactions,
      };
    }, { txPreset: TX_PRESET, txCustom: TX_CUSTOM });

    // Drive the actual replace restore dialog, not just restoreSettingsPreferences
    // in a module test. This is the fresh-vault backup boundary under test.
    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    const openRestore = page.getByTestId('button-open-restore');
    await openRestore.scrollIntoViewIfNeeded();
    await openRestore.click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'transaction-inbox-check-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(backupB64, 'base64'),
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    const restorePassword = page.getByTestId('input-restore-password');
    await restorePassword.waitFor({ state: 'visible', timeout: 10_000 });
    const continueRestore = page.getByTestId('button-continue-restore');
    record(
      'encrypted-restore-password-required',
      await continueRestore.isDisabled(),
      'Continue is disabled until the backup password is entered',
    );
    await page.getByTestId('radio-replace').click();

    // The configure-stage preview decrypts the encrypted inline settings before
    // restoreV3Backup can reach its destructive clear. Prove that a wrong
    // password stays on this stage and leaves both portable preferences and
    // unrelated transaction rows exactly as they were.
    await restorePassword.fill(WRONG_BACKUP_PASSWORD);
    await continueRestore.click();
    await page.getByText('Could not read backup', { exact: true }).first().waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    const confirmPreviewAfterWrongPassword = await page
      .getByTestId('restore-preferences-preview')
      .isVisible()
      .catch(() => false);
    const afterWrongPassword = await page.evaluate(async ({ txPreset, txCustom }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      const transactions = await Promise.all([
        txCrud.getTransactionByTxid(txPreset),
        txCrud.getTransactionByTxid(txCustom),
      ]);
      return {
        savedInboxViews: settings?.savedInboxViews,
        transactionCount: await txCrud.countTransactions(),
        transactions,
      };
    }, { txPreset: TX_PRESET, txCustom: TX_CUSTOM });
    record(
      'wrong-password-non-destructive',
      !confirmPreviewAfterWrongPassword &&
        JSON.stringify(afterWrongPassword.savedInboxViews) ===
          JSON.stringify(beforeWrongPassword.savedInboxViews) &&
        afterWrongPassword.transactionCount === beforeWrongPassword.transactionCount &&
        JSON.stringify(afterWrongPassword.transactions) ===
          JSON.stringify(beforeWrongPassword.transactions),
      `preview=${confirmPreviewAfterWrongPassword} viewsUnchanged=${
        JSON.stringify(afterWrongPassword.savedInboxViews) ===
        JSON.stringify(beforeWrongPassword.savedInboxViews)
      } txCount=${afterWrongPassword.transactionCount} transactionsUnchanged=${
        JSON.stringify(afterWrongPassword.transactions) ===
        JSON.stringify(beforeWrongPassword.transactions)
      }`,
    );

    await restorePassword.fill(BACKUP_PASSWORD);
    await continueRestore.click();
    await page.getByTestId('restore-preferences-preview').waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    await page.getByTestId('button-confirm-restore').click();
    await page.getByText('Restore Successful', { exact: false }).first().waitFor({
      state: 'visible',
      timeout: 120_000,
    });

    const afterBackupRestore = await page.evaluate(async ({ txPreset, txCustom, viewName, deletedViewName }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      const views = Array.isArray(settings?.savedInboxViews) ? settings.savedInboxViews : [];
      const matching = views.filter((view) => view.name.toLowerCase() === viewName.toLowerCase());
      const deleted = views.filter((view) => view.name.toLowerCase() === deletedViewName.toLowerCase());
      const transactions = await Promise.all([
        txCrud.getTransactionByTxid(txPreset),
        txCrud.getTransactionByTxid(txCustom),
      ]);
      return {
        viewCount: views.length,
        matching,
        deletedCount: deleted.length,
        transactionCount: await txCrud.countTransactions(),
        transactionIds: transactions.map((transaction) => transaction?.txid),
        transactionHeights: transactions.map((transaction) => transaction?.blockHeight),
        transactionStates: transactions.map((transaction) => transaction?.curationState),
      };
    }, {
      txPreset: TX_PRESET,
      txCustom: TX_CUSTOM,
      viewName: VIEW_NAME,
      deletedViewName: DELETED_VIEW_NAME,
    });
    const restoredBackupView = afterBackupRestore.matching[0];
    record(
      'restore-backup-view-snapshot',
      afterBackupRestore.viewCount === 1 &&
        afterBackupRestore.matching.length === 1 &&
        afterBackupRestore.deletedCount === 0 &&
        restoredBackupView?.search === 'Inbox' &&
        restoredBackupView?.filters?.dateMode === 'exact' &&
        restoredBackupView?.filters?.amountMode === 'range' &&
        restoredBackupView?.filters?.amountMinBtc === 0.45 &&
        restoredBackupView?.filters?.amountMaxBtc === 0.8 &&
        afterBackupRestore.transactionCount === 2 &&
        JSON.stringify(afterBackupRestore.transactionIds) === JSON.stringify([TX_PRESET, TX_CUSTOM]) &&
        JSON.stringify(afterBackupRestore.transactionHeights) === JSON.stringify([900_001, 900_002]) &&
        JSON.stringify(afterBackupRestore.transactionStates) === JSON.stringify(['new', 'new']),
      `views=${afterBackupRestore.viewCount} matching=${afterBackupRestore.matching.length} deleted=${afterBackupRestore.deletedCount} txCount=${afterBackupRestore.transactionCount} txids=${afterBackupRestore.transactionIds.join(',')}`,
    );

    // Build a representative PRE-v3 backup: one encrypted backup.json carrying
    // portable settings, records, transactions, and participants. Constructing
    // the ZIP in Node avoids relying on a test-only browser seam; the Settings
    // flow reads and decrypts these bytes through the production legacy path.
    const legacyData = await page.evaluate(async () => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      return {
        records: await recordCrud.getAllRecords(),
        tags: [],
        categories: [],
        attachments: [],
        recordOrigins: [],
        customFields: [],
        owners: [],
        walletNames: [],
        seedNames: [],
        walletSoftware: [],
        derivationTemplates: [],
        evidence: [],
        evidenceAttachments: [],
        priceData: [],
        settings: settings ? [settings] : [],
        nodeSettings: [],
        utxoLineage: [],
        custodySegments: [],
        lineageSnapshots: [],
        blockchainTransactions: await txCrud.getAllTransactions(),
        transactionParticipants: await txCrud.getAllTransactionParticipants(),
        addressSyncState: [],
        dustFlags: [],
      };
    });
    const legacyBackup = await buildEncryptedLegacyBackup(
      legacyData,
      LEGACY_BACKUP_PASSWORD,
    );
    record(
      'legacy-backup-build',
      legacyBackup.length > 100 &&
        legacyData.settings.length === 1 &&
        legacyData.blockchainTransactions.length === 2,
      `encrypted legacy bytes=${legacyBackup.length} settings=${legacyData.settings.length} transactions=${legacyData.blockchainTransactions.length}`,
    );

    // Make the live vault visibly different from the legacy snapshot. A wrong
    // password must preserve this exact state; a correct replace restore must
    // remove it and recover the two backed-up transactions and saved view.
    await page.evaluate(async ({ deletedViewName }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      await settingsCrud.updateSettings('default', {
        savedInboxViews: [{
          id: 'legacy-stale-view',
          name: deletedViewName,
          tab: 'ignored',
          search: 'legacy stale',
          filters: { dateMode: 'any', amountMode: 'any' },
          createdAt: 3,
        }],
      }, { skipNotification: true });
      await txCrud.clearParticipants({ skipNotification: true });
      await txCrud.clearTransactions({ skipNotification: true });
      await txCrud.bulkAddTransactions([{
        txid: 'ff'.repeat(32),
        blockHeight: 999_999,
        blockTime: 1_700_000_000,
        fee: 1,
        feeRate: 1,
        syncedAt: Date.now(),
        curationState: 'ignored',
      }]);
    }, { deletedViewName: DELETED_VIEW_NAME });
    const beforeLegacyWrongPassword = await page.evaluate(async () => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      return {
        savedInboxViews: (await settingsCrud.getSettings('default'))?.savedInboxViews,
        transactions: await txCrud.getAllTransactions(),
      };
    });

    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    const openLegacyRestore = page.getByTestId('button-open-restore');
    await openLegacyRestore.scrollIntoViewIfNeeded();
    await openLegacyRestore.click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'transaction-inbox-check-legacy.zip',
      mimeType: 'application/zip',
      buffer: legacyBackup,
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    await page.getByTestId('radio-replace').click();
    const legacyRestorePassword = page.getByTestId('input-restore-password');
    const continueLegacyRestore = page.getByTestId('button-continue-restore');
    await legacyRestorePassword.fill(WRONG_LEGACY_BACKUP_PASSWORD);
    await continueLegacyRestore.click();
    await page.getByText('Could not read backup', { exact: true }).first().waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    const legacyConfirmAfterWrongPassword = await page
      .getByTestId('restore-preferences-preview')
      .isVisible()
      .catch(() => false);
    const afterLegacyWrongPassword = await page.evaluate(async () => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      return {
        savedInboxViews: (await settingsCrud.getSettings('default'))?.savedInboxViews,
        transactions: await txCrud.getAllTransactions(),
      };
    });
    record(
      'legacy-wrong-password-non-destructive',
      !legacyConfirmAfterWrongPassword &&
        JSON.stringify(afterLegacyWrongPassword) ===
          JSON.stringify(beforeLegacyWrongPassword),
      `preview=${legacyConfirmAfterWrongPassword} settingsAndTransactionsUnchanged=${
        JSON.stringify(afterLegacyWrongPassword) ===
        JSON.stringify(beforeLegacyWrongPassword)
      }`,
    );

    await legacyRestorePassword.fill(LEGACY_BACKUP_PASSWORD);
    await continueLegacyRestore.click();
    await page.getByTestId('restore-preferences-preview').waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    await page.getByTestId('button-confirm-restore').click();
    await page.getByText('Restore Successful', { exact: false }).first().waitFor({
      state: 'visible',
      timeout: 120_000,
    });
    const afterLegacyRestore = await page.evaluate(async ({ txPreset, txCustom, viewName }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const views = (await settingsCrud.getSettings('default'))?.savedInboxViews ?? [];
      const transactions = await txCrud.getAllTransactions();
      return {
        matchingViews: views.filter((view) => view.name === viewName),
        transactionIds: transactions.map((transaction) => transaction.txid).sort(),
        staleTransactionCount: transactions.filter(
          (transaction) => transaction.txid === 'ff'.repeat(32),
        ).length,
        expectedTransactionsPresent:
          transactions.some((transaction) => transaction.txid === txPreset) &&
          transactions.some((transaction) => transaction.txid === txCustom),
      };
    }, { txPreset: TX_PRESET, txCustom: TX_CUSTOM, viewName: VIEW_NAME });
    record(
      'legacy-correct-password-restore',
      afterLegacyRestore.matchingViews.length === 1 &&
        afterLegacyRestore.transactionIds.length === 2 &&
        afterLegacyRestore.staleTransactionCount === 0 &&
        afterLegacyRestore.expectedTransactionsPresent,
      `views=${afterLegacyRestore.matchingViews.length} txids=${afterLegacyRestore.transactionIds.join(',')} stale=${afterLegacyRestore.staleTransactionCount}`,
    );

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    await page.getByTestId('transaction-curation-inbox').waitFor({
      state: 'visible',
      timeout: 30_000,
    });

    // Change away from the saved state before reload so selecting the saved
    // view proves the tab itself is restored, not merely retained in memory.
    await activateTab(page, 'tab-inbox-ignored');
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    await page.getByTestId('transaction-curation-inbox').waitFor({
      state: 'visible',
      timeout: 30_000,
    });

    await page.getByTestId('select-inbox-saved-view').selectOption({ label: VIEW_NAME });
    await page.getByTestId(`button-inbox-snooze-${TX_PRESET}`).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    const restoredTab = await page
      .getByTestId('tab-inbox-new')
      .getAttribute('data-state');
    const restoredSearch = await page.getByTestId('input-inbox-search').inputValue();
    const restoredSavedId = await page.getByTestId('select-inbox-saved-view').inputValue();
    const restoredDateChip = await page
      .getByTestId('button-clear-date-filter')
      .locator('xpath=..')
      .textContent();
    const restoredAmountChip = await page
      .getByTestId('button-clear-amount-filter')
      .locator('xpath=..')
      .textContent();

    await clickEl(page, 'button-advanced-filters');
    const restoredDateButton = await page.getByTestId('button-date-exact').textContent();
    const restoredAmountMin = await page.getByTestId('input-amount-min').inputValue();
    const restoredAmountMax = await page.getByTestId('input-amount-max').inputValue();
    await clickEl(page, 'button-apply-filters');

    record(
      'restore-view',
      restoredSavedId !== '' &&
        restoredTab === 'active' &&
        restoredSearch === 'Inbox' &&
        restoredDateChip?.includes(todayLabel) &&
        restoredAmountChip?.includes('0.45 BTC') &&
        restoredAmountChip?.includes('0.8 BTC') &&
        restoredDateButton?.includes(todayLabel) &&
        restoredAmountMin === '0.45' &&
        restoredAmountMax === '0.8',
      `selected=${restoredSavedId} tab=${restoredTab} search=${JSON.stringify(restoredSearch)} date=${JSON.stringify(restoredDateButton)} amount=${restoredAmountMin}-${restoredAmountMax}`,
    );

    const beforeDelete = await page.evaluate(async ({ txPreset, txCustom }) => {
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const transactions = await Promise.all([
        txCrud.getTransactionByTxid(txPreset),
        txCrud.getTransactionByTxid(txCustom),
      ]);
      return {
        count: await txCrud.countTransactions(),
        transactions: transactions.map((transaction) => transaction && ({
          id: transaction.id,
          txid: transaction.txid,
          blockHeight: transaction.blockHeight,
          blockTime: transaction.blockTime,
          curationState: transaction.curationState,
          snoozedUntil: transaction.snoozedUntil,
          curationUpdatedAt: transaction.curationUpdatedAt,
        })),
      };
    }, { txPreset: TX_PRESET, txCustom: TX_CUSTOM });

    // Delete the selected view, then prove both the in-memory selection and
    // persisted settings are cleared. The transaction snapshot makes this
    // guard fail if view maintenance accidentally touches transaction data.
    await clickEl(page, 'button-inbox-delete-view');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="select-inbox-saved-view"]')?.value === '',
      null,
      { timeout: 10_000 },
    );
    const afterDelete = await page.evaluate(async ({ name, txPreset, txCustom }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      const transactions = await Promise.all([
        txCrud.getTransactionByTxid(txPreset),
        txCrud.getTransactionByTxid(txCustom),
      ]);
      const views = Array.isArray(settings?.savedInboxViews) ? settings.savedInboxViews : [];
      return {
        views: views.filter((candidate) => candidate.name.toLowerCase() === name.toLowerCase()),
        count: await txCrud.countTransactions(),
        transactions: transactions.map((transaction) => transaction && ({
          id: transaction.id,
          txid: transaction.txid,
          blockHeight: transaction.blockHeight,
          blockTime: transaction.blockTime,
          curationState: transaction.curationState,
          snoozedUntil: transaction.snoozedUntil,
          curationUpdatedAt: transaction.curationUpdatedAt,
        })),
      };
    }, { name: VIEW_NAME, txPreset: TX_PRESET, txCustom: TX_CUSTOM });
    record(
      'delete-view-preserves-transactions',
      afterDelete.views.length === 0 &&
        afterDelete.count === beforeDelete.count &&
        JSON.stringify(afterDelete.transactions) === JSON.stringify(beforeDelete.transactions),
      `remainingViews=${afterDelete.views.length} transactionCount=${afterDelete.count} unchanged=${JSON.stringify(afterDelete.transactions) === JSON.stringify(beforeDelete.transactions)}`,
    );

    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    await page.getByTestId('transaction-curation-inbox').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await page.waitForFunction(
      (name) => !Array.from(
        document.querySelector('[data-testid="select-inbox-saved-view"]')?.options ?? [],
      ).some((option) => option.textContent === name),
      VIEW_NAME,
      { timeout: 10_000 },
    );
    const afterReload = await page.evaluate(async ({ name, txPreset, txCustom }) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      const transactions = await Promise.all([
        txCrud.getTransactionByTxid(txPreset),
        txCrud.getTransactionByTxid(txCustom),
      ]);
      const views = Array.isArray(settings?.savedInboxViews) ? settings.savedInboxViews : [];
      return {
        viewCount: views.filter((candidate) => candidate.name.toLowerCase() === name.toLowerCase()).length,
        count: await txCrud.countTransactions(),
        transactionIds: transactions.map((transaction) => transaction?.id),
      };
    }, { name: VIEW_NAME, txPreset: TX_PRESET, txCustom: TX_CUSTOM });
    record(
      'delete-view-persists-after-reload',
      afterReload.viewCount === 0 &&
        afterReload.count === beforeDelete.count &&
        afterReload.transactionIds.every((id) => typeof id === 'number'),
      `matchingViews=${afterReload.viewCount} transactionCount=${afterReload.count} transactionIds=${afterReload.transactionIds.join('/')}`,
    );

    // ── Preset snooze: one-week path through the real Radix popover ─────────
    const presetBefore = Date.now();
    await clickEl(page, `button-inbox-snooze-${TX_PRESET}`);
    await clickEl(page, `button-inbox-snooze-${TX_PRESET}-week`);
    const presetState = await waitForCuration(
      page,
      TX_PRESET,
      (state) => state?.curationState === 'snoozed' && typeof state.snoozedUntil === 'number',
    );
    const presetTimestampOk =
      typeof presetState?.snoozedUntil === 'number' &&
      presetState.snoozedUntil >= presetBefore + SNOOZE_WEEK_MS - 5000 &&
      presetState.snoozedUntil <= Date.now() + SNOOZE_WEEK_MS + 5000;
    record(
      'preset-snooze',
      presetState?.curationState === 'snoozed' &&
        typeof presetState.curationUpdatedAt === 'number' &&
        presetState.curationUpdatedAt >= presetBefore &&
        presetTimestampOk,
      `state=${presetState?.curationState} snoozedUntil=${presetState?.snoozedUntil} updatedAt=${presetState?.curationUpdatedAt}`,
    );

    // ── Custom snooze: native date input path ───────────────────────────────
    await page.getByTestId(`button-inbox-snooze-${TX_CUSTOM}`).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    const customBefore = Date.now();
    await clickEl(page, `button-inbox-snooze-${TX_CUSTOM}`);
    const customDateInput = page.getByTestId(`button-inbox-snooze-${TX_CUSTOM}-date`);
    await customDateInput.fill(CUSTOM_DATE);
    await clickEl(page, `button-inbox-snooze-${TX_CUSTOM}-custom`);
    const customState = await waitForCuration(
      page,
      TX_CUSTOM,
      (state) => state?.curationState === 'snoozed' && typeof state.snoozedUntil === 'number',
    );
    const customExpectedUntil = new Date(2099, 11, 31, 23, 59, 59, 999).getTime();
    record(
      'custom-snooze',
      customState?.curationState === 'snoozed' &&
        customState.snoozedUntil === customExpectedUntil &&
        typeof customState.curationUpdatedAt === 'number' &&
        customState.curationUpdatedAt >= customBefore,
      `state=${customState?.curationState} snoozedUntil=${customState?.snoozedUntil} expected=${customExpectedUntil} updatedAt=${customState?.curationUpdatedAt}`,
    );

    // Both rows should now be in the snoozed tab. The direct reads additionally
    // prove that curation changed the row rather than deleting it.
    await activateTab(page, 'tab-inbox-snoozed');
    await page.getByTestId(`card-transaction-${TX_PRESET.slice(0, 8)}`).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await page.getByTestId(`card-transaction-${TX_CUSTOM.slice(0, 8)}`).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    const survived = await page.evaluate(async ({ txPreset, txCustom }) => {
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const [preset, custom] = await Promise.all([
        txCrud.getTransactionByTxid(txPreset),
        txCrud.getTransactionByTxid(txCustom),
      ]);
      return {
        count: await txCrud.countTransactions(),
        presetId: preset?.id,
        customId: custom?.id,
        presetState: preset?.curationState,
        customState: custom?.curationState,
      };
    }, { txPreset: TX_PRESET, txCustom: TX_CUSTOM });
    record(
      'snooze-preserves-transactions',
      survived.count === 2 &&
        typeof survived.presetId === 'number' &&
        typeof survived.customId === 'number' &&
        survived.presetState === 'snoozed' &&
        survived.customState === 'snoozed',
      `count=${survived.count} presetId=${survived.presetId} customId=${survived.customId} states=${survived.presetState}/${survived.customState}`,
    );

    await context.close();
  } finally {
    await browser.close();
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* best effort */
        }
      }
    }
  }

  const failed = steps.filter((step) => !step.passed);
  console.log(`\n[transaction-inbox-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length > 0) {
    console.error(
      '[transaction-inbox-browser] FAILED steps:',
      failed.map((step) => step.name).join(', '),
    );
    process.exit(1);
  }
  console.log(
    '[transaction-inbox-browser] PASSED: v3/legacy restore safety, saved inbox views, and preset/custom snoozes work end to end in Chromium.',
  );
}

main().catch((error) => {
  console.error(
    '[transaction-inbox-browser] fatal:',
    error && error.stack ? error.stack : error,
  );
  process.exit(1);
});