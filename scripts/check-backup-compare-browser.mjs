#!/usr/bin/env node
// Real-browser end-to-end verification for the "Compare backups" feature
// (task: diff two v3 backup files from the Export page).
//
// NOTE for reviewers: the dialog under test is rendered by
// client/src/components/BackupCompareDialog.tsx, opened from the "Compare
// Backups" card on the Export page (client/src/pages/ExportPage.tsx, route
// /export). The comparison engine is client/src/lib/backup/compare.ts.
//
// The Node/jsdom suites (compare.test.ts / compare.runtime.test.ts) pin the
// diff-engine contract and the streaming-reader pipeline, but nothing else
// drives the DIALOG end to end in a real browser, where File → blobChunks
// plumbing, Trusted Types, the virtualized drill-down, and the CSV download
// actually run.
//
// This script, in headless Chromium against the dev server:
//   1. Creates a fresh vault and seeds it (3 curated records + 1 bare
//      blockchain-discovered record with discovery-only tx/participant/sync
//      state + a tag), then exports THREE real v3 zips in-page with
//      exportBackup: A (full, plaintext, pre-mutation) and C (compact).
//   2. Compares A (older) vs C (newer, compact) through the real dialog and
//      asserts the pruned discovery rows are reported as "pruned by compact
//      export", NOT as removals ("No differences found").
//   3. Mutates the vault (label edit, one delete, one add, one new tag),
//      exports B (ENCRYPTED), compares A vs B with the per-file password, and
//      asserts the summary counts (+1 added / −1 removed / ~1 changed), the
//      drill-down entries (addresses + label delta Before → After), the new
//      tag, and the CSV download.
//   4. Repeats A vs B with a WRONG password and asserts the clear per-file
//      error surfaces before any comparison runs.
//
// Usage: node scripts/check-backup-compare-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script, incl. server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'backup-compare-check-123';
const EXPORT_PASSWORD = 'compare-export-pw-123';

const ADDR_KEEP = 'bc1qcomparekeep0000000000000000000000000';
const ADDR_EDIT = 'bc1qcompareedit0000000000000000000000000';
const ADDR_GONE = 'bc1qcomparegone0000000000000000000000000';
const ADDR_DISC = 'bc1qcomparedisc0000000000000000000000000';
const ADDR_ADDED = 'bc1qcompareadded00000000000000000000000';
const TXID_KEEP = 'a'.repeat(64);
const TXID_DISC = 'b'.repeat(64);

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
      console.log(`[compare-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
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

// Seeds the check vault and exports zip A (full) + zip C (compact) in-page.
async function seedAndExportBase(page) {
  return page.evaluate(
    async ({ ADDR_KEEP, ADDR_EDIT, ADDR_GONE, ADDR_DISC, TXID_KEEP, TXID_DISC }) => {
      const { bulkCreateRecords, clearAllRecords } = await import('/src/lib/data/record-crud.ts');
      const { clearAttachments } = await import('/src/lib/data/attachments-crud.ts');
      const { bulkAddTransactions, bulkAddParticipants, clearTransactions, clearParticipants } =
        await import('/src/lib/data/transaction-crud.ts');
      const { bulkAddAddressSyncState, clearAddressSyncState } =
        await import('/src/lib/data/address-sync-crud.ts');
      const { restoreTag } = await import('/src/lib/data/vocabulary-crud.ts');
      const { exportBackup } = await import('/src/lib/backup/export.ts');
      const { computeCompactPlan } = await import('/src/lib/backup/compact.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');
      const { db } = await import('/src/lib/database.ts');

      await clearAllRecords({ skipNotification: true });
      await clearAttachments({ skipNotification: true });
      await clearTransactions({ skipNotification: true });
      await clearParticipants({ skipNotification: true });
      await clearAddressSyncState({ skipNotification: true });
      await db.tags.clear();

      const rec = (inputString, extra) => ({
        type: 'address',
        inputString,
        inputStringLower: inputString,
        tags: [],
        categories: [],
        ...extra,
      });
      const [keepId, , , discId] = await bulkCreateRecords(
        [
          rec(ADDR_KEEP, { label: 'Keep', source: 'manual', addressImportance: 'manual' }),
          rec(ADDR_EDIT, { label: 'Before', source: 'manual', addressImportance: 'manual' }),
          rec(ADDR_GONE, { label: 'Gone', source: 'manual', addressImportance: 'manual' }),
          // Bare blockchain-discovered record: prunable by the compact filter.
          rec(ADDR_DISC, {
            label: '',
            owner: 'Pending Review',
            source: 'blockchain-sync',
            syncDepth: 2,
            addressImportance: 'blockchain-discovered',
          }),
        ],
        { skipNotification: true, skipVocabularySync: true },
      );
      await bulkAddTransactions(
        [
          { txid: TXID_KEEP, blockHeight: 100, blockTime: 1_700_000_000, syncedAt: 1 },
          { txid: TXID_DISC, blockHeight: 101, blockTime: 1_700_000_600, syncedAt: 1 },
        ],
        { skipNotification: true },
      );
      await bulkAddParticipants(
        [
          { txid: TXID_KEEP, role: 'output', address: ADDR_KEEP, recordId: keepId, vout: 0 },
          { txid: TXID_DISC, role: 'output', address: ADDR_DISC, recordId: discId, vout: 0 },
        ],
        { skipNotification: true },
      );
      await bulkAddAddressSyncState(
        [
          { address: ADDR_KEEP, syncDepth: 1 },
          { address: ADDR_DISC, syncDepth: 2 },
        ],
        { skipNotification: true },
      );
      await restoreTag({ name: 'alpha', createdAt: Date.now() });

      const attachmentIO = { async listAll() { return []; }, async read() { return null; } };
      const exportZip = async (compact) => {
        const sink = new MemorySink();
        await exportBackup({
          sink,
          encrypted: false,
          compactPlan: compact ? await computeCompactPlan() : undefined,
          attachmentIO,
        });
        const buf = new Uint8Array(await sink.blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return btoa(bin);
      };
      return { zipA: await exportZip(false), zipC: await exportZip(true) };
    },
    { ADDR_KEEP, ADDR_EDIT, ADDR_GONE, ADDR_DISC, TXID_KEEP, TXID_DISC },
  );
}

// Mutates the vault (edit/delete/add/tag) and exports encrypted zip B.
async function mutateAndExportEncrypted(page) {
  return page.evaluate(
    async ({ ADDR_EDIT, ADDR_GONE, ADDR_ADDED, EXPORT_PASSWORD }) => {
      const { getRecordsByInputStrings, createRecord, updateRecord, deleteRecord } =
        await import('/src/lib/data/record-crud.ts');
      const { restoreTag } = await import('/src/lib/data/vocabulary-crud.ts');
      const { exportBackup } = await import('/src/lib/backup/export.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');

      const [edit] = await getRecordsByInputStrings([ADDR_EDIT]);
      const [gone] = await getRecordsByInputStrings([ADDR_GONE]);
      await updateRecord(edit.id, { label: 'After' }, { skipNotification: true, skipVocabularySync: true });
      await deleteRecord(gone.id, { skipNotification: true });
      await createRecord(
        { type: 'address', inputString: ADDR_ADDED, label: 'Added', tags: [], categories: [] },
        { skipNotification: true, skipVocabularySync: true },
      );
      await restoreTag({ name: 'beta', createdAt: Date.now() });

      const sink = new MemorySink();
      await exportBackup({
        sink,
        encrypted: true,
        password: EXPORT_PASSWORD,
        attachmentIO: { async listAll() { return []; }, async read() { return null; } },
      });
      const buf = new Uint8Array(await sink.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin);
    },
    { ADDR_EDIT, ADDR_GONE, ADDR_ADDED, EXPORT_PASSWORD },
  );
}

// Opens the compare dialog on /export (first comparison only — later rounds
// reuse the open dialog via its "Compare Different Files" reset).
async function openCompareDialog(page) {
  const openBtn = page.getByTestId('button-open-compare');
  await openBtn.scrollIntoViewIfNeeded();
  await openBtn.click();
  await page.getByTestId('compare-dialog').waitFor({ state: 'visible', timeout: 15_000 });
}

// Loads both files (+ optional newer password) into the OPEN dialog and runs
// the comparison.
async function runComparison(page, { zipOlder, zipNewer, newerPassword }) {
  await page.getByTestId('input-compare-older-file').setInputFiles({
    name: 'compare-older.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipOlder, 'base64'),
  });
  await page.getByTestId('input-compare-newer-file').setInputFiles({
    name: 'compare-newer.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipNewer, 'base64'),
  });
  if (newerPassword != null) {
    await page.getByTestId('input-compare-newer-password').fill(newerPassword);
  }
  await page.getByTestId('button-run-compare').click();
}

async function main() {
  const exe = resolveChromium();
  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[compare-browser] dev server not up — starting `npm run dev` ...');
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
        console.log(`[compare-browser] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page);

    // ── Phase A: seed and export full zip A + compact zip C ───────────────
    const { zipA, zipC } = await seedAndExportBase(page);
    step('vault seeded; full zip A + compact zip C exported in-page', zipA.length > 100 && zipC.length > 100);

    // ── Phase B: full vs compact comparison — pruned rows are NOT removals ──
    await page.goto(`${BASE_URL}export`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    await openCompareDialog(page);
    await runComparison(page, { zipOlder: zipA, zipNewer: zipC });
    await page.getByTestId('compare-results').waitFor({ state: 'visible', timeout: 120_000 });
    const resultsTextB = await page.getByTestId('compare-results').innerText();
    step(
      'full-vs-compact: no differences reported (compact pruning is not a removal)',
      resultsTextB.includes('No differences found'),
      resultsTextB.slice(0, 160).replace(/\s+/g, ' '),
    );
    const suppressedNote = await page
      .getByTestId('compare-suppressed-note')
      .innerText()
      .catch(() => '');
    step(
      'full-vs-compact: suppressed rows called out (Records / Transactions / sync state)',
      suppressedNote.includes('Records (1)') &&
        suppressedNote.includes('Transactions (1)') &&
        suppressedNote.includes('Address sync state (1)'),
      suppressedNote.slice(0, 220).replace(/\s+/g, ' '),
    );

    // ── Phase C: mutate, export encrypted zip B, compare A vs B ───────────
    const zipB = await mutateAndExportEncrypted(page);
    step('vault mutated; ENCRYPTED zip B exported in-page', zipB.length > 100);

    await page.getByTestId('button-compare-again').click();
    await runComparison(page, { zipOlder: zipA, zipNewer: zipB, newerPassword: EXPORT_PASSWORD });
    await page.getByTestId('compare-results').waitFor({ state: 'visible', timeout: 180_000 });

    const countText = async (testid) =>
      page.getByTestId(testid).innerText().catch(() => '');
    const [added, removed, changed] = await Promise.all([
      countText('compare-count-records-added'),
      countText('compare-count-records-removed'),
      countText('compare-count-records-changed'),
    ]);
    step(
      'records summary counts: +1 added / −1 removed / ~1 changed',
      added.includes('1') && removed.includes('1') && changed.includes('1'),
      `added="${added}" removed="${removed}" changed="${changed}"`,
    );
    const tagAdded = await countText('compare-count-tags-added');
    step('vocabulary summary: new tag reported (+1 added)', tagAdded.includes('1'), tagAdded);

    // Drill-down: entries + the field-level label delta.
    await page.getByTestId('button-toggle-records').click();
    const drill = page.getByTestId('compare-drilldown-records');
    await drill.waitFor({ state: 'visible', timeout: 15_000 });
    const drillText = await drill.innerText();
    step(
      'records drill-down lists the added/removed/changed identifiers',
      drillText.includes(ADDR_ADDED) && drillText.includes(ADDR_GONE) && drillText.includes(ADDR_EDIT),
      drillText.slice(0, 200).replace(/\s+/g, ' '),
    );
    step(
      'changed record shows the field delta (label: Before → After)',
      drillText.includes('label:') && drillText.includes('Before') && drillText.includes('After'),
    );

    // CSV export downloads a real file with the diff rows.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByTestId('button-export-compare-csv').click(),
    ]);
    const csvPath = await download.path();
    const csvText = csvPath ? await readFile(csvPath, 'utf8') : '';
    step(
      'CSV diff export downloads with the expected rows',
      download.suggestedFilename().startsWith('kyutxo-backup-diff-') &&
        csvText.includes('Table,Change,Key,Field,Old Value,New Value') &&
        csvText.includes(ADDR_ADDED) &&
        csvText.includes('Before') &&
        csvText.includes('After'),
      download.suggestedFilename(),
    );

    // ── Phase D: wrong password fails clearly before any comparison ───────
    await page.getByTestId('button-compare-again').click();
    await runComparison(page, { zipOlder: zipA, zipNewer: zipB, newerPassword: 'wrong-password-1' });
    const errAlert = page.getByTestId('compare-error');
    await errAlert.waitFor({ state: 'visible', timeout: 120_000 });
    const errText = await errAlert.innerText();
    step(
      'wrong password on the encrypted newer backup surfaces a per-file error',
      errText.includes('Newer backup: Invalid password or corrupted backup'),
      errText.slice(0, 160),
    );
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try {
        process.kill(-devProc.pid);
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n${steps.length - failed.length}/${steps.length} checks passed`);
  if (failed.length > 0) {
    console.error('FAILED checks:');
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
