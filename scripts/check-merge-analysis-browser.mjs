#!/usr/bin/env node
// Real-browser end-to-end verification for the restore dialog's MERGE PREVIEW
// (Analyze) pass.
//
// The node/jsdom suites (merge-analysis.runtime.test.ts + restore-backup-flow
// tests) prove the analyze contract and the UI wiring separately — but the UI
// tests mock analyzeV3Backup, so nothing exercised the REAL streaming analyze
// through the dialog in a real browser, where browser-only regressions live
// (Trusted Types, streaming ZIP parsing, Blob/CSV download plumbing).
//
// This script, in headless Chromium against the dev server:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds a "backup source" vault (shared + backup-only record, tx,
//      participant, sync state) via the live CRUD singletons and exports a
//      REAL v3 zip with `exportBackup`.
//   3. Reshapes the live vault so it keeps ONLY the shared rows — the backup
//      then carries exactly one addable row per table plus one duplicate.
//   4. Drives the ACTUAL Settings dialog: Restore → file-select (real <input
//      type=file>) → Analyze, and waits for the analysis results.
//   5. Asserts the per-table rows render the expected "1 new · 1 already
//      present" counts.
//   6. Clicks "Download report (CSV)" and asserts the real browser download
//      (the Blob built from report.parts) carries the CSV header + the
//      addable record — and NOT the already-present one.
//   7. Asserts the analysis was read-only: live record count unchanged.
//
// Usage: node scripts/check-merge-analysis-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script, incl. server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'merge-analysis-check-123';

const TXID_SHARED = 'a'.repeat(64);
const TXID_NEW = 'b'.repeat(64);
const ADDR_SHARED = 'bc1qmrganalysisshared0000000000000000000000';
const ADDR_NEW = 'bc1qmrganalysisbackuponly000000000000000000';
const LABEL_NEW = 'Backup-only merge-analysis record';

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
      console.log(`[merge-analysis-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
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

// Fill the setup/unlock form if it appears (unlock is per page load).
async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await dismissMigrationOverlayIfPresent(page);
    return;
  }
  await pwInput.fill(SETUP_PASSWORD);
  const confirmInput = page.getByTestId('input-confirm-password');
  if (await confirmInput.isVisible().catch(() => false)) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
}

async function main() {
  const exe = resolveChromium();
  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[merge-analysis-browser] dev server not up — starting `npm run dev` ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error('Dev server did not become ready.');
    }
  }

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const browser = await launchWithRetry(exe);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

    // Retry the initial load: under parallel validation the first goto can
    // hit a still-warming Vite pipeline.
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        loaded = true;
      } catch (err) {
        console.log(`[merge-analysis-browser] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page);

    // ── Phase A: seed the backup-source vault and export a REAL v3 zip ──────
    const zipB64 = await page.evaluate(
      async ({ TXID_SHARED, TXID_NEW, ADDR_SHARED, ADDR_NEW, LABEL_NEW }) => {
        const { bulkCreateRecords, clearAllRecords } = await import('/src/lib/data/record-crud.ts');
        const { clearAttachments } = await import('/src/lib/data/attachments-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants, clearTransactions, clearParticipants } =
          await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddAddressSyncState, clearAddressSyncState } =
          await import('/src/lib/data/address-sync-crud.ts');
        const { clearUtxoLineage, clearCustodySegments, clearLineageSnapshots } =
          await import('/src/lib/data/lineage-crud.ts');
        const { exportBackup } = await import('/src/lib/backup/export.ts');
        const { MemorySink } = await import('/src/lib/backup/sink.ts');

        // Start from a known-empty vault (fresh setup should be empty already).
        await clearAllRecords({ skipNotification: true });
        await clearAttachments({ skipNotification: true });
        await clearTransactions({ skipNotification: true });
        await clearParticipants({ skipNotification: true });
        await clearAddressSyncState({ skipNotification: true });
        await clearUtxoLineage({ skipNotification: true });
        await clearCustodySegments({ skipNotification: true });
        await clearLineageSnapshots({ skipNotification: true });

        const recordIds = await bulkCreateRecords(
          [
            {
              type: 'address',
              inputString: ADDR_SHARED,
              label: 'Shared merge-analysis record',
              tags: [],
              categories: [],
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
            },
            {
              type: 'address',
              inputString: ADDR_NEW,
              label: LABEL_NEW,
              tags: [],
              categories: [],
              createdAt: 1_700_000_001_000,
              updatedAt: 1_700_000_001_000,
            },
          ],
          { skipNotification: true, skipVocabularySync: true },
        );
        await bulkAddTransactions(
          [
            { txid: TXID_SHARED, blockHeight: 800_000, blockTime: 1_700_000_000, fee: 210, feeRate: 1.5, syncedAt: 1_700_000_500_000 },
            { txid: TXID_NEW, blockHeight: 800_100, blockTime: 1_700_000_600, fee: 140, feeRate: 1.1, syncedAt: 1_700_000_700_000 },
          ],
          { skipNotification: true },
        );
        await bulkAddParticipants(
          [
            { txid: TXID_SHARED, role: 'output', address: ADDR_SHARED, amount: 50_000, vout: 0, recordId: recordIds[0] },
            { txid: TXID_NEW, role: 'output', address: ADDR_NEW, amount: 25_000, vout: 0, recordId: recordIds[1] },
          ],
          { skipNotification: true },
        );
        await bulkAddAddressSyncState(
          [
            { address: ADDR_SHARED, recordId: recordIds[0], lastSyncedHeight: 800_000, lastSyncedAt: 1_700_000_500_000, txCount: 1 },
            { address: ADDR_NEW, recordId: recordIds[1], lastSyncedHeight: 800_100, lastSyncedAt: 1_700_000_700_000, txCount: 1 },
          ],
          { skipNotification: true },
        );

        // Export a real v3 zip.
        const sink = new MemorySink();
        await exportBackup({
          sink,
          encrypted: false,
          batchSize: 25,
          attachmentIO: {
            async listAll() { return []; },
            async read() { return null; },
          },
        });
        const buf = new Uint8Array(await sink.blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return btoa(bin);
      },
      { TXID_SHARED, TXID_NEW, ADDR_SHARED, ADDR_NEW, LABEL_NEW },
    );
    step('backup source seeded and real v3 zip exported', zipB64.length > 100, `${Math.round(zipB64.length * 0.75)} bytes`);

    // ── Phase B: reshape the live vault to keep ONLY the shared rows ────────
    const liveBefore = await page.evaluate(
      async ({ TXID_SHARED, ADDR_SHARED }) => {
        const { getAllRecords, bulkCreateRecords, clearAllRecords } =
          await import('/src/lib/data/record-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants, clearTransactions, clearParticipants } =
          await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddAddressSyncState, clearAddressSyncState } =
          await import('/src/lib/data/address-sync-crud.ts');

        await clearAllRecords({ skipNotification: true });
        await clearTransactions({ skipNotification: true });
        await clearParticipants({ skipNotification: true });
        await clearAddressSyncState({ skipNotification: true });

        const [sharedId] = await bulkCreateRecords(
          [
            {
              type: 'address',
              inputString: ADDR_SHARED,
              label: 'Shared merge-analysis record',
              tags: [],
              categories: [],
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
            },
          ],
          { skipNotification: true, skipVocabularySync: true },
        );
        await bulkAddTransactions(
          [{ txid: TXID_SHARED, blockHeight: 800_000, blockTime: 1_700_000_000, fee: 210, feeRate: 1.5, syncedAt: 1_700_000_500_000 }],
          { skipNotification: true },
        );
        await bulkAddParticipants(
          [{ txid: TXID_SHARED, role: 'output', address: ADDR_SHARED, amount: 50_000, vout: 0, recordId: sharedId }],
          { skipNotification: true },
        );
        await bulkAddAddressSyncState(
          [{ address: ADDR_SHARED, recordId: sharedId, lastSyncedHeight: 800_000, lastSyncedAt: 1_700_000_500_000, txCount: 1 }],
          { skipNotification: true },
        );
        return { recordCount: (await getAllRecords()).length };
      },
      { TXID_SHARED, ADDR_SHARED },
    );
    step('live vault reshaped to shared-rows-only', liveBefore.recordCount === 1, `records=${liveBefore.recordCount}`);

    // ── Phase C: drive the REAL Settings restore dialog's Analyze pass ──────
    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const openBtn = page.getByTestId('button-open-restore');
    await openBtn.scrollIntoViewIfNeeded();
    await openBtn.click();

    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'merge-analysis-check-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipB64, 'base64'),
    });
    // Manifest peek renders the backup info card.
    await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });

    const section = page.getByTestId('merge-analysis-section');
    await section.waitFor({ state: 'visible', timeout: 20_000 });
    step('merge-preview section rendered for the v3 backup', true);

    await page.getByTestId('button-analyze-merge').click();
    // Results replace the progress UI when the real streaming analyze finishes.
    await page.getByTestId('analysis-results').waitFor({ state: 'visible', timeout: 60_000 });
    step('real analyzeV3Backup streamed the zip and rendered results', true);

    // ── Phase D: per-table counts ────────────────────────────────────────────
    const expectRow = async (key, label) => {
      const row = page.getByTestId(`analysis-row-${key}`);
      const visible = await row.isVisible().catch(() => false);
      const text = visible ? (await row.innerText()).replace(/\s+/g, ' ') : '(missing)';
      step(
        `${label} row shows 1 new · 1 already present`,
        visible && /1 new/.test(text) && /1 already present/.test(text),
        text,
      );
    };
    await expectRow('records', 'Records');
    await expectRow('blockchainTransactions', 'Transactions');
    await expectRow('transactionParticipants', 'Participants');
    await expectRow('addressSyncState', 'Address sync state');

    // ── Phase E: CSV report download (real Blob → real browser download) ────
    const dlBtn = page.getByTestId('button-download-analysis-csv');
    const dlBtnText = (await dlBtn.innerText()).replace(/\s+/g, ' ');
    step('download button reports 1 new record', /1 new record\b/.test(dlBtnText), dlBtnText);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      dlBtn.click(),
    ]);
    const csvPath = await download.path();
    const csv = (await import('node:fs/promises')).readFile
      ? await (await import('node:fs/promises')).readFile(csvPath, 'utf8')
      : '';
    step(
      'downloaded CSV carries the header row',
      csv.startsWith('Type,Identifier,Label'),
      csv.split('\r\n')[0]?.slice(0, 60),
    );
    step(
      'downloaded CSV contains the addable record only',
      csv.includes(ADDR_NEW) && csv.includes(LABEL_NEW) && !csv.includes(ADDR_SHARED),
      `rows=${csv.trim().split('\r\n').length - 1}`,
    );
    step(
      'download filename is the merge-analysis report',
      /^kyutxo-merge-analysis-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()),
      download.suggestedFilename(),
    );

    // ── Phase F: analysis was read-only ─────────────────────────────────────
    const liveAfter = await page.evaluate(async () => {
      const { getAllRecords } = await import('/src/lib/data/record-crud.ts');
      const { getAllAddressSyncState } = await import('/src/lib/data/address-sync-crud.ts');
      return {
        recordCount: (await getAllRecords()).length,
        syncCount: (await getAllAddressSyncState()).length,
      };
    });
    step(
      'analyze pass wrote nothing to the vault (read-only)',
      liveAfter.recordCount === 1 && liveAfter.syncCount === 1,
      `records=${liveAfter.recordCount} sync=${liveAfter.syncCount}`,
    );

    // ── Phase G: ENCRYPTED backup — password gating + wrong-password safety ─
    // Export an encrypted v3 zip of the current (shared-rows-only) vault via
    // the real Argon2/Web Crypto pipeline, then drive the dialog:
    //   • Analyze stays disabled until a password is entered.
    //   • Wrong password → "Could not analyze backup" toast, no results, no writes.
    //   • Correct password → real KDF + decrypt streams the zip and renders results.
    const BACKUP_PASSWORD = 'merge-analysis-enc-pass-456';
    const encZipB64 = await page.evaluate(
      async ({ BACKUP_PASSWORD }) => {
        const { exportBackup } = await import('/src/lib/backup/export.ts');
        const { MemorySink } = await import('/src/lib/backup/sink.ts');
        const sink = new MemorySink();
        await exportBackup({
          sink,
          encrypted: true,
          password: BACKUP_PASSWORD,
          batchSize: 25,
          attachmentIO: {
            async listAll() { return []; },
            async read() { return null; },
          },
        });
        const buf = new Uint8Array(await sink.blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return btoa(bin);
      },
      { BACKUP_PASSWORD },
    );
    step('encrypted v3 zip exported (real Argon2 KDF)', encZipB64.length > 100, `${Math.round(encZipB64.length * 0.75)} bytes`);

    // Fresh dialog: reload the settings page so prior analysis state is gone.
    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    const openBtn2 = page.getByTestId('button-open-restore');
    await openBtn2.scrollIntoViewIfNeeded();
    await openBtn2.click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'merge-analysis-check-backup-encrypted.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(encZipB64, 'base64'),
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });

    // Manifest peek must flag the backup as encrypted and render the password field.
    const pwField = page.getByTestId('input-restore-password');
    const pwVisible = await pwField
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    step('encrypted backup renders the password field', pwVisible);

    await page.getByTestId('merge-analysis-section').waitFor({ state: 'visible', timeout: 20_000 });
    const analyzeBtn = page.getByTestId('button-analyze-merge');
    step('Analyze is disabled without a password', await analyzeBtn.isDisabled());

    // Wrong password: real KDF + CHECK_SENTINEL verification must reject it
    // non-destructively with the error toast and render no results.
    await pwField.fill('definitely-the-wrong-password');
    step('Analyze enables once a password is entered', await analyzeBtn.isEnabled());
    await analyzeBtn.click();
    const errToast = page.getByText('Could not analyze backup', { exact: false }).first();
    let toastDetail = '';
    const toastAppeared = await errToast
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch((e) => {
        toastDetail = String(e.message).split('\n')[0];
        return false;
      });
    step('wrong password shows the "Could not analyze backup" toast', toastAppeared, toastDetail);
    step(
      'wrong password renders no analysis results',
      !(await page.getByTestId('analysis-results').isVisible().catch(() => false)),
    );
    const liveAfterWrongPw = await page.evaluate(async () => {
      const { getAllRecords } = await import('/src/lib/data/record-crud.ts');
      const { getAllAddressSyncState } = await import('/src/lib/data/address-sync-crud.ts');
      return {
        recordCount: (await getAllRecords()).length,
        syncCount: (await getAllAddressSyncState()).length,
      };
    });
    step(
      'wrong-password analyze wrote nothing to the vault',
      liveAfterWrongPw.recordCount === 1 && liveAfterWrongPw.syncCount === 1,
      `records=${liveAfterWrongPw.recordCount} sync=${liveAfterWrongPw.syncCount}`,
    );

    // Correct password: the real KDF/decrypt path streams the zip end-to-end.
    await pwField.fill(BACKUP_PASSWORD);
    await analyzeBtn.click();
    await page.getByTestId('analysis-results').waitFor({ state: 'visible', timeout: 120_000 });
    step('correct password decrypts and renders analysis results', true);

    // ── Phase H: cancel mid-stream leaves the dialog usable ─────────────────
    // A tiny backup finishes before a cancel can land, so seed a LARGE backup
    // (thousands of rows) + a large live vault (slows the lazy merge-key set
    // load) to open a real cancel window, then assert the "Analysis Cancelled"
    // toast, the reset UI, and that a re-run Analyze completes normally.
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const LARGE_COUNT = 6000;
    const largeZipB64 = await page.evaluate(
      async ({ LARGE_COUNT }) => {
        const { bulkCreateRecords, clearAllRecords } = await import('/src/lib/data/record-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants, clearTransactions, clearParticipants } =
          await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddAddressSyncState, clearAddressSyncState } =
          await import('/src/lib/data/address-sync-crud.ts');
        const { exportBackup } = await import('/src/lib/backup/export.ts');
        const { MemorySink } = await import('/src/lib/backup/sink.ts');

        await clearAllRecords({ skipNotification: true });
        await clearTransactions({ skipNotification: true });
        await clearParticipants({ skipNotification: true });
        await clearAddressSyncState({ skipNotification: true });

        const pad = (i) => String(i).padStart(6, '0');
        const addr = (i) => `bc1qlargecancel${pad(i)}0000000000000000000000`;
        const txid = (i) => pad(i).repeat(11).slice(0, 64);

        const recs = [];
        for (let i = 0; i < LARGE_COUNT; i++) {
          recs.push({
            type: 'address',
            inputString: addr(i),
            label: `Large cancel-check record ${i} — padding padding padding padding`,
            tags: [],
            categories: [],
            createdAt: 1_700_000_000_000 + i,
            updatedAt: 1_700_000_000_000 + i,
          });
        }
        const ids = await bulkCreateRecords(recs, { skipNotification: true, skipVocabularySync: true });

        const txs = [];
        const parts = [];
        const syncs = [];
        for (let i = 0; i < LARGE_COUNT; i++) {
          txs.push({ txid: txid(i), blockHeight: 800_000 + i, blockTime: 1_700_000_000 + i, fee: 200, feeRate: 1.2, syncedAt: 1_700_000_500_000 });
          parts.push({ txid: txid(i), role: 'output', address: addr(i), amount: 10_000 + i, vout: 0, recordId: ids[i] });
          syncs.push({ address: addr(i), recordId: ids[i], lastSyncedHeight: 800_000 + i, lastSyncedAt: 1_700_000_500_000, txCount: 1 });
        }
        await bulkAddTransactions(txs, { skipNotification: true });
        await bulkAddParticipants(parts, { skipNotification: true });
        await bulkAddAddressSyncState(syncs, { skipNotification: true });

        const sink = new MemorySink();
        await exportBackup({
          sink,
          encrypted: false,
          batchSize: 25,
          attachmentIO: {
            async listAll() { return []; },
            async read() { return null; },
          },
        });
        const buf = new Uint8Array(await sink.blob.arrayBuffer());
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
        }
        return btoa(bin);
      },
      { LARGE_COUNT },
    );
    step('large backup source seeded and v3 zip exported', largeZipB64.length > 10_000, `${Math.round(largeZipB64.length * 0.75)} bytes`);

    // Reshape the live vault to a LARGE, fully-disjoint vault so the lazy
    // merge-key loads + per-batch classification take real time.
    const largeLive = await page.evaluate(async ({ LARGE_COUNT }) => {
      const { getAllRecords, bulkCreateRecords, clearAllRecords } = await import('/src/lib/data/record-crud.ts');
      const { clearTransactions, clearParticipants } = await import('/src/lib/data/transaction-crud.ts');
      const { clearAddressSyncState } = await import('/src/lib/data/address-sync-crud.ts');
      await clearAllRecords({ skipNotification: true });
      await clearTransactions({ skipNotification: true });
      await clearParticipants({ skipNotification: true });
      await clearAddressSyncState({ skipNotification: true });
      const pad = (i) => String(i).padStart(6, '0');
      const recs = [];
      for (let i = 0; i < LARGE_COUNT; i++) {
        recs.push({
          type: 'address',
          inputString: `bc1qlivecancel${pad(i)}00000000000000000000000`,
          label: `Live-only record ${i}`,
          tags: [],
          categories: [],
          createdAt: 1_690_000_000_000 + i,
          updatedAt: 1_690_000_000_000 + i,
        });
      }
      await bulkCreateRecords(recs, { skipNotification: true, skipVocabularySync: true });
      return { recordCount: (await getAllRecords()).length };
    }, { LARGE_COUNT });
    step('live vault reshaped to large disjoint vault', largeLive.recordCount === LARGE_COUNT, `records=${largeLive.recordCount}`);

    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    const openBtn3 = page.getByTestId('button-open-restore');
    await openBtn3.scrollIntoViewIfNeeded();
    await openBtn3.click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'merge-analysis-cancel-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(largeZipB64, 'base64'),
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('merge-analysis-section').waitFor({ state: 'visible', timeout: 20_000 });

    await page.getByTestId('button-analyze-merge').click();
    // Progress UI (bar + phase text + cancel button) must render mid-run.
    const progress = page.getByTestId('analysis-progress');
    await progress.waitFor({ state: 'visible', timeout: 15_000 });
    // Gate the cancel on a STREAMED table phase ("Analyzing <table>..."), not
    // the pre-stream "Reading backup file..." / "Verifying backup..." (5%)
    // phases — otherwise a cancel could land before any batch is streamed and
    // the check would not prove mid-stream cancellation.
    const phaseLoc = page.getByTestId('text-analysis-phase');
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="text-analysis-phase"]');
          return !!el && /^Analyzing /.test(el.textContent || '');
        },
        undefined,
        { timeout: 30_000 },
      );
    const phaseText = await phaseLoc.innerText().catch(() => '');
    step('analysis reached a streamed table phase mid-run', /^Analyzing /.test(phaseText), phaseText);

    // Cancel mid-stream. If the run somehow outraces the click, the results
    // panel appears instead and the assertions below fail loudly.
    await page.getByTestId('button-cancel-analysis').click();
    // .first(): Radix toasts duplicate their text into an aria-live region,
    // which trips Playwright strict mode on a bare getByText.
    const cancelToast = page.getByText('Analysis Cancelled', { exact: false }).first();
    const toastSeen = await cancelToast
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    step('"Analysis Cancelled" toast shown after mid-stream cancel', toastSeen);

    // UI resets: progress gone, no results, Analyze re-enabled.
    await progress.waitFor({ state: 'hidden', timeout: 15_000 });
    const resultsAfterCancel = await page.getByTestId('analysis-results').isVisible().catch(() => false);
    const analyzeEnabled = await page.getByTestId('button-analyze-merge').isEnabled();
    step(
      'cancel resets the dialog (no results, Analyze re-enabled)',
      !resultsAfterCancel && analyzeEnabled,
      `results=${resultsAfterCancel} analyzeEnabled=${analyzeEnabled}`,
    );

    // Re-run Analyze on the same file: must stream to completion normally.
    await page.getByTestId('button-analyze-merge').click();
    await page.getByTestId('analysis-results').waitFor({ state: 'visible', timeout: 180_000 });
    const largeRecordsRow = page.getByTestId('analysis-row-records');
    const largeRowText = (await largeRecordsRow.innerText().catch(() => '(missing)')).replace(/\s+/g, ' ');
    step(
      're-run Analyze after cancel completes normally',
      new RegExp(`${LARGE_COUNT} new`).test(largeRowText),
      largeRowText,
    );

    await context.close();
  } finally {
    await browser.close().catch(() => {});
    if (devProc && devProc.pid) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[merge-analysis-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; '));
    process.exit(1);
  }
  console.log('[merge-analysis-browser] OK');
}

main().catch((err) => {
  console.error('[merge-analysis-browser] FATAL:', err.stack || err.message);
  process.exit(1);
});
