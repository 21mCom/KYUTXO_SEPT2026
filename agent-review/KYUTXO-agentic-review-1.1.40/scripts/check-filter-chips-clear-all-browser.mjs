#!/usr/bin/env node
// Real-browser regression guard for the active-filter chips + single
// "Clear all filters" control added (Task 2133) across the five secondary
// list pages: AddressReuse, ConflictResolution, VaultManagement, Evidence,
// and BulkEditor.
//
// WHY a browser check and not jsdom: the existing jsdom unit tests for these
// pages never touch the filter bar (they assert data/logic, not the chip
// row), so a future refactor could silently drop a <FilterChip>, break the
// AddressReuse owner/wallet MultiSelectCombobox conversion, or regress the
// "Clear all" reset without any test failing. This script drives a REAL
// headless Chromium against the running dev server and asserts, per page:
//
//   1. AddressReuse: seed one owned address record (owner + walletName +
//      tags) that is reused (two receiving txs). Open the owner
//      MultiSelectCombobox (combobox-owner-filter), assert it lists the
//      seeded owner, select it, and assert a chip-filter-owner-* renders and
//      button-clear-filters appears. Then also set the search box, the
//      wallet MultiSelectCombobox, the importance Select, and the reuse-type
//      ToggleGroup, and assert clicking button-clear-filters resets ALL of
//      them together (search box empty, every chip gone, the clear button
//      itself disappears since no filter is active anymore).
//   2. ConflictResolution, VaultManagement, Evidence: type into the search
//      box, assert the search-text chip (chip-filter-search) and the page's
//      single clear-all control (button-clear-all-filters) appear, then
//      assert clicking it resets the search box and removes both.
//   3. BulkEditor: click "Add Condition", assert the condition-count badge
//      and button-clear-all-conditions appear, then assert clicking it
//      clears every condition row.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-filter-chips-clear-all-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const LABEL = 'filter-chips-clear-all-browser';
const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'filter-chips-check-123';

const OWNED_ADDR = 'bc1qfilterchiptestaddresszzzzzzzzzzzzzz00';
const OWNER_NAME = 'Chip Test Owner';
const WALLET_NAME = 'Chip Test Wallet';
const TX1 = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222';
const TX2 = 'bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cccc3333';
const SEARCH_TEXT = 'chip-test-search';

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

async function launchWithRetry(exe, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(`[${LABEL}] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * The sidebar groups its nav links under collapsible sections
 * (client/src/components/AppSidebar.tsx); only "Overview" and "Data" default
 * to open. Click the section header first if the link isn't visible yet,
 * without toggling an already-open section closed.
 */
async function clickNavLink(page, groupId, linkTestId) {
  const link = page.getByTestId(linkTestId);
  const alreadyVisible = await link.isVisible().catch(() => false);
  if (!alreadyVisible) {
    await page.getByTestId(`group-${groupId}`).click();
  }
  await link.waitFor({ state: 'visible', timeout: 15_000 });
  await link.click();
}

async function main() {
  const exe = resolveChromium();
  console.log(`[${LABEL}] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[${LABEL}] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[${LABEL}] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[${LABEL}] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[${LABEL}][page-console] ${msg.text()}`);
    });

    let landed = false;
    for (let i = 0; i < 3 && !landed; i++) {
      landed = await page
        .goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!landed) await page.waitForTimeout(3000);
    }
    if (!landed) throw new Error(`Could not load ${BASE_URL}`);
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── AddressReuse ─────────────────────────────────────────────────────
    await clickNavLink(page, 'analysis', 'link-address-reuse');
    const searchReuse = page.getByTestId('input-search-reuse');
    await searchReuse.waitFor({ state: 'visible', timeout: 30_000 });

    // Seed one owned address record (owner + walletName) reused across two
    // receiving transactions, via the LIVE Vite module singletons — same
    // Dexie instance the page reads through useDbChangeSignal/notifyDbChange.
    const seed = await page.evaluate(
      async ({ address, owner, walletName, tx1, tx2 }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: address,
          label: 'Filter chip test address',
          owner,
          walletName,
          addressImportance: 'manual',
        });
        const blockTime = Math.floor(Date.now() / 1000) - 3600;
        await txCrud.addTransaction({ txid: tx1, blockHeight: 800001, blockTime, fee: 200, feeRate: 1, syncedAt: Date.now() });
        await txCrud.addTransaction({ txid: tx2, blockHeight: 800002, blockTime: blockTime + 60, fee: 200, feeRate: 1, syncedAt: Date.now() });
        await txCrud.addParticipant({ txid: tx1, role: 'output', address, amount: 20000, vout: 0, recordId });
        await txCrud.addParticipant({ txid: tx2, role: 'output', address, amount: 30000, vout: 0, recordId });
        return { recordId };
      },
      { address: OWNED_ADDR, owner: OWNER_NAME, walletName: WALLET_NAME, tx1: TX1, tx2: TX2 },
    );
    steps.push({
      name: 'seeded a reused owned-address record with owner + walletName',
      passed: Number.isInteger(seed.recordId) && seed.recordId > 0,
      detail: `recordId=${seed.recordId}`,
    });

    // Owner combobox opens and lists the seeded owner (vocabulary sync is
    // fire-and-forget, so give the live-query chain a moment to settle).
    const ownerCombo = page.getByTestId('combobox-owner-filter');
    await ownerCombo.click();
    const ownerOption = page.getByRole('option', { name: OWNER_NAME });
    const ownerListed = await ownerOption
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'owner combobox opens and lists the seeded owner',
      passed: ownerListed,
      detail: `combobox-owner-filter opened, option "${OWNER_NAME}" visible=${ownerListed}`,
    });
    if (ownerListed) await ownerOption.click();
    await page.keyboard.press('Escape');

    const ownerChip = page.getByTestId(`chip-filter-owner-${OWNER_NAME}`);
    const ownerChipVisible = await ownerChip
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const clearFiltersBtn = page.getByTestId('button-clear-filters');
    const clearBtnVisibleAfterOwner = await clearFiltersBtn.isVisible().catch(() => false);
    steps.push({
      name: 'selecting the owner renders a chip and shows the clear-filters control',
      passed: ownerChipVisible && clearBtnVisibleAfterOwner,
      detail: `chip-filter-owner-${OWNER_NAME} visible=${ownerChipVisible}, button-clear-filters visible=${clearBtnVisibleAfterOwner}`,
    });

    // Layer on every other filter kind so the "Clear All" assertion below
    // proves it resets the search box AND every dropdown/multi-select
    // together, not just the owner combobox.
    await searchReuse.fill(SEARCH_TEXT);

    const walletCombo = page.getByTestId('combobox-wallet-filter');
    await walletCombo.click();
    const walletOption = page.getByRole('option', { name: WALLET_NAME });
    await walletOption.waitFor({ state: 'visible', timeout: 20_000 });
    await walletOption.click();
    await page.keyboard.press('Escape');

    await page.getByTestId('select-importance-filter').click();
    await page.getByRole('option', { name: 'Verified' }).click();

    await page.getByTestId('toggle-reuse-multi-receive').click();

    const preClearChips = {
      search: await page.getByTestId('chip-filter-search').isVisible().catch(() => false),
      owner: await page.getByTestId(`chip-filter-owner-${OWNER_NAME}`).isVisible().catch(() => false),
      wallet: await page.getByTestId(`chip-filter-wallet-${WALLET_NAME}`).isVisible().catch(() => false),
      importance: await page.getByTestId('chip-filter-importance').isVisible().catch(() => false),
      reuseType: await page.getByTestId('chip-filter-reuse-type').isVisible().catch(() => false),
    };
    steps.push({
      name: 'search text, wallet, importance, and reuse-type filters each render their own chip',
      passed: Object.values(preClearChips).every(Boolean),
      detail: JSON.stringify(preClearChips),
    });

    await page.getByTestId('button-clear-filters').click();

    const postClearSearchValue = await searchReuse.inputValue();
    const postClearChipCounts = {
      search: await page.getByTestId('chip-filter-search').count(),
      owner: await page.getByTestId(`chip-filter-owner-${OWNER_NAME}`).count(),
      wallet: await page.getByTestId(`chip-filter-wallet-${WALLET_NAME}`).count(),
      importance: await page.getByTestId('chip-filter-importance').count(),
      reuseType: await page.getByTestId('chip-filter-reuse-type').count(),
    };
    const postClearButtonCount = await page.getByTestId('button-clear-filters').count();
    const allChipsGone = Object.values(postClearChipCounts).every((c) => c === 0);
    steps.push({
      name: 'Clear All resets the search box and every dropdown/multi-select together',
      passed: postClearSearchValue === '' && allChipsGone && postClearButtonCount === 0,
      detail: `search="${postClearSearchValue}", chipCounts=${JSON.stringify(postClearChipCounts)}, clearButtonCount=${postClearButtonCount}`,
    });

    // ── ConflictResolution ───────────────────────────────────────────────
    await clickNavLink(page, 'data', 'link-conflict-resolution');
    const crSearch = page.getByTestId('input-search');
    await crSearch.waitFor({ state: 'visible', timeout: 30_000 });
    await crSearch.fill(SEARCH_TEXT);

    const crChip = page.getByTestId('chip-filter-search');
    const crChipVisible = await crChip.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const crClearBtn = page.getByTestId('button-clear-all-filters');
    const crClearVisible = await crClearBtn.isVisible().catch(() => false);
    steps.push({
      name: 'ConflictResolution: search chip + Clear All Filters appear',
      passed: crChipVisible && crClearVisible,
      detail: `chip-filter-search visible=${crChipVisible}, button-clear-all-filters visible=${crClearVisible}`,
    });

    await crClearBtn.click();
    const crSearchAfter = await crSearch.inputValue();
    const crChipCountAfter = await page.getByTestId('chip-filter-search').count();
    const crClearCountAfter = await page.getByTestId('button-clear-all-filters').count();
    steps.push({
      name: 'ConflictResolution: Clear All Filters resets the search box and removes the chip/control',
      passed: crSearchAfter === '' && crChipCountAfter === 0 && crClearCountAfter === 0,
      detail: `search="${crSearchAfter}", chipCount=${crChipCountAfter}, clearButtonCount=${crClearCountAfter}`,
    });

    // ── VaultManagement ──────────────────────────────────────────────────
    await clickNavLink(page, 'data', 'link-vaults');
    const vmSearch = page.getByTestId('input-search-vaults');
    await vmSearch.waitFor({ state: 'visible', timeout: 30_000 });
    await vmSearch.fill(SEARCH_TEXT);

    const vmChip = page.getByTestId('chip-filter-search');
    const vmChipVisible = await vmChip.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const vmClearBtn = page.getByTestId('button-clear-all-filters');
    const vmClearVisible = await vmClearBtn.isVisible().catch(() => false);
    steps.push({
      name: 'VaultManagement: search chip + Clear All Filters appear',
      passed: vmChipVisible && vmClearVisible,
      detail: `chip-filter-search visible=${vmChipVisible}, button-clear-all-filters visible=${vmClearVisible}`,
    });

    await vmClearBtn.click();
    const vmSearchAfter = await vmSearch.inputValue();
    const vmChipCountAfter = await page.getByTestId('chip-filter-search').count();
    const vmClearCountAfter = await page.getByTestId('button-clear-all-filters').count();
    steps.push({
      name: 'VaultManagement: Clear All Filters resets the search box and removes the chip/control',
      passed: vmSearchAfter === '' && vmChipCountAfter === 0 && vmClearCountAfter === 0,
      detail: `search="${vmSearchAfter}", chipCount=${vmChipCountAfter}, clearButtonCount=${vmClearCountAfter}`,
    });

    // ── Evidence ─────────────────────────────────────────────────────────
    await clickNavLink(page, 'documents', 'link-evidence');
    const evSearch = page.getByTestId('input-search');
    await evSearch.waitFor({ state: 'visible', timeout: 30_000 });
    await evSearch.fill(SEARCH_TEXT);

    // Evidence's chip is gated on a debounced flag (hasActiveFilters), so
    // give the debounce window (300ms) room to settle.
    const evChip = page.getByTestId('chip-filter-search');
    const evChipVisible = await evChip.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const evClearBtn = page.getByTestId('button-clear-all-filters');
    const evClearVisible = await evClearBtn.isVisible().catch(() => false);
    steps.push({
      name: 'Evidence: search chip + Clear All Filters appear',
      passed: evChipVisible && evClearVisible,
      detail: `chip-filter-search visible=${evChipVisible}, button-clear-all-filters visible=${evClearVisible}`,
    });

    await evClearBtn.click();
    // Evidence's hasActiveFilters (and therefore this button's own visibility)
    // is gated on the DEBOUNCED search term, so it can lag the click by up to
    // the debounce window even after the raw state has been reset.
    await evClearBtn.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    const evSearchAfter = await evSearch.inputValue();
    const evChipCountAfter = await page.getByTestId('chip-filter-search').count();
    const evClearCountAfter = await page.getByTestId('button-clear-all-filters').count();
    steps.push({
      name: 'Evidence: Clear All Filters resets the search box and removes the chip/control',
      passed: evSearchAfter === '' && evChipCountAfter === 0 && evClearCountAfter === 0,
      detail: `search="${evSearchAfter}", chipCount=${evChipCountAfter}, clearButtonCount=${evClearCountAfter}`,
    });

    // ── BulkEditor ───────────────────────────────────────────────────────
    await clickNavLink(page, 'data', 'link-bulk-editor');
    const addConditionBtn = page.getByTestId('button-add-condition');
    await addConditionBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await addConditionBtn.click();

    const conditionBadge = page.getByTestId('badge-condition-count');
    const badgeVisible = await conditionBadge.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const badgeText = badgeVisible ? ((await conditionBadge.textContent()) ?? '').trim() : '';
    const clearConditionsBtn = page.getByTestId('button-clear-all-conditions');
    const clearConditionsVisible = await clearConditionsBtn.isVisible().catch(() => false);
    steps.push({
      name: 'BulkEditor: adding a condition shows the condition-count badge and Clear All control',
      passed: badgeVisible && /1\s*condition/i.test(badgeText) && clearConditionsVisible,
      detail: `badge text="${badgeText}", button-clear-all-conditions visible=${clearConditionsVisible}`,
    });

    await clearConditionsBtn.click();
    const badgeCountAfter = await page.getByTestId('badge-condition-count').count();
    const clearConditionsCountAfter = await page.getByTestId('button-clear-all-conditions').count();
    const conditionRowCountAfter = await page.getByTestId('select-field-0').count();
    const addBtnStillVisible = await addConditionBtn.isVisible().catch(() => false);
    steps.push({
      name: 'BulkEditor: Clear All removes every condition row and its own control',
      passed: badgeCountAfter === 0 && clearConditionsCountAfter === 0 && conditionRowCountAfter === 0 && addBtnStillVisible,
      detail: `badgeCount=${badgeCountAfter}, clearButtonCount=${clearConditionsCountAfter}, conditionRowCount=${conditionRowCountAfter}, addButtonVisible=${addBtnStillVisible}`,
    });
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }

  const ok = steps.every((s) => s.passed);

  console.log(`[${LABEL}] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error(`\n[${LABEL}] FAILED:`);
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    `[${LABEL}] PASSED: filter chips and Clear All controls work end-to-end on AddressReuse, ConflictResolution, VaultManagement, Evidence, and BulkEditor.`,
  );
}

main().catch((err) => {
  console.error(`[${LABEL}] ERROR:`, err && err.stack ? err.stack : err);
  process.exit(1);
});
