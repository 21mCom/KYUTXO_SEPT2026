#!/usr/bin/env node
// Real-browser regression guard for the Transaction Inbox saved-view and
// snooze controls.
//
// This drives the actual /transaction-inbox page in Chromium:
//   1. creates a fresh vault and seeds two new, annotated transaction rows;
//   2. uses the real Radix date/amount filter popover and saves a named view;
//   3. changes the search and amount filters, saves the same name again, and
//      verifies that the existing view is updated rather than duplicated;
//   4. reloads, unlocks again, selects the updated view, and verifies that its
//      tab, search, date, and amount filters are restored;
//   5. deletes the active view, reloads, and verifies that it stays gone while
//      both underlying transactions remain unchanged;
//   6. snoozes one row with the one-week preset and the other with the native
//      custom date input, then verifies the persisted state/timestamps.
//
// Everything runs offline against local IndexedDB.
//
// Usage: node scripts/check-transaction-inbox-saved-view-snooze-browser.mjs
// Requires: a `chromium` binary on PATH and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}transaction-inbox`;
const SETUP_PASSWORD = 'transaction-inbox-check-123';
const VIEW_NAME = 'Inbox review today';

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
    '[transaction-inbox-browser] PASSED: saved inbox views and preset/custom snoozes work end to end in Chromium.',
  );
}

main().catch((error) => {
  console.error(
    '[transaction-inbox-browser] fatal:',
    error && error.stack ? error.stack : error,
  );
  process.exit(1);
});