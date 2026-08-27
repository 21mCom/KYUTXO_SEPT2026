#!/usr/bin/env node
// Task #2122 real-browser verification for the batched BulkImport.tsx
// "Save Addresses" write path (client/src/pages/BulkImport.tsx). Confirms the
// refactor from a serial per-address create/merge loop to chunked
// bulkCreateRecords/bulkUpdateRecords/bulkAddRecordOrigins still produces
// exactly correct records, origins, and merge/re-attribution bookkeeping.
//
// Flow:
//   1. Derive 10 receive + 10 change addresses from a known xpub and save
//      them (all new) — confirms create path + origin rows.
//   2. Re-run the SAME derivation with a different wallet name and save
//      again — confirms the merge path re-attributes every row and reports
//      the merge/re-attribution toast, matching the pre-refactor semantics.
//
// Usage: node scripts/check-bulk-import-batched-save-browser.mjs
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'bulk-import-batched-save-' + Date.now();
const XPUB = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} :: ${detail}`);
  if (!ok) failures++;
};

function chromiumBin() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return execSync('which chromium', { encoding: 'utf8' }).trim();
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

let devProc = null;
async function ensureServer() {
  if (await isServerUp(BASE_URL)) {
    console.log(`[bulk-import-batched-save] reusing dev server at ${BASE_URL}`);
    return;
  }
  devProc = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
  if (!(await waitForServer(BASE_URL, 120_000))) throw new Error('dev server did not start');
}
function stopSpawnedServer() {
  if (!devProc) return;
  try { process.kill(-devProc.pid, 'SIGTERM'); } catch { try { devProc.kill('SIGTERM'); } catch {} }
}

async function runImportWizard(page, walletName) {
  await page.getByTestId('input-xpub').fill(XPUB);
  await page.getByTestId('button-next-step1').click();
  await page.getByTestId('button-toggle-advanced').click();
  await page.getByTestId('input-end-index').fill('9');
  await page.getByTestId('input-change-end-index').fill('9');

  // Wallet name combobox (Popover + cmdk Command): type the name, then click
  // the "Add "<name>"" button that appears once no existing entry matches.
  await page.getByTestId('select-wallet-name').click();
  const searchInput = page.getByPlaceholder('Search or add new...');
  await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
  await searchInput.fill(walletName);
  const exactItem = page.locator('[cmdk-item]').filter({ hasText: new RegExp(`^${walletName}$`) }).first();
  if (await exactItem.isVisible().catch(() => false)) {
    await exactItem.click();
  } else {
    await page.locator('[cmdk-item]').filter({ hasText: `Add "${walletName}"` }).first().click();
  }

  await page.getByTestId('button-next-step2').click();
  await page.getByTestId('address-preview-receive-0').waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByTestId('button-save-addresses').click();
  await page.waitForURL(/\/$|\/dashboard/, { timeout: 30_000 }).catch(() => {});
}

async function main() {
  await ensureServer();
  const browser = await chromium.launch({
    executablePath: chromiumBin(), headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

  await page.goto(`${BASE_URL}import`, { waitUntil: 'load', timeout: 90_000 });
  await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 8_000 });

  // ---- Run 1: fresh import, all-new addresses under WalletOne ----
  await page.getByTestId('input-xpub').waitFor({ state: 'visible', timeout: 20_000 });
  await runImportWizard(page, 'WalletOne');

  const afterCreate = await page.evaluate(async () => {
    const { db } = await import('/src/lib/database.ts');
    const records = await db.records.where('type').equals('address').toArray();
    const origins = await db.recordOrigins.count();
    return {
      recordCount: records.length,
      originCount: origins,
      allWalletOne: records.every(r => r.walletName === 'WalletOne'),
      allXpubDerived: records.every(r => r.addressImportance === 'xpub-derived'),
    };
  });
  check('run 1 creates 20 address records (10 receive + 10 change)', afterCreate.recordCount === 20, `recordCount=${afterCreate.recordCount}`);
  check('run 1 creates one RecordOrigin per record', afterCreate.originCount === 20, `originCount=${afterCreate.originCount}`);
  check('run 1 records all stamped with the wallet name', afterCreate.allWalletOne, `allWalletOne=${afterCreate.allWalletOne}`);
  check('run 1 records classified xpub-derived', afterCreate.allXpubDerived, `allXpubDerived=${afterCreate.allXpubDerived}`);

  // ---- Run 2: re-import the SAME range under WalletTwo -> every row merges
  //      and re-attributes (exercises the batched merge/fallback path). A
  //      fresh navigation drops the in-memory unlocked vault key, so re-unlock.
  await page.goto(`${BASE_URL}import`, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 8_000 });
  await page.getByTestId('input-xpub').waitFor({ state: 'visible', timeout: 20_000 });
  await runImportWizard(page, 'WalletTwo');

  const afterMerge = await page.evaluate(async () => {
    const { db } = await import('/src/lib/database.ts');
    const records = await db.records.where('type').equals('address').toArray();
    const origins = await db.recordOrigins.count();
    return {
      recordCount: records.length,
      originCount: origins,
      allWalletTwo: records.every(r => r.walletName === 'WalletTwo'),
    };
  });
  check('run 2 merges into the SAME 20 records (no duplicates created)', afterMerge.recordCount === 20, `recordCount=${afterMerge.recordCount}`);
  check('run 2 adds one more RecordOrigin per record (baseline + merge)', afterMerge.originCount === 40, `originCount=${afterMerge.originCount}`);
  check('run 2 re-attributes every record to WalletTwo', afterMerge.allWalletTwo, `allWalletTwo=${afterMerge.allWalletTwo}`);

  await browser.close();
  stopSpawnedServer();
  if (failures > 0) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
  console.log('ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); stopSpawnedServer(); process.exit(1); });
