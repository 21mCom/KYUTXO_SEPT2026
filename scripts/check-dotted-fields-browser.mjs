#!/usr/bin/env node
// Real-browser spot-check for dots in user text fields (Task: verify dots in
// user text fields).
//
// Unit tests pin the dot-handling contracts in isolation (engine LIKE vs Dexie
// includes, csvEscape, sanitizePdfText, fundTrailFilename, pofPdfFileName),
// but nothing proves the live Vite bundle wires them together: a record whose
// label / wallet name / tag contain dots must render, be searchable, and a
// fund-trail CSV + PDF export for the dotted (trailing-dot!) wallet group
// "Alice." must download with a sane filename and intact extension.
//
// Flow (all offline, IndexedDB only):
//   1. fresh vault (fresh browser context => empty IndexedDB)
//   2. seed one owned address record with dotted label "Ledger v1.2", wallet
//      name "Alice." and tag "kyc.done", plus a wildcard decoy "Ledger v1x2",
//      and one confirmed tx funding the owned address from an external one
//      (so the Fund Trail has a source flow and its export enables)
//   3. Records page: search "v1.2" → exactly the dotted record renders (the
//      decoy proves the dot is not treated as a wildcard in the live app)
//   4. Fund Trail: group by wallet name, select "Alice.", wait for the trace,
//      export CSV and PDF; assert both downloads succeed, the suggested
//      filenames contain the dotted label and end in exactly .csv / .pdf.
//
// Usage: node scripts/check-dotted-fields-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dotted-fields-check-123';

const OWNED_ADDR = 'bc1qdottedcheckownedaddressxxxxxxxxxxxxx';
const EXTERNAL_ADDR = 'bc1qdottedcheckexternaladdressxxxxxxxxxx';
const FUND_TXID = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3';

const DOTTED_LABEL = 'Ledger v1.2';
const DECOY_LABEL = 'Ledger v1x2';
const DOTTED_WALLET = 'Alice.';
const DOTTED_TAG = 'kyc.done';

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

async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await dismissMigrationOverlayIfPresent(page);
    return false;
  }
  await pwInput.fill(SETUP_PASSWORD);
  const confirmInput = page.getByTestId('input-confirm-password');
  if (await confirmInput.isVisible().catch(() => false)) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
  return true;
}

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[dotted-fields-browser] legacy-migration overlay detected; waiting it out ...');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await overlay.isVisible().catch(() => false))) return;
    const dismiss = page.getByTestId('button-dismiss-migration');
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  throw new Error('legacy-migration overlay did not clear within 60s');
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dotted-fields-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dotted-fields-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[dotted-fields-browser] starting dev server (npm run dev) ...');
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

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[dotted-fields-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}records`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed dotted record + decoy + funding tx via live Vite singletons ────
    const seed = await page.evaluate(
      async ({ owned, external, txid, dottedLabel, decoyLabel, dottedWallet, dottedTag }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: owned,
          label: dottedLabel,
          walletName: dottedWallet,
          tags: [dottedTag],
        });
        const decoyId = await recordCrud.createRecord({
          type: 'address',
          inputString: 'bc1qdottedcheckdecoyaddressyyyyyyyyyyyyy',
          label: decoyLabel,
        });
        const blockTime = Math.floor(Date.now() / 1000) - 86400;
        await txCrud.addTransaction({
          txid,
          blockHeight: 800000,
          blockTime,
          fee: 100,
          feeRate: 1,
          syncedAt: Date.now(),
        });
        await txCrud.addParticipant({
          txid,
          role: 'input',
          address: external,
          amount: 50_000,
          vout: 0,
        });
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: owned,
          amount: 49_900,
          vout: 0,
          recordId,
        });
        return { recordId, decoyId };
      },
      {
        owned: OWNED_ADDR,
        external: EXTERNAL_ADDR,
        txid: FUND_TXID,
        dottedLabel: DOTTED_LABEL,
        decoyLabel: DECOY_LABEL,
        dottedWallet: DOTTED_WALLET,
        dottedTag: DOTTED_TAG,
      },
    );
    steps.push({
      name: 'seeded dotted record + decoy + funding tx',
      passed: Number.isInteger(seed.recordId) && Number.isInteger(seed.decoyId),
      detail: `recordId=${seed.recordId}, decoyId=${seed.decoyId}`,
    });

    // ── Records page: dotted values render + dotted search is literal ──────
    await page.goto(`${BASE_URL}records`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const searchInput = page.getByTestId('input-search');
    await searchInput.waitFor({ state: 'visible', timeout: 30_000 });
    await searchInput.fill('v1.2');

    // The dotted record must appear ...
    const dottedCell = page.getByText(DOTTED_LABEL, { exact: false }).first();
    const dottedVisible = await dottedCell
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    // ... and after the debounce settles the decoy must NOT (dot ≠ wildcard).
    await page.waitForTimeout(1_500);
    const decoyVisible = await page
      .getByText(DECOY_LABEL, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'search "v1.2" matches the dotted label literally',
      passed: dottedVisible && !decoyVisible,
      detail: `dotted visible=${dottedVisible}, decoy visible=${decoyVisible} (must be false)`,
    });

    // Trailing-dot wallet-name search.
    await searchInput.fill('Alice.');
    const walletHit = await page
      .getByText(DOTTED_LABEL, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'search "Alice." (trailing-dot wallet name) finds the record',
      passed: walletHit,
      detail: `record row visible=${walletHit}`,
    });

    // ── Fund Trail: dotted wallet group export CSV + PDF ────────────────────
    // Full reload so listGroupValues re-reads the freshly seeded record (the
    // group dropdown is a cached react-query; see fund-trail e2e notes).
    await page.goto(`${BASE_URL}fund-trail`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    await page.getByTestId('fund-trail-group-select').click();
    const groupOption = page.getByRole('option', { name: DOTTED_WALLET });
    await groupOption.waitFor({ state: 'visible', timeout: 30_000 });
    await groupOption.click();
    steps.push({
      name: 'dotted wallet group "Alice." selectable in Fund Trail',
      passed: true,
      detail: 'group option clicked',
    });

    // Trace runs automatically once a group is selected; the export button
    // enables only when the trace found at least one flow.
    const exportBtn = page.getByTestId('fund-trail-export-button');
    await exportBtn.waitFor({ state: 'visible', timeout: 60_000 });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await exportBtn.isEnabled().catch(() => false)) break;
      await page.waitForTimeout(500);
    }
    const exportEnabled = await exportBtn.isEnabled().catch(() => false);
    steps.push({
      name: 'fund-trail trace completed with flows (export enabled)',
      passed: exportEnabled,
      detail: `export button enabled=${exportEnabled}`,
    });
    if (!exportEnabled) throw new Error('fund-trail export never enabled — trace found no flows');

    async function doExport(menuTestId, wantExt) {
      // Close any lingering dropdown from a previous export, then (re)open.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const item = page.getByTestId(menuTestId);
      if (!(await item.isVisible().catch(() => false))) {
        await exportBtn.click();
      }
      await item.waitFor({ state: 'visible', timeout: 15_000 });
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        item.click(),
      ]);
      const filename = download.suggestedFilename();
      const path = await download.path();
      const size = path ? fs.statSync(path).size : 0;
      const extRe = new RegExp(`\\.${wantExt}$`);
      const singleExt = (filename.match(new RegExp(`\\.${wantExt}`, 'g')) || []).length === 1;
      return { filename, size, okExt: extRe.test(filename) && singleExt };
    }

    const csv = await doExport('fund-trail-export-csv', 'csv');
    steps.push({
      name: 'CSV export downloads with dotted label + intact .csv extension',
      passed: csv.okExt && csv.filename.includes('Alice.') && csv.size > 0,
      detail: `filename="${csv.filename}", bytes=${csv.size}`,
    });

    const pdf = await doExport('fund-trail-export-pdf', 'pdf');
    steps.push({
      name: 'PDF export downloads with dotted label + intact .pdf extension',
      passed: pdf.okExt && pdf.filename.includes('Alice.') && pdf.size > 0,
      detail: `filename="${pdf.filename}", bytes=${pdf.size}`,
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
  console.log(`[dotted-fields-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    process.exit(1);
  }
  console.log('[dotted-fields-browser] PASSED: dotted fields render, search literally, and export with sane filenames.');
}

main().catch((err) => {
  console.error('[dotted-fields-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
