#!/usr/bin/env node
// Real-browser regression guard for the BIP-329 label export on the Backup
// (/export) page: seeding labeled address/tx/output records and clicking the
// "Export Labels (BIP-329 .jsonl)" button must download a JSONL file whose
// lines round-trip the seeded labels ({type, ref, label, ...} per line).
//
// The vitest node check (client/src/lib/bip329.test.ts) covers the pure
// record -> line conversion; this check covers the live wiring: the Dexie
// cursor read, blob construction, and the anchor-click download in a real
// Chromium.
//
// Usage: node scripts/check-bip329-export-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const EXPORT_URL = `${BASE_URL}export`;
const SETUP_PASSWORD = 'bip329-export-check-1';

const ADDR = 'bc1qbip329exportcheckaddressxxxxxxxxxxxx';
const ADDR_LABEL = 'BIP-329 export check address';
const TXID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0aabb';
const TX_LABEL = 'BIP-329 export check tx';
const OUTPOINT = `${'b'.repeat(63)}c`.slice(0, 64) + ':1';
const OUTPUT_LABEL = 'BIP-329 export check output';
const WALLET = 'Bip329CheckWallet';
const OTHER_WALLET = 'Bip329OtherWallet';
const TAG = 'bip329checktag';
const ADDRESS_CREATED_DATE = '2024-01-10';
const ADDRESS_UPDATED_DATE = '2024-02-15';
const TX_BLOCK_DATE = '2024-02-10';
const OUTPUT_BLOCK_DATE = '2024-03-10';
const DATE_FILTER_FROM = '2024-02-01';
const DATE_FILTER_TO = '2024-02-28';
const EXACT_DATE = '2024-04-15';
const EXACT_ADDR_BEFORE = 'bc1qbip329exactbeforeaddressxxxxxxxx';
const EXACT_ADDR_START = 'bc1qbip329exactstartaddressxxxxxxxxx';
const EXACT_ADDR_END = 'bc1qbip329exactendaddressxxxxxxxxxxx';
const EXACT_ADDR_AFTER = 'bc1qbip329exactafteraddressxxxxxxxxxx';
const EXACT_ADDR_BEFORE_LABEL = 'BIP-329 exact address before';
const EXACT_ADDR_START_LABEL = 'BIP-329 exact address at start';
const EXACT_ADDR_END_LABEL = 'BIP-329 exact address at end';
const EXACT_ADDR_AFTER_LABEL = 'BIP-329 exact address after';
const EXACT_TX_BEFORE = 'c'.repeat(64);
const EXACT_TX_START = 'd'.repeat(64);
const EXACT_TX_END = 'e'.repeat(64);
const EXACT_TX_AFTER = 'f'.repeat(64);
const EXACT_TX_BEFORE_LABEL = 'BIP-329 exact tx before';
const EXACT_TX_START_LABEL = 'BIP-329 exact tx at start';
const EXACT_TX_END_LABEL = 'BIP-329 exact tx at end';
const EXACT_TX_AFTER_LABEL = 'BIP-329 exact tx after';
const COMPLEX_CSV_IDENTIFIER = 'bc1qbip329csvcomplexvalueaddressxxxxxxxx';
const COMPLEX_CSV_LABEL = 'CSV complex export, "quoted"\nlabel';
const COMPLEX_CSV_NOTES = 'Notes, with "quoted"\nline break';
const NO_MATCH_CSV_IDENTIFIER = 'bc1qbip329csvnomatchaddressxxxxxxxxxx';
const NO_MATCH_CSV_LABEL = 'CSV no-match export check';

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.');
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
      console.log(`[bip329-export-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

// Wait until the live match-count line reads "<n> labels will be exported."
async function waitForMatchCount(page, n, timeoutMs = 20_000) {
  const expected = `${n} label${n === 1 ? '' : 's'} will be exported.`;
  await page.waitForFunction(
    ({ testid, text }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`);
      return el && el.textContent && el.textContent.trim() === text;
    },
    { testid: 'text-bip329-match-count', text: expected },
    { timeout: timeoutMs }
  );
}

// Radix Select: open the trigger, pick the option by its visible name.
async function pickSelectOption(page, triggerTestId, optionName) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

function parseJsonl(content) {
  return content
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function downloadJsonl(page, exportButton) {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await exportButton.click();
  const download = await downloadPromise;
  return parseJsonl(await readFile(await download.path(), 'utf8'));
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"' && content[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

async function downloadCsv(page, exportButton) {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await exportButton.click();
  const download = await downloadPromise;
  return {
    suggestedFilename: download.suggestedFilename(),
    rows: parseCsv(await readFile(await download.path(), 'utf8')),
  };
}

function assertExactLines(actual, expected, filterName) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${filterName} export wrong: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertExactCsvRows(actual, expected, filterName) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${filterName} CSV export wrong: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[bip329-export-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[bip329-export-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[bip329-export-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[bip329-export-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(EXPORT_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'bip329-export-browser' });
    steps.push({ name: 'vault created and app unlocked', passed: true });

    // ── Seed labeled records (address, tx, output) via the app's own CRUD ───
    // The address/output records carry a wallet + tag so the filter controls
    // have something to select; vocabulary rows are created explicitly (and
    // awaited) so the dropdown options exist before the page reload below.
    // Keep the address's creation and update dates distinct, and keep the
    // transaction/UTXO record edit dates in the selected range. The date
    // filter must use the address's updatedAt and each transaction's separate
    // blockchain blockTime, not a generic record timestamp.
    await page.evaluate(
      async ({
        addr,
        addrLabel,
        txid,
        txLabel,
        outpoint,
        outputLabel,
        wallet,
        otherWallet,
        tag,
        addressCreatedDate,
        addressUpdatedDate,
        txBlockDate,
        outputBlockDate,
      }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const vocab = await import('/src/lib/data/vocabulary-crud.ts');
        const localNoon = (date) => new Date(`${date}T12:00:00`).getTime();
        const blockTime = (date) => Math.floor(localNoon(date) / 1000);
        await vocab.createWalletName(wallet);
        await vocab.createWalletName(otherWallet);
        await vocab.createTag(tag);
        await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: addrLabel,
          walletName: wallet,
          tags: [tag],
          createdAt: localNoon(addressCreatedDate),
          updatedAt: localNoon(addressUpdatedDate),
        });
        await recordCrud.createRecord({
          type: 'transaction',
          inputString: txid,
          label: txLabel,
          walletName: otherWallet,
          createdAt: localNoon(addressUpdatedDate),
          updatedAt: localNoon(addressUpdatedDate),
        });
        await recordCrud.createRecord({
          type: 'transaction',
          inputString: outpoint,
          label: outputLabel,
          notes: 'BIP-329 output at index 1. Spendable: false',
          walletName: wallet,
          tags: [tag],
          createdAt: localNoon(addressUpdatedDate),
          updatedAt: localNoon(addressUpdatedDate),
        });
        await txCrud.addTransaction({
          txid,
          blockHeight: 800000,
          blockTime: blockTime(txBlockDate),
          fee: 100,
          feeRate: 1,
          syncedAt: Date.now(),
        });
        await txCrud.addTransaction({
          txid: outpoint.split(':')[0],
          blockHeight: 800001,
          blockTime: blockTime(outputBlockDate),
          fee: 100,
          feeRate: 1,
          syncedAt: Date.now(),
        });
      },
      {
        addr: ADDR,
        addrLabel: ADDR_LABEL,
        txid: TXID,
        txLabel: TX_LABEL,
        outpoint: OUTPOINT,
        outputLabel: OUTPUT_LABEL,
        wallet: WALLET,
        otherWallet: OTHER_WALLET,
        tag: TAG,
        addressCreatedDate: ADDRESS_CREATED_DATE,
        addressUpdatedDate: ADDRESS_UPDATED_DATE,
        txBlockDate: TX_BLOCK_DATE,
        outputBlockDate: OUTPUT_BLOCK_DATE,
      }
    );
    steps.push({ name: 'seeded labeled records with distinct address timestamps and transaction block times', passed: true });

    // Reload once so the page's live queries pick up the dynamically-imported
    // writes (records, tag/wallet vocabulary) before asserting on the UI.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'bip329-export-browser' });

    // ── Click the BIP-329 export button and capture the download ────────────
    const exportButton = page.getByTestId('button-export-bip329');
    await exportButton.waitFor({ state: 'visible', timeout: 30_000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await exportButton.click();
    const download = await downloadPromise;

    const suggested = download.suggestedFilename();
    if (!/^kyutxo-labels-bip329-\d{4}-\d{2}-\d{2}\.jsonl$/.test(suggested)) {
      throw new Error(`Unexpected download filename: ${suggested}`);
    }
    const filePath = await download.path();
    const content = await readFile(filePath, 'utf8');
    steps.push({ name: `downloaded ${suggested}`, passed: true });

    // ── Verify JSONL content round-trips the seeded labels ──────────────────
    const lines = parseJsonl(content);
    const expectedAllLines = [
      { type: 'addr', ref: ADDR, label: ADDR_LABEL },
      { type: 'tx', ref: TXID, label: TX_LABEL },
      { type: 'output', ref: OUTPOINT, label: OUTPUT_LABEL, spendable: 'false' },
    ];
    assertExactLines(lines, expectedAllLines, 'unfiltered');
    steps.push({ name: 'exported JSONL contains addr/tx/output labels (spendable round-trips)', passed: true });

    // ── Filtered exports: every file must match its live count exactly ──────
    await waitForMatchCount(page, 3);
    steps.push({ name: 'live match count starts at 3 (unfiltered)', passed: true });

    await pickSelectOption(page, 'select-bip329-type', 'Addresses');
    await waitForMatchCount(page, 1);
    if (await page.getByTestId('checkbox-bip329-utxo-only').count() !== 0) {
      throw new Error('UTXO refs only checkbox should be hidden for the address kind');
    }
    assertExactLines(
      await downloadJsonl(page, exportButton),
      [expectedAllLines[0]],
      'addresses'
    );
    steps.push({ name: 'Addresses download has exactly its 1 counted label', passed: true });

    await pickSelectOption(page, 'select-bip329-type', 'Transactions');
    await waitForMatchCount(page, 1);
    const utxoOnly = page.getByTestId('checkbox-bip329-utxo-only');
    await utxoOnly.waitFor({ state: 'visible', timeout: 5_000 });
    if (await utxoOnly.isChecked()) {
      throw new Error('UTXO refs only checkbox should start unchecked');
    }
    assertExactLines(
      await downloadJsonl(page, exportButton),
      [expectedAllLines[1]],
      'transactions'
    );
    steps.push({ name: 'Transactions download has exactly its 1 counted label', passed: true });

    await utxoOnly.check();
    await waitForMatchCount(page, 1);
    if (!(await utxoOnly.isChecked())) {
      throw new Error('UTXO refs only checkbox did not become checked');
    }
    assertExactLines(
      await downloadJsonl(page, exportButton),
      [expectedAllLines[2]],
      'transactions plus UTXO refs only'
    );
    steps.push({ name: 'Transactions plus UTXO refs only download has exactly its 1 counted label', passed: true });

    await utxoOnly.uncheck();
    await waitForMatchCount(page, 1);
    if (await utxoOnly.isChecked()) {
      throw new Error('UTXO refs only checkbox did not become unchecked');
    }

    await pickSelectOption(page, 'select-bip329-type', 'Other');
    await waitForMatchCount(page, 0);
    if (await page.getByTestId('checkbox-bip329-utxo-only').count() !== 0) {
      throw new Error('UTXO refs only checkbox should be hidden for the other kind');
    }
    // "Other" records have no BIP-329 representation, so a zero-count export
    // intentionally shows the existing no-labels toast instead of downloading
    // an empty JSONL file.
    const otherDownloadPromise = page.waitForEvent('download', { timeout: 1_000 }).catch(() => null);
    await exportButton.click();
    if (await otherDownloadPromise) {
      throw new Error('Other export must not download a file when its live count is 0');
    }
    await page.getByText('No Labels To Export', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
    steps.push({ name: 'Other has 0 counted labels and downloads no empty file', passed: true });

    await pickSelectOption(page, 'select-bip329-type', 'All');
    await waitForMatchCount(page, 3);
    assertExactLines(
      await downloadJsonl(page, exportButton),
      expectedAllLines,
      'all'
    );
    steps.push({ name: 'All download has exactly its 3 counted labels', passed: true });
    steps.push({ name: 'type filter covers address / transaction / UTXO-only / other / all', passed: true });

    await pickSelectOption(page, 'select-bip329-tag', TAG);
    await waitForMatchCount(page, 2);
    await pickSelectOption(page, 'select-bip329-tag', 'All Tags');
    await waitForMatchCount(page, 3);
    steps.push({ name: 'tag filter narrows the count', passed: true });

    await pickSelectOption(page, 'select-bip329-wallet', WALLET);
    await waitForMatchCount(page, 2);
    await pickSelectOption(page, 'select-bip329-wallet', 'All Wallets');
    await waitForMatchCount(page, 3);
    steps.push({ name: 'wallet filter narrows the count', passed: true });

    await page.getByTestId('input-bip329-search').fill('export check output');
    await waitForMatchCount(page, 1);
    steps.push({ name: 'search filter narrows the count (debounced)', passed: true });

    // ── Filtered export downloads only the matching lines ───────────────────
    const filteredLines = await downloadJsonl(page, exportButton);
    assertExactLines(filteredLines, [expectedAllLines[2]], 'search-filtered');
    steps.push({ name: 'filtered export downloads only the matching label', passed: true });

    // ── Date-filtered export must match its displayed count exactly ─────────
    // This range includes the address's updatedAt and the bare transaction's
    // blockTime. The UTXO record was also edited in-range, but its transaction
    // blockTime is outside the range and must keep it out of the download.
    await page.getByTestId('input-bip329-search').fill('');
    await waitForMatchCount(page, 3);
    await page.getByTestId('input-bip329-date-range-from').fill(DATE_FILTER_FROM);
    await page.getByTestId('input-bip329-date-range-to').fill(DATE_FILTER_TO);
    await waitForMatchCount(page, 2);
    assertExactLines(
      await downloadJsonl(page, exportButton),
      [expectedAllLines[0], expectedAllLines[1]],
      'date-range'
    );
    steps.push({ name: 'date-range download has exactly its 2 counted labels', passed: true });

    // ── Clear filters restores the full set ─────────────────────────────────
    await page.getByTestId('button-bip329-clear-filters').click();
    await waitForMatchCount(page, 3);
    steps.push({ name: 'clear filters restores the unfiltered count', passed: true });

    // ── Exact-date boundaries use the local calendar day inclusively ─────────
    // Add a separate fixture set after the earlier assertions so the existing
    // filter checks remain isolated from these boundary rows. Address records
    // use updatedAt (milliseconds); transaction records use their separately
    // stored blockTime (Unix seconds). Each kind has rows immediately before,
    // at both inclusive boundaries, and immediately after the target day.
    await page.evaluate(
      async ({
        exactDate,
        addresses,
        transactions,
      }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const localMillis = (date, time) => new Date(`${date}T${time}`).getTime();
        const exactDay = [
          localMillis(exactDate, '00:00:00.000'),
          localMillis(exactDate, '23:59:59.999'),
        ];
        for (const address of addresses) {
          await recordCrud.createRecord({
            type: 'address',
            inputString: address.ref,
            label: address.label,
            createdAt: address.updatedAt,
            updatedAt: address.updatedAt,
          });
        }
        for (const transaction of transactions) {
          await recordCrud.createRecord({
            type: 'transaction',
            inputString: transaction.txid,
            label: transaction.label,
            createdAt: localMillis(exactDate, '12:00:00.000'),
            updatedAt: localMillis(exactDate, '12:00:00.000'),
          });
          await txCrud.addTransaction({
            txid: transaction.txid,
            blockHeight: transaction.blockHeight,
            blockTime: transaction.blockTime,
            fee: 0,
            feeRate: 0,
            syncedAt: Date.now(),
          });
        }
        if (exactDay[0] >= exactDay[1]) {
          throw new Error('Exact-date fixture boundaries must be ordered');
        }
      },
      {
        exactDate: EXACT_DATE,
        addresses: [
          {
            ref: EXACT_ADDR_BEFORE,
            label: EXACT_ADDR_BEFORE_LABEL,
            updatedAt: new Date(`${EXACT_DATE}T00:00:00.000`).getTime() - 1,
          },
          {
            ref: EXACT_ADDR_START,
            label: EXACT_ADDR_START_LABEL,
            updatedAt: new Date(`${EXACT_DATE}T00:00:00.000`).getTime(),
          },
          {
            ref: EXACT_ADDR_END,
            label: EXACT_ADDR_END_LABEL,
            updatedAt: new Date(`${EXACT_DATE}T23:59:59.999`).getTime(),
          },
          {
            ref: EXACT_ADDR_AFTER,
            label: EXACT_ADDR_AFTER_LABEL,
            updatedAt: new Date(`${EXACT_DATE}T23:59:59.999`).getTime() + 1,
          },
        ],
        transactions: [
          {
            txid: EXACT_TX_BEFORE,
            label: EXACT_TX_BEFORE_LABEL,
            blockHeight: 800010,
            blockTime: Math.floor(new Date(`${EXACT_DATE}T00:00:00.000`).getTime() / 1000) - 1,
          },
          {
            txid: EXACT_TX_START,
            label: EXACT_TX_START_LABEL,
            blockHeight: 800011,
            blockTime: Math.floor(new Date(`${EXACT_DATE}T00:00:00.000`).getTime() / 1000),
          },
          {
            txid: EXACT_TX_END,
            label: EXACT_TX_END_LABEL,
            blockHeight: 800012,
            blockTime: Math.floor(new Date(`${EXACT_DATE}T23:59:59.999`).getTime() / 1000),
          },
          {
            txid: EXACT_TX_AFTER,
            label: EXACT_TX_AFTER_LABEL,
            blockHeight: 800013,
            blockTime: Math.floor(new Date(`${EXACT_DATE}T23:59:59.999`).getTime() / 1000) + 1,
          },
        ],
      }
    );
    steps.push({ name: 'seeded local exact-date boundary address and transaction fixtures', passed: true });

    // Reload once so the page's live queries see the boundary fixture writes
    // and the date controls start from a clean, unfiltered state.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'bip329-export-browser' });
    const exactExportButton = page.getByTestId('button-export-bip329');
    await exactExportButton.waitFor({ state: 'visible', timeout: 30_000 });
    await waitForMatchCount(page, 11);

    const exactToggle = page.getByTestId('checkbox-bip329-date-range-exact');
    await exactToggle.check();
    if (!(await exactToggle.isChecked())) {
      throw new Error('Exact date checkbox did not become checked');
    }
    await page.getByTestId('input-bip329-date-range-date').fill(EXACT_DATE);
    await waitForMatchCount(page, 4);

    const exactExpectedLines = [
      { type: 'addr', ref: EXACT_ADDR_START, label: EXACT_ADDR_START_LABEL },
      { type: 'addr', ref: EXACT_ADDR_END, label: EXACT_ADDR_END_LABEL },
      { type: 'tx', ref: EXACT_TX_START, label: EXACT_TX_START_LABEL },
      { type: 'tx', ref: EXACT_TX_END, label: EXACT_TX_END_LABEL },
    ];
    assertExactLines(
      await downloadJsonl(page, exactExportButton),
      exactExpectedLines,
      'exact-date'
    );
    steps.push({ name: 'exact-date count and download include only inclusive same-day boundaries', passed: true });

    // ── CSV exact-date boundaries use the same local calendar day ────────────
    // The CSV controls are independent from BIP-329. Reuse the isolated
    // boundary fixture set above, but assert the CSV count and downloaded rows
    // separately so a CSV-only date-filter wiring regression is caught.
    const csvExportButton = page.getByTestId('button-export-csv');
    await csvExportButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="text-csv-match-count"]')?.textContent?.trim() ===
        '11 records will be exported.',
      { timeout: 30_000 }
    );

    // ── CSV search changes must export the current query immediately ─────────
    // The live count intentionally debounces the search input. Start with one
    // distinct label, then type a second distinct label and click before the
    // count can catch up. The download must use the newly typed query rather
    // than the stale query represented by the still-visible count.
    const csvSearch = page.getByTestId('input-csv-search');
    await csvSearch.fill(ADDR_LABEL);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="text-csv-match-count"]')?.textContent?.trim() ===
        '1 record will be exported.',
      { timeout: 30_000 }
    );
    await csvSearch.fill(OUTPUT_LABEL);
    const staleCsvCount = await page.getByTestId('text-csv-match-count').textContent();
    if (staleCsvCount?.trim() !== '1 record will be exported.') {
      throw new Error(`CSV search debounce did not remain pending; saw count ${JSON.stringify(staleCsvCount)}`);
    }
    const fastCsvDownload = await downloadCsv(page, csvExportButton);
    assertExactCsvRows(
      fastCsvDownload.rows,
      [
        ['Type', 'Identifier', 'Label', 'Wallet', 'Owner', 'Tags', 'Categories', 'Notes', 'Amount', 'Date'],
        ['utxo', OUTPOINT, OUTPUT_LABEL, WALLET, '', TAG, '', 'BIP-329 output at index 1. Spendable: false', '', ''],
      ],
      'fast search-change'
    );
    steps.push({ name: 'fast CSV search change exports only the newly typed label before the count debounce completes', passed: true });

    await csvSearch.fill('');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="text-csv-match-count"]')?.textContent?.trim() ===
        '11 records will be exported.',
      { timeout: 30_000 }
    );

    const csvExactToggle = page.getByTestId('checkbox-csv-date-range-exact');
    await csvExactToggle.check();
    if (!(await csvExactToggle.isChecked())) {
      throw new Error('CSV exact date checkbox did not become checked');
    }
    await page.getByTestId('input-csv-date-range-date').fill(EXACT_DATE);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="text-csv-match-count"]')?.textContent?.trim() ===
        '4 records will be exported.',
      { timeout: 30_000 }
    );

    const csvDownload = await downloadCsv(page, csvExportButton);
    if (!/^kyutxo-records-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDownload.suggestedFilename)) {
      throw new Error(`Unexpected CSV download filename: ${csvDownload.suggestedFilename}`);
    }
    const csvExpectedRows = [
      ['Type', 'Identifier', 'Label', 'Wallet', 'Owner', 'Tags', 'Categories', 'Notes', 'Amount', 'Date'],
      ['address', EXACT_ADDR_START, EXACT_ADDR_START_LABEL, '', '', '', '', '', '', ''],
      ['address', EXACT_ADDR_END, EXACT_ADDR_END_LABEL, '', '', '', '', '', '', ''],
      ['transaction', EXACT_TX_START, EXACT_TX_START_LABEL, '', '', '', '', '', '', ''],
      ['transaction', EXACT_TX_END, EXACT_TX_END_LABEL, '', '', '', '', '', '', ''],
    ];
    assertExactCsvRows(csvDownload.rows, csvExpectedRows, 'exact-date');
    steps.push({ name: 'CSV exact-date count and download include only inclusive same-day boundaries', passed: true });

    // ── Filtered CSV preserves commas, quotes, and line breaks ─────────────
    // Seed this fixture after the other CSV assertions so it cannot alter their
    // expected counts. The parsed download must retain the exact decoded cell
    // values, not merely have the right number of rows.
    await page.evaluate(
      async ({ inputString, label, notes }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const now = Date.now();
        await recordCrud.createRecord({
          type: 'address',
          inputString,
          label,
          notes,
          createdAt: now,
          updatedAt: now,
        });
      },
      {
        inputString: COMPLEX_CSV_IDENTIFIER,
        label: COMPLEX_CSV_LABEL,
        notes: COMPLEX_CSV_NOTES,
      }
    );

    // Reload once so the CSV live count sees the dynamically imported record.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'bip329-export-browser' });
    const complexCsvExportButton = page.getByTestId('button-export-csv');
    await complexCsvExportButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('input-csv-search').fill('CSV complex export');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="text-csv-match-count"]')?.textContent?.trim() ===
        '1 record will be exported.',
      { timeout: 30_000 }
    );

    const complexCsvDownload = await downloadCsv(page, complexCsvExportButton);
    if (!/^kyutxo-records-\d{4}-\d{2}-\d{2}\.csv$/.test(complexCsvDownload.suggestedFilename)) {
      throw new Error(`Unexpected complex CSV download filename: ${complexCsvDownload.suggestedFilename}`);
    }
    assertExactCsvRows(
      complexCsvDownload.rows,
      [
        ['Type', 'Identifier', 'Label', 'Wallet', 'Owner', 'Tags', 'Categories', 'Notes', 'Amount', 'Date'],
        ['address', COMPLEX_CSV_IDENTIFIER, COMPLEX_CSV_LABEL, '', '', '', '', COMPLEX_CSV_NOTES, '', ''],
      ],
      'complex-value-filtered'
    );
    steps.push({ name: 'filtered CSV preserves exact comma, quote, and line-break cell values', passed: true });

    // ── Filtered CSV with no matches must stay download-free ────────────────
    // Seed one more record through the browser's live CRUD path, then reload
    // so the export page's live count observes it. The deliberately impossible
    // search proves the zero-row early return does not create an empty file or
    // show the success toast.
    await page.evaluate(
      async ({ inputString, label }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const now = Date.now();
        await recordCrud.createRecord({
          type: 'address',
          inputString,
          label,
          createdAt: now,
          updatedAt: now,
        });
      },
      {
        inputString: NO_MATCH_CSV_IDENTIFIER,
        label: NO_MATCH_CSV_LABEL,
      }
    );

    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'bip329-export-browser' });
    const noMatchCsvExportButton = page.getByTestId('button-export-csv');
    await noMatchCsvExportButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('input-csv-search').fill('CSV filter value that cannot match any record');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="text-csv-match-count"]')?.textContent?.trim() ===
        '0 records will be exported.',
      { timeout: 30_000 }
    );

    const noMatchDownloadPromise = page.waitForEvent('download', { timeout: 2_000 }).catch(() => null);
    await noMatchCsvExportButton.click();
    if (await noMatchDownloadPromise) {
      throw new Error('No-match CSV export must not download an empty file');
    }
    await page.getByText('No Records To Export', { exact: true }).first().waitFor({
      state: 'visible',
      timeout: 5_000,
    });
    await page.getByText(
      'No records match the current filters. Adjust or clear the filters and try again.',
      { exact: true }
    ).first().waitFor({ state: 'visible', timeout: 5_000 });
    if (await page.getByText('CSV Exported', { exact: true }).count() > 0) {
      throw new Error('No-match CSV export must not report a successful export');
    }
    steps.push({ name: 'filtered CSV with 0 matches downloads no file and explains how to adjust or clear filters', passed: true });

    console.log('\n[bip329-export-browser] all steps passed:');
    for (const s of steps) console.log(`  ✓ ${s.name}`);
  } finally {
    await browser.close().catch(() => {});
    if (startedServer && devProc && devProc.pid) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[bip329-export-browser] FAILED: ${err.stack || err.message}`);
    process.exit(1);
  }
);
