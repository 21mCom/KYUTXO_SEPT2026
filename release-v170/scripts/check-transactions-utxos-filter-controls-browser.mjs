#!/usr/bin/env node
// Real-browser regression guard for the standardized Transactions/UTXOs
// filter & sort UI (Task #2132: searchable multi-select owner/wallet/seed/
// tag/category dropdowns, a unit-aware amount range, the new Transactions
// sort control, and a unified "Clear all filters" button).
//
// Task #2147: the new UI paths were previously only verified via jsdom
// component tests (client/src/pages/UTXOs.entityFilters.test.tsx,
// client/src/pages/Transactions.sortControl.test.tsx) plus a Playwright
// check that predates the standardization
// (scripts/check-transactions-entity-filter-browser.mjs, wallet/owner/tag
// only). jsdom cannot catch real popover positioning, click-through, or
// focus issues in the MultiSelectCombobox-based dropdowns, nor confirm the
// amount-range unit toggle actually renders/converts in a real layout.
//
// This script drives a REAL headless Chromium against the running dev
// server:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds two curated addresses — Alpha (wallet Alpha, seed SeedOne,
//      owner Alice, tag hot, category exchange) and Beta (wallet Beta, seed
//      SeedTwo, owner Bob, tag cold, category savings) — each with unspent
//      outputs at distinct amounts (Alpha 30,000 sats/output, Beta 5,000
//      sats/output) so the SAME seed doubles as the UTXO set on the UTXOs
//      page (unspent outputs = UTXOs) and the transaction set on the
//      Transactions page.
//   3. On /transactions: opens the wallet/seed/owner/tag/category
//      MultiSelectCombobox dropdowns (including a genuine multi-value OR
//      selection), toggles the sort-date control and confirms the rendered
//      card order actually reverses, applies a BTC amount-range filter, and
//      exercises the single "Clear all filters" button end to end
//      (including its badge count, which counts each ACTIVE FILTER
//      CATEGORY, not each selected value).
//   4. On /utxos: opens the owner/wallet/tag/category MultiSelectCombobox
//      dropdowns (including AND-across-dimension composition and a
//      multi-value OR selection), toggles the BTC/sats amount-range unit
//      and confirms the displayed+editable value converts correctly in both
//      directions, and exercises the single "Clear all filters" button
//      (whose badge counts each SELECTED VALUE per entity dimension — a
//      different, easy-to-regress semantic from the Transactions page).
//   5. Applies distinct filters on both pages, then uses browser Back and
//      Forward to confirm history restores each route with only its own
//      controls/filter state (including distinct date filters) and that the
//      restored controls remain usable.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-transactions-utxos-filter-controls-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'tx-utxo-filter-controls-check-123';

const ADDR_ALPHA = 'bc1qtxutxofiltercontrolsalphaaddressxxxxx';
const ADDR_BETA = 'bc1qtxutxofiltercontrolsbetaaddressxxxxxx';

const N_ALPHA = 15; // curated, wallet Alpha, seed SeedOne, owner Alice, tag hot, category exchange
const N_BETA = 8; // curated, wallet Beta, seed SeedTwo, owner Bob, tag cold, category savings
const ALPHA_SATS = 30_000; // 0.0003 BTC per output
const BETA_SATS = 5_000; // 0.00005 BTC per output

function txidFor(prefix, i) {
  return `${prefix}${String(i).padStart(4, '0')}`.padEnd(64, 'e');
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Wait until `getText(page)` settles on `expected` (string match, commas stripped). */
async function waitForText(page, getText, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (await getText(page).catch(() => '')) ?? '';
    if (text.replace(/,/g, '').trim() === String(expected)) return { ok: true, text };
    await page.waitForTimeout(400);
  }
  return { ok: false, text };
}

const totalTransactionsText = (page) =>
  page.getByTestId('text-total-transactions').textContent();
const utxoCountText = (page) => page.getByTestId('text-utxo-count').textContent();

async function waitForClearButtonGone(page, timeoutMs = 10_000) {
  await page
    .getByTestId('button-clear-filters')
    .waitFor({ state: 'detached', timeout: timeoutMs })
    .catch(() => {});
  return page.getByTestId('button-clear-filters').count();
}

async function closePopover(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page
    .getByTestId('tab-amount-any')
    .waitFor({ state: 'detached', timeout: 2_000 })
    .catch(() => {});
}

// Always closes any currently-open popover first (a no-op if nothing is
// open) and then opens the "Advanced Filters" popover fresh. Relying on an
// `isVisible()` read to decide whether to click the trigger is racy — Radix
// popovers can still be mid-close-animation when read, giving a stale
// "already open" answer that then lets us click into a combobox that is
// about to unmount underneath us.
async function openAdvancedFilters(page) {
  await closePopover(page);
  await clickEl(page, 'button-advanced-filters');
  await page.getByTestId('tab-amount-any').waitFor({ state: 'visible', timeout: 10_000 });
  // The popover slides/fades in; give the entrance animation time to settle
  // so subsequent clicks land on a stable target instead of a moving one.
  await page.waitForTimeout(300);
}

/**
 * Click a button via a dispatched event instead of Playwright's
 * actionability-polling `.click()`. After heavy client-side seeding on this
 * page, that polling can wedge indefinitely on otherwise-ordinary buttons
 * (see .agents/memory/detail-panel-click-races.md) — dispatching sidesteps
 * the polling and is fine for elements that just need a click handler to fire.
 */
async function clickEl(page, testId) {
  const el = page.getByTestId(testId);
  await el.waitFor({ state: 'visible' });
  await el.dispatchEvent('click');
}

/**
 * Select one value out of a MultiSelectCombobox by its testid (does not
 * close the popover). Uses a dispatched click rather than Playwright's
 * actionability-polling `.click()` — cmdk re-renders the option list on
 * every highlight/selection change, and that churn can make the coordinate
 * click never settle on a "stable" target (same bug class as the Tab/input
 * wedges below).
 */
async function pickComboboxValue(page, testId, value) {
  const trigger = page.getByTestId(testId);
  await trigger.waitFor({ state: 'visible' });
  await trigger.dispatchEvent('click');
  const option = page.getByRole('option', { name: value, exact: true });
  await option.waitFor({ state: 'visible' });
  await option.dispatchEvent('click');
}

/**
 * Activate a Radix TabsTrigger inside the filters popover. Coordinate clicks
 * (Playwright's actionability-polling `.click()`) can hang indefinitely
 * against this portal-rendered popover's tab triggers — see
 * .agents/memory/detail-panel-click-races.md and
 * scripts/check-transactions-entity-filter-engine-browser.mjs's
 * `activateTab` — so dispatch the events Radix listens to directly instead.
 */
async function activateTab(page, testId) {
  const el = page.getByTestId(testId);
  await el.waitFor({ state: 'attached' });
  await el.dispatchEvent('mousedown');
  await el.dispatchEvent('click');
}

/**
 * Set a controlled React input's value without Playwright's actionability
 * polling, which wedges against the same popover as the tab triggers above.
 * Uses the native value setter so React's onChange still fires.
 */
async function setInputValue(page, testId, value) {
  const el = page.getByTestId(testId);
  await el.waitFor({ state: 'attached' });
  await el.evaluate((node, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(node, v);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

function formatDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Select a date from the real react-day-picker calendar. The seeded dates
 * are adjacent to today, but navigating by the calendar's accessible month
 * button keeps this robust across month/year boundaries.
 */
async function pickCalendarDate(page, triggerTestId, dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const target = new Date(year, month - 1, day);
  const targetMonth = new Date(year, month - 1, 1);
  const expectedCaption = targetMonth.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  await clickEl(page, triggerTestId);
  for (let attempt = 0; attempt < 24; attempt++) {
    const caption = page.locator('[id^="react-day-picker-"]:visible').first();
    await caption.waitFor({ state: 'visible', timeout: 2_000 });
    const captionText = (await caption.textContent())?.trim() ?? '';
    if (captionText === expectedCaption) {
      const targetDay = page
        .locator('button[name="day"]:not(.day-outside):visible')
        .filter({ hasText: new RegExp(`^${day}$`) });
      await targetDay.first().waitFor({ state: 'visible', timeout: 2_000 });
      await targetDay.first().dispatchEvent('click');
      return;
    }

    const displayedMonth = new Date(`${captionText} 1`);
    const direction = targetMonth < displayedMonth ? 'previous' : 'next';
    const navigation = page.getByRole('button', { name: `Go to ${direction} month` });
    await navigation.waitFor({ state: 'visible', timeout: 2_000 });
    await navigation.dispatchEvent('click');
    await page.waitForTimeout(50);
  }
  throw new Error(`Could not find calendar date ${dateKey} (${expectedCaption}).`);
}

async function navigateInApp(page, linkTestId, expectedPath) {
  await clickEl(page, linkTestId);
  await page.waitForFunction(
    (path) => window.location.pathname === path,
    expectedPath,
    { timeout: 15_000 },
  );
}

async function navigateHistory(page, direction, expectedPath) {
  if (direction === 'back') {
    await page.goBack({ timeout: 15_000 }).catch(() => null);
  } else {
    await page.goForward({ timeout: 15_000 }).catch(() => null);
  }
  await page.waitForFunction(
    (path) => window.location.pathname === path,
    expectedPath,
    { timeout: 15_000 },
  );
}

async function main() {
  const exe = resolveChromium();
  console.log(`[tx-utxo-filter-controls] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[tx-utxo-filter-controls] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[tx-utxo-filter-controls] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel
  // validation load.
  let browser = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`[tx-utxo-filter-controls] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 2400 },
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[tx-utxo-filter-controls][page-console] ${msg.text()}`);
      }
    });

    await page.goto(`${BASE_URL}transactions`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed via the live Vite module singletons (bulk CRUD helpers) ────────
    const seed = await page.evaluate(
      async ({ addrAlpha, addrBeta, nAlpha, nBeta, alphaSats, betaSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const vocab = await import('/src/lib/data/vocabulary-crud.ts');

        const ensure = async (fn, name) => { try { await fn(name); } catch { /* exists */ } };
        await ensure(vocab.createWalletName, 'Alpha');
        await ensure(vocab.createWalletName, 'Beta');
        await ensure(vocab.createSeedName, 'SeedOne');
        await ensure(vocab.createSeedName, 'SeedTwo');
        await ensure(vocab.createOwner, 'Alice');
        await ensure(vocab.createOwner, 'Bob');
        await ensure(vocab.createTag, 'hot');
        await ensure(vocab.createTag, 'cold');
        await ensure(vocab.createCategory, 'exchange');
        await ensure(vocab.createCategory, 'savings');

        const alphaId = await recordCrud.createRecord({
          type: 'address', inputString: addrAlpha, label: 'Alpha addr',
          walletName: 'Alpha', seedName: 'SeedOne', owner: 'Alice',
          tags: ['hot'], categories: ['exchange'], addressImportance: 'manual',
        });
        const betaId = await recordCrud.createRecord({
          type: 'address', inputString: addrBeta, label: 'Beta addr',
          walletName: 'Beta', seedName: 'SeedTwo', owner: 'Bob',
          tags: ['cold'], categories: ['savings'], addressImportance: 'manual',
        });

        const pad = (p, i) => `${p}${String(i).padStart(4, '0')}`.padEnd(64, 'e');
        const today = new Date();
        const alphaDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0);
        const betaDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12, 0, 0);
        const alphaBlockTime = Math.floor(alphaDate.getTime() / 1000);
        const betaBlockTime = Math.floor(betaDate.getTime() / 1000);
        const dateKey = (date) => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        };
        const txs = [];
        const parts = [];
        // Alpha's transactions are all strictly newer than Beta's, so the
        // default (newest-first) sort renders an Alpha card first and a Beta
        // card last — a deterministic anchor for the sort-toggle check.
        for (let i = 0; i < nAlpha; i++) {
          const txid = pad('aaaa', i);
          txs.push({ txid, blockHeight: 800_000 + i, blockTime: alphaBlockTime - i * 60, fee: 100, feeRate: 1, syncedAt: Date.now() });
          parts.push({ txid, role: 'output', address: addrAlpha, amount: alphaSats, vout: 0, recordId: alphaId });
        }
        for (let i = 0; i < nBeta; i++) {
          const txid = pad('bbbb', i);
          txs.push({ txid, blockHeight: 900_000 + i, blockTime: betaBlockTime - i * 60, fee: 100, feeRate: 1, syncedAt: Date.now() });
          parts.push({ txid, role: 'output', address: addrBeta, amount: betaSats, vout: 0, recordId: betaId });
        }

        await txCrud.bulkAddTransactions(txs);
        await txCrud.bulkAddParticipants(parts);
        return {
          alphaId,
          betaId,
          txCount: txs.length,
          alphaDate: dateKey(alphaDate),
          betaDate: dateKey(betaDate),
        };
      },
      { addrAlpha: ADDR_ALPHA, addrBeta: ADDR_BETA, nAlpha: N_ALPHA, nBeta: N_BETA, alphaSats: ALPHA_SATS, betaSats: BETA_SATS },
    );
    steps.push({
      name: 'seeded vault (2 curated records, 23 transactions/unspent outputs)',
      passed: seed.txCount === N_ALPHA + N_BETA,
      detail: JSON.stringify(seed),
    });

    // ══════════════════════════════ Transactions ═══════════════════════════
    await page.goto(`${BASE_URL}transactions`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    const defaultTotal = await waitForText(page, totalTransactionsText, N_ALPHA + N_BETA);
    steps.push({
      name: '[Transactions] default curated view counts both addresses',
      passed: defaultTotal.ok,
      detail: `total="${defaultTotal.text}" expected=${N_ALPHA + N_BETA}`,
    });

    // ── multi-value OR selection: wallet = Alpha, then also Beta ────────────
    await openAdvancedFilters(page);
    await pickComboboxValue(page, 'select-entity-wallet', 'Alpha');
    await closePopover(page);
    const walletAlphaOnly = await waitForText(page, totalTransactionsText, N_ALPHA);
    steps.push({
      name: '[Transactions] wallet=Alpha multi-select narrows to Alpha transactions',
      passed: walletAlphaOnly.ok,
      detail: `total="${walletAlphaOnly.text}" expected=${N_ALPHA}`,
    });

    await openAdvancedFilters(page);
    await pickComboboxValue(page, 'select-entity-wallet', 'Beta');
    await closePopover(page);
    const walletBoth = await waitForText(page, totalTransactionsText, N_ALPHA + N_BETA);
    steps.push({
      name: '[Transactions] adding Beta to the wallet multi-select ORs back to both',
      passed: walletBoth.ok,
      detail: `total="${walletBoth.text}" expected=${N_ALPHA + N_BETA}`,
    });
    await clickEl(page, 'button-clear-entity-wallet');

    // ── seed, owner, tag, category — one dimension each ─────────────────────
    const dimensionChecks = [
      { dim: 'seed', value: 'SeedOne', expected: N_ALPHA },
      { dim: 'owner', value: 'Alice', expected: N_ALPHA },
      { dim: 'tag', value: 'hot', expected: N_ALPHA },
      { dim: 'category', value: 'exchange', expected: N_ALPHA },
    ];
    for (const { dim, value, expected } of dimensionChecks) {
      await openAdvancedFilters(page);
      await pickComboboxValue(page, `select-entity-${dim}`, value);
      await closePopover(page);
      const result = await waitForText(page, totalTransactionsText, expected);
      steps.push({
        name: `[Transactions] ${dim}=${value} filter matches only the Alpha transactions`,
        passed: result.ok,
        detail: `total="${result.text}" expected=${expected}`,
      });
      await clickEl(page, `button-clear-entity-${dim}`);
    }

    const clearedBack = await waitForText(page, totalTransactionsText, N_ALPHA + N_BETA);
    steps.push({
      name: '[Transactions] clearing every entity chip returns to the default total',
      passed: clearedBack.ok,
      detail: `total="${clearedBack.text}" expected=${N_ALPHA + N_BETA}`,
    });

    // ── sort control actually reorders the rendered cards ───────────────────
    const firstCardTestId = () =>
      page.evaluate(() => document.querySelector('[data-testid^="card-transaction-"]')?.getAttribute('data-testid') ?? null);

    const sortDefaultTitle = await page.getByTestId('button-sort-date').getAttribute('title');
    const firstCardDefault = await firstCardTestId();
    steps.push({
      name: '[Transactions] default sort is newest-first with an Alpha card on top',
      passed: sortDefaultTitle === 'Sorted newest first' && firstCardDefault === `card-transaction-${txidFor('aaaa', 0).slice(0, 8)}`,
      detail: `title="${sortDefaultTitle}" firstCard="${firstCardDefault}"`,
    });

    await clickEl(page, 'button-sort-date');
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid^="card-transaction-"]')?.getAttribute('data-testid') === expected,
      `card-transaction-${txidFor('bbbb', N_BETA - 1).slice(0, 8)}`,
      { timeout: 15_000 },
    ).catch(() => {});
    const sortToggledTitle = await page.getByTestId('button-sort-date').getAttribute('title');
    const firstCardToggled = await firstCardTestId();
    steps.push({
      name: '[Transactions] toggling sort reverses to oldest-first with a Beta card on top',
      passed: sortToggledTitle === 'Sorted oldest first' && firstCardToggled === `card-transaction-${txidFor('bbbb', N_BETA - 1).slice(0, 8)}`,
      detail: `title="${sortToggledTitle}" firstCard="${firstCardToggled}"`,
    });
    await clickEl(page, 'button-sort-date'); // restore default for the remaining checks

    // ── amount-range filter (BTC unit; Transactions has no unit toggle) ─────
    await openAdvancedFilters(page);
    await activateTab(page, 'tab-amount-range');
    await setInputValue(page, 'input-amount-min', '0.0001');
    await closePopover(page);
    const amountRangeResult = await waitForText(page, totalTransactionsText, N_ALPHA);
    steps.push({
      name: '[Transactions] amount-range min=0.0001 BTC keeps only the 0.0003 BTC Alpha transactions',
      passed: amountRangeResult.ok,
      detail: `total="${amountRangeResult.text}" expected=${N_ALPHA} (Beta outputs are 0.00005 BTC each)`,
    });

    // ── unified "Clear all filters" — search + advanced filters + entity +
    //    OP_RETURN all reset together, with an accurate badge count ─────────
    await setInputValue(page, 'input-search', 'nonsense-search-term');
    await openAdvancedFilters(page);
    await pickComboboxValue(page, 'select-entity-owner', 'Alice');
    await closePopover(page);
    await clickEl(page, 'button-opreturn-filter');
    // Categories active now: search(1) + amount-range(1, still set) + entity(1) + opReturn(1) = 4.
    const clearBadgeText = (await page.getByTestId('button-clear-filters').textContent())?.trim() ?? '';
    steps.push({
      name: '[Transactions] Clear-all badge counts each active filter CATEGORY (search, amount, entity, OP_RETURN) as 4',
      passed: clearBadgeText.endsWith('4'),
      detail: `button text="${clearBadgeText}"`,
    });

    await clickEl(page, 'button-clear-filters');
    const afterClearTotal = await waitForText(page, totalTransactionsText, N_ALPHA + N_BETA);
    const searchCleared = await page.getByTestId('input-search').inputValue();
    const opReturnStillOn = await page.getByTestId('button-opreturn-filter').getAttribute('class');
    const clearButtonGone = await waitForClearButtonGone(page);
    steps.push({
      name: '[Transactions] Clear-all resets search, amount range, entity filter, and OP_RETURN together',
      passed: afterClearTotal.ok && searchCleared === '' && !(opReturnStillOn ?? '').includes('bg-purple-600') && clearButtonGone === 0,
      detail: `total="${afterClearTotal.text}" search="${searchCleared}" opReturnClass="${opReturnStillOn}" clearButtonCount=${clearButtonGone}`,
    });

    // ══════════════════════════════════ UTXOs ═══════════════════════════════
    // Leave the Transactions popover open while switching routes. This
    // exercises the client-side unmount/remount path instead of only testing
    // two independent page loads.
    await openAdvancedFilters(page);
    const linkedEntityControlTestIds = [
      'input-entity-address',
      'select-entity-wallet',
      'select-entity-seed',
      'select-entity-owner',
      'select-entity-tag',
      'select-entity-category',
    ];
    const transactionLinkedEntityControlCounts = await Promise.all(
      linkedEntityControlTestIds.map((testId) => page.getByTestId(testId).count()),
    );
    steps.push({
      name: '[Transactions] Advanced Filters exposes linked-entity address and wallet/seed/owner/tag/category controls',
      passed: transactionLinkedEntityControlCounts.every((count) => count === 1),
      detail: linkedEntityControlTestIds
        .map((testId, index) => `${testId}=${transactionLinkedEntityControlCounts[index]}`)
        .join(' '),
    });

    await navigateInApp(page, 'link-utxos', '/utxos');
    await page.getByTestId('text-utxo-count').waitFor({ state: 'visible', timeout: 15_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 1_000 });

    const utxoDefault = await waitForText(page, utxoCountText, '2 / 23');
    steps.push({
      name: '[UTXOs] default curated view shows both addresses and all unspent outputs',
      passed: utxoDefault.ok,
      detail: `text="${utxoDefault.text}" expected="2 / 23"`,
    });

    // UTXOs owns the entity filters rendered beside the search box. Its
    // Advanced Filters popover must not expose the linked-entity controls,
    // because this page does not wire those component filters into its
    // filtering path.
    await openAdvancedFilters(page);
    const linkedEntityControlCounts = await Promise.all(
      linkedEntityControlTestIds.map((testId) => page.getByTestId(testId).count()),
    );
    await closePopover(page);
    steps.push({
      name: '[UTXOs] Advanced Filters omits linked-entity address and wallet/seed/owner/tag/category controls',
      passed: linkedEntityControlCounts.every((count) => count === 0),
      detail: linkedEntityControlTestIds
        .map((testId, index) => `${testId}=${linkedEntityControlCounts[index]}`)
        .join(' '),
    });

    // NOTE: MultiSelectCombobox only ever renders UNselected options in its
    // list (selected values move to a Badge row above the trigger, and can
    // only be removed via the Badge's own X button — clicking an
    // already-selected value's `role="option"` again is not a valid
    // deselect path, since that option is filtered out of the list). So
    // every block below only ADDS selections, then resets everything via the
    // page's single "Clear all filters" control before the next block.

    // ── owner=Alice narrows to the Alpha address ─────────────────────────────
    await pickComboboxValue(page, 'select-owner', 'Alice');
    await closePopover(page);
    const ownerAlice = await waitForText(page, utxoCountText, `1 / ${N_ALPHA}`);
    steps.push({
      name: '[UTXOs] owner=Alice narrows to Alpha address and its unspent outputs',
      passed: ownerAlice.ok,
      detail: `text="${ownerAlice.text}" expected="1 / ${N_ALPHA}"`,
    });
    await clickEl(page, 'button-clear-filters');

    // ── multi-value OR within the wallet dimension: Alpha alone, then + Beta ─
    await pickComboboxValue(page, 'select-wallet', 'Alpha');
    await closePopover(page);
    const walletAlphaOnlyUtxo = await waitForText(page, utxoCountText, `1 / ${N_ALPHA}`);
    steps.push({
      name: '[UTXOs] wallet=Alpha narrows to the Alpha address alone',
      passed: walletAlphaOnlyUtxo.ok,
      detail: `text="${walletAlphaOnlyUtxo.text}" expected="1 / ${N_ALPHA}"`,
    });
    await pickComboboxValue(page, 'select-wallet', 'Beta');
    await closePopover(page);
    const walletBothUtxo = await waitForText(page, utxoCountText, '2 / 23');
    steps.push({
      name: '[UTXOs] adding Beta to the wallet multi-select ORs back to both addresses',
      passed: walletBothUtxo.ok,
      detail: `text="${walletBothUtxo.text}" expected="2 / 23"`,
    });
    await clickEl(page, 'button-clear-filters');

    // ── AND-across dimensions: owner=Bob AND wallet=Alpha matches nothing ────
    // (Bob's address is wallet Beta; Alpha's owner is Alice.)
    await pickComboboxValue(page, 'select-owner', 'Bob');
    await closePopover(page);
    await pickComboboxValue(page, 'select-wallet', 'Alpha');
    await closePopover(page);
    const andAcrossNoMatch = await waitForText(page, utxoCountText, '0 / 0');
    steps.push({
      name: '[UTXOs] owner=Bob AND wallet=Alpha (AND-across-dimensions) matches nothing',
      passed: andAcrossNoMatch.ok,
      detail: `text="${andAcrossNoMatch.text}" expected="0 / 0"`,
    });
    await clickEl(page, 'button-clear-filters');

    // ── tag and category, one dimension each ─────────────────────────────────
    await pickComboboxValue(page, 'select-tag', 'hot');
    await closePopover(page);
    const tagHot = await waitForText(page, utxoCountText, `1 / ${N_ALPHA}`);
    steps.push({
      name: '[UTXOs] tag=hot narrows to the Alpha address and its unspent outputs',
      passed: tagHot.ok,
      detail: `text="${tagHot.text}" expected="1 / ${N_ALPHA}"`,
    });
    await clickEl(page, 'button-clear-filters');

    await pickComboboxValue(page, 'select-category', 'savings');
    await closePopover(page);
    const categorySavings = await waitForText(page, utxoCountText, `1 / ${N_BETA}`);
    steps.push({
      name: '[UTXOs] category=savings narrows to the Beta address and its unspent outputs',
      passed: categorySavings.ok,
      detail: `text="${categorySavings.text}" expected="1 / ${N_BETA}"`,
    });
    await clickEl(page, 'button-clear-filters');

    // ── BTC/sats amount-range unit toggle: values convert both ways ─────────
    await openAdvancedFilters(page);
    await activateTab(page, 'tab-amount-range');
    await setInputValue(page, 'input-amount-min', '0.0001'); // 10,000 sats: excludes Beta's 5,000-sat outputs
    await closePopover(page);
    const btcRangeResult = await waitForText(page, utxoCountText, `1 / ${N_ALPHA}`);
    steps.push({
      name: '[UTXOs] amount-range min=0.0001 BTC keeps only Alpha (0.0003 BTC/output)',
      passed: btcRangeResult.ok,
      detail: `text="${btcRangeResult.text}" expected="1 / ${N_ALPHA}"`,
    });

    await clickEl(page, 'button-toggle-unit'); // switch display to sats
    await openAdvancedFilters(page);
    await activateTab(page, 'tab-amount-range');
    const minLabelAfterToggle = await page.getByText('Min Sats').isVisible().catch(() => false);
    const minValueAfterToggle = await page.getByTestId('input-amount-min').inputValue();
    steps.push({
      name: '[UTXOs] toggling to sats relabels the field and converts 0.0001 BTC to 10000 sats',
      passed: minLabelAfterToggle && minValueAfterToggle === '10000',
      detail: `labelVisible=${minLabelAfterToggle} value="${minValueAfterToggle}"`,
    });

    // Editing the field while displaying sats must convert back to BTC for
    // filtering: 4000 sats (0.00004 BTC) is below BOTH addresses' amounts.
    await setInputValue(page, 'input-amount-min', '4000');
    await closePopover(page);
    const satsEditResult = await waitForText(page, utxoCountText, '2 / 23');
    steps.push({
      name: '[UTXOs] editing the min field as 4000 sats converts to 0.00004 BTC and widens back to both addresses',
      passed: satsEditResult.ok,
      detail: `text="${satsEditResult.text}" expected="2 / 23"`,
    });
    await clickEl(page, 'button-toggle-unit'); // restore BTC display
    await clickEl(page, 'button-clear-filters');

    // ── unified "Clear all filters" — search + entity dims + hide-dust, with
    //    a badge that counts each SELECTED VALUE (not just each dimension) ──
    await setInputValue(page, 'input-search', 'nonsense-search-term');
    await pickComboboxValue(page, 'select-owner', 'Alice');
    await closePopover(page);
    await pickComboboxValue(page, 'select-wallet', 'Alpha');
    await pickComboboxValue(page, 'select-wallet', 'Beta');
    await closePopover(page);
    await clickEl(page, 'switch-hide-dust');
    // search(1) + owner(1 value) + wallet(2 values) + hideDust(1) = 5.
    const utxoClearBadgeText = (await page.getByTestId('button-clear-filters').textContent())?.trim() ?? '';
    steps.push({
      name: '[UTXOs] Clear-all badge counts each SELECTED VALUE per dimension (1 owner + 2 wallets + search + hide-dust = 5)',
      passed: utxoClearBadgeText.endsWith('5'),
      detail: `button text="${utxoClearBadgeText}"`,
    });

    await clickEl(page, 'button-clear-filters');
    const utxoAfterClear = await waitForText(page, utxoCountText, '2 / 23');
    const utxoSearchCleared = await page.getByTestId('input-search').inputValue();
    const hideDustState = await page.getByTestId('switch-hide-dust').getAttribute('data-state');
    const utxoClearButtonGone = await waitForClearButtonGone(page);
    steps.push({
      name: '[UTXOs] Clear-all resets search, every entity dimension, and hide-dust together',
      passed: utxoAfterClear.ok && utxoSearchCleared === '' && hideDustState === 'unchecked' && utxoClearButtonGone === 0,
      detail: `text="${utxoAfterClear.text}" search="${utxoSearchCleared}" hideDust="${hideDustState}" clearButtonCount=${utxoClearButtonGone}`,
    });

    // Return through the sidebar in the same browser session. The second
    // assertion catches a route transition that leaves the page-specific
    // showEntityFilters contract stale after UTXOs has unmounted.
    await navigateInApp(page, 'link-transactions', '/transactions');
    await page.getByTestId('text-total-transactions').waitFor({ state: 'visible', timeout: 15_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 1_000 });
    await openAdvancedFilters(page);
    const transactionControlsAfterTransition = await Promise.all(
      linkedEntityControlTestIds.map((testId) => page.getByTestId(testId).count()),
    );
    await closePopover(page);
    steps.push({
      name: '[Transactions] linked-entity controls return after navigating back from UTXOs',
      passed: transactionControlsAfterTransition.every((count) => count === 1),
      detail: linkedEntityControlTestIds
        .map((testId, index) => `${testId}=${transactionControlsAfterTransition[index]}`)
        .join(' '),
    });

    // ── browser history navigation ─────────────────────────────────────────
    // Apply different filters before using the browser history controls. The
    // pages intentionally reset list filters on a route remount, so the
    // Back/Forward assertions below ensure a restored route does not inherit
    // the other page's state (and that its own controls are mounted again).
    await setInputValue(page, 'input-search', 'Alpha addr');
    const transactionSearchFilter = await waitForText(page, totalTransactionsText, N_ALPHA);
    await openAdvancedFilters(page);
    await activateTab(page, 'tab-amount-range');
    await setInputValue(page, 'input-amount-min', '0.0001');
    await activateTab(page, 'tab-date-exact');
    await pickCalendarDate(page, 'button-date-exact', seed.alphaDate);
    await closePopover(page);
    const transactionAmountFilter = await waitForText(page, totalTransactionsText, N_ALPHA);
    const transactionDateFilter = await waitForText(page, totalTransactionsText, N_ALPHA);
    await clickEl(page, 'button-opreturn-filter');
    const transactionToggleFilter = await waitForText(page, totalTransactionsText, 0);
    const transactionSearchValue = await page.getByTestId('input-search').inputValue();
    const transactionOpReturnClass = await page.getByTestId('button-opreturn-filter').getAttribute('class');
    await openAdvancedFilters(page);
    const transactionAmountValue = await page.getByTestId('input-amount-min').inputValue();
    const transactionDateMode = await page.getByTestId('tab-date-exact').getAttribute('data-state');
    const transactionDateExact = (await page.getByTestId('button-date-exact').textContent())?.trim() ?? '';
    await closePopover(page);
    steps.push({
      name: '[History] Transactions keeps its search, amount range, exact date, and OP_RETURN filters together',
      passed: transactionSearchFilter.ok &&
        transactionAmountFilter.ok &&
        transactionDateFilter.ok &&
        transactionToggleFilter.ok &&
        transactionSearchValue === 'Alpha addr' &&
        transactionAmountValue === '0.0001' &&
        transactionDateMode === 'active' &&
        transactionDateExact === formatDateKey(seed.alphaDate) &&
        (transactionOpReturnClass ?? '').includes('bg-purple-600'),
      detail: `searchTotal="${transactionSearchFilter.text}" amountTotal="${transactionAmountFilter.text}" ` +
        `dateTotal="${transactionDateFilter.text}" opReturnTotal="${transactionToggleFilter.text}" ` +
        `search="${transactionSearchValue}" min="${transactionAmountValue}" ` +
        `dateMode="${transactionDateMode}" exact="${transactionDateExact}" ` +
        `opReturnClass="${transactionOpReturnClass}"`,
    });

    await navigateInApp(page, 'link-utxos', '/utxos');
    await page.getByTestId('text-utxo-count').waitFor({ state: 'visible', timeout: 15_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 1_000 });
    await setInputValue(page, 'input-search', 'Beta addr');
    const utxoSearchFilter = await waitForText(page, utxoCountText, `1 / ${N_BETA}`);
    await openAdvancedFilters(page);
    await activateTab(page, 'tab-amount-range');
    await setInputValue(page, 'input-amount-min', '0.00004');
    await closePopover(page);
    const utxoAmountFilter = await waitForText(page, utxoCountText, `1 / ${N_BETA}`);
    await openAdvancedFilters(page);
    await activateTab(page, 'tab-date-exact');
    await pickCalendarDate(page, 'button-date-exact', seed.betaDate);
    await closePopover(page);
    const utxoDateFilter = await waitForText(page, utxoCountText, `1 / ${N_BETA}`);
    await clickEl(page, 'button-toggle-unit');
    await openAdvancedFilters(page);
    const utxoAmountMode = await page.getByTestId('tab-amount-range').getAttribute('data-state');
    const utxoAmountInputCount = await page.getByTestId('input-amount-min').count();
    const utxoAmountValue = utxoAmountInputCount > 0
      ? await page.getByTestId('input-amount-min').inputValue()
      : '';
    const utxoDateMode = await page.getByTestId('tab-date-exact').getAttribute('data-state');
    const utxoDateExact = (await page.getByTestId('button-date-exact').textContent())?.trim() ?? '';
    await closePopover(page);
    await clickEl(page, 'switch-hide-dust');
    const utxoToggleFilter = await waitForText(page, utxoCountText, `1 / ${N_BETA}`);
    const utxoSearchValue = await page.getByTestId('input-search').inputValue();
    const utxoHideDustState = await page.getByTestId('switch-hide-dust').getAttribute('data-state');
    const utxoDisplayToggleText = (await page.getByTestId('button-toggle-unit').textContent())?.trim() ?? '';
    await closePopover(page);
    steps.push({
      name: '[History] UTXOs keeps its search, amount range, exact date, sats unit, and Hide dust filters together',
      passed: utxoSearchFilter.ok &&
        utxoAmountFilter.ok &&
        utxoDateFilter.ok &&
        utxoToggleFilter.ok &&
        utxoSearchValue === 'Beta addr' &&
        utxoAmountValue === '4000' &&
        utxoAmountMode === 'active' &&
        utxoDateMode === 'active' &&
        utxoDateExact === formatDateKey(seed.betaDate) &&
        utxoHideDustState === 'checked' &&
        utxoDisplayToggleText === 'BTC',
      detail: `search="${utxoSearchValue}" searchResult="${utxoSearchFilter.text}" ` +
        `amountResult="${utxoAmountFilter.text}" dateResult="${utxoDateFilter.text}" ` +
        `toggleResult="${utxoToggleFilter.text}" min="${utxoAmountValue}" ` +
        `amountMode="${utxoAmountMode}" amountInputCount=${utxoAmountInputCount} ` +
        `dateMode="${utxoDateMode}" exact="${utxoDateExact}" ` +
        `hideDust="${utxoHideDustState}" unitToggle="${utxoDisplayToggleText}"`,
    });

    await navigateHistory(page, 'back', '/transactions');
    await page.getByTestId('text-total-transactions').waitFor({ state: 'visible', timeout: 15_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 1_000 });
    const transactionsAfterBack = await waitForText(page, totalTransactionsText, N_ALPHA + N_BETA);
    const transactionSearchAfterBack = await page.getByTestId('input-search').inputValue();
    const transactionOpReturnAfterBack = await page.getByTestId('button-opreturn-filter').getAttribute('class');
    await openAdvancedFilters(page);
    const transactionDateTabAfterBack = await page.getByTestId('tab-date-any').getAttribute('data-state');
    const transactionDateControlCountAfterBack = await Promise.all([
      page.getByTestId('button-date-start').count(),
      page.getByTestId('button-date-end').count(),
      page.getByTestId('button-date-exact').count(),
    ]);
    const transactionAmountTabAfterBack = await page.getByTestId('tab-amount-any').getAttribute('data-state');
    const transactionAmountInputCountAfterBack = await page.getByTestId('input-amount-min').count();
    const transactionControlsAfterBack = await Promise.all(
      linkedEntityControlTestIds.map((testId) => page.getByTestId(testId).count()),
    );
    await closePopover(page);
    steps.push({
      name: '[History] browser Back restores Transactions defaults without UTXO search/amount/toggle state',
      passed: transactionsAfterBack.ok &&
        transactionSearchAfterBack === '' &&
        !(transactionOpReturnAfterBack ?? '').includes('bg-purple-600') &&
        transactionDateTabAfterBack === 'active' &&
        transactionDateControlCountAfterBack.every((count) => count === 0) &&
        transactionAmountTabAfterBack === 'active' &&
        transactionAmountInputCountAfterBack === 0 &&
        transactionControlsAfterBack.every((count) => count === 1),
      detail: `total="${transactionsAfterBack.text}" expected=${N_ALPHA + N_BETA} ` +
        `search="${transactionSearchAfterBack}" opReturnClass="${transactionOpReturnAfterBack}" ` +
        `dateAny="${transactionDateTabAfterBack}" dateControls=${transactionDateControlCountAfterBack.join(',')} ` +
        `amountAny="${transactionAmountTabAfterBack}" amountMinCount=${transactionAmountInputCountAfterBack} ` +
        linkedEntityControlTestIds
          .map((testId, index) => `${testId}=${transactionControlsAfterBack[index]}`)
          .join(' '),
    });

    await navigateHistory(page, 'forward', '/utxos');
    await page.getByTestId('text-utxo-count').waitFor({ state: 'visible', timeout: 15_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 1_000 });
    const utxosAfterForward = await waitForText(page, utxoCountText, '2 / 23');
    const utxoSearchAfterForward = await page.getByTestId('input-search').inputValue();
    const utxoHideDustAfterForward = await page.getByTestId('switch-hide-dust').getAttribute('data-state');
    const utxoDisplayToggleAfterForward = (await page.getByTestId('button-toggle-unit').textContent())?.trim() ?? '';
    await openAdvancedFilters(page);
    const utxoDateTabAfterForward = await page.getByTestId('tab-date-any').getAttribute('data-state');
    const utxoDateControlCountAfterForward = await Promise.all([
      page.getByTestId('button-date-start').count(),
      page.getByTestId('button-date-end').count(),
      page.getByTestId('button-date-exact').count(),
    ]);
    const utxoAmountTabAfterForward = await page.getByTestId('tab-amount-any').getAttribute('data-state');
    const utxoAmountInputCountAfterForward = await page.getByTestId('input-amount-min').count();
    const linkedControlsAfterForward = await Promise.all(
      linkedEntityControlTestIds.map((testId) => page.getByTestId(testId).count()),
    );
    await closePopover(page);
    steps.push({
      name: '[History] browser Forward restores UTXOs defaults without Transactions search/amount/toggle state',
      passed: utxosAfterForward.ok &&
        utxoSearchAfterForward === '' &&
        utxoHideDustAfterForward === 'unchecked' &&
        utxoDisplayToggleAfterForward === 'sats' &&
        utxoDateTabAfterForward === 'active' &&
        utxoDateControlCountAfterForward.every((count) => count === 0) &&
        utxoAmountTabAfterForward === 'active' &&
        utxoAmountInputCountAfterForward === 0 &&
        linkedControlsAfterForward.every((count) => count === 0),
      detail: `text="${utxosAfterForward.text}" expected="2 / 23" ` +
        `search="${utxoSearchAfterForward}" hideDust="${utxoHideDustAfterForward}" ` +
        `unitToggle="${utxoDisplayToggleAfterForward}" amountAny="${utxoAmountTabAfterForward}" ` +
        `dateAny="${utxoDateTabAfterForward}" dateControls=${utxoDateControlCountAfterForward.join(',')} ` +
        `amountMinCount=${utxoAmountInputCountAfterForward} ` +
        linkedEntityControlTestIds
          .map((testId, index) => `${testId}=${linkedControlsAfterForward[index]}`)
          .join(' '),
    });

    await openAdvancedFilters(page);
    await activateTab(page, 'tab-date-exact');
    await pickCalendarDate(page, 'button-date-exact', seed.betaDate);
    const utxoDateAfterForwardValue = (await page.getByTestId('button-date-exact').textContent())?.trim() ?? '';
    await closePopover(page);
    const utxoDateAfterForwardFilter = await waitForText(page, utxoCountText, `1 / ${N_BETA}`);
    steps.push({
      name: '[History] UTXOs exact date filter remains usable after browser Forward',
      passed: utxoDateAfterForwardFilter.ok &&
        utxoDateAfterForwardValue === formatDateKey(seed.betaDate),
      detail: `text="${utxoDateAfterForwardFilter.text}" expected="1 / ${N_BETA}" ` +
        `exact="${utxoDateAfterForwardValue}"`,
    });

    await pickComboboxValue(page, 'select-owner', 'Bob');
    await closePopover(page);
    const utxoAfterForwardFilter = await waitForText(page, utxoCountText, `1 / ${N_BETA}`);
    steps.push({
      name: '[History] UTXOs owner filter remains usable after browser Forward',
      passed: utxoAfterForwardFilter.ok,
      detail: `text="${utxoAfterForwardFilter.text}" expected="1 / ${N_BETA}"`,
    });
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try { devProc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
  }

  const ok = steps.every((s) => s.passed);
  console.log(`[tx-utxo-filter-controls] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[tx-utxo-filter-controls] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[tx-utxo-filter-controls] PASSED: standardized filter/sort controls work end to end in a real browser.');
}

main().catch((err) => {
  console.error('[tx-utxo-filter-controls] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
