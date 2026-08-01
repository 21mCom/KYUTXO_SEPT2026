#!/usr/bin/env node
// Real-browser end-to-end verification for the v3 MERGE restore path,
// including real attachment FILE writes.
//
// The Node/jsdom runtime suite (v3-merge-restore.runtime.test.ts) proves the
// merge de-dup/enrich contract, but nothing exercised the restore DIALOG's
// Merge radio through `restoreV3Backup({restoreMode:"merge"})` in a real
// browser, where the attachment writer hits the real /api/attachments/write
// endpoint and browser-only regressions live (Trusted Types, streaming ZIP
// parsing, File → blobChunks plumbing).
//
// This script, in headless Chromium against the dev server:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds a "backup source" vault (shared record + attachment row + tx +
//      participant + sync state + lineage/segment/snapshot) via the live CRUD
//      singletons and exports a REAL v3 zip with `exportBackup` — including a
//      real attachment FILE entry with known bytes.
//   3. Reshapes the live vault into the merge scenario: keeps the shared
//      record/attachment/lineage (natural-key collisions), downgrades the
//      shared tx to a PLACEHOLDER (blockHeight/fee 0, blank-address
//      participant) and adds local-only rows the backup does not carry.
//   4. Puts a LOCAL-ONLY attachment file on disk that the backup does not
//      reference — a merge must NOT sweep it (only a replace restore sweeps
//      old-vault files).
//   5. Drives the ACTUAL Settings dialog: Restore → file-select (real <input
//      type=file>) → Merge radio → Continue → Restore Now, and waits for the
//      "Restore Successful … Merged with existing data" toast.
//   6. Asserts against the live Dexie DB: no duplicated records/attachments/
//      sync state, placeholder tx + participant ENRICHED from the backup,
//      local-only rows untouched.
//   7. Asserts against the real filesystem (via the attachments API): the
//      backup's attachment file was written with the exact bytes (sha-path
//      overwrite semantics) and the local-only file survived (no old-file
//      sweep in merge).
//
// Usage: node scripts/check-v3-merge-restore-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script, incl. server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'v3-merge-check-123';

// Paths unique to this check so stale files from other runs can't interfere.
// BACKUP_FILE_PATH: attachment file carried INSIDE the generated backup zip.
// LOCAL_ONLY_FILE_PATH: pre-existing on-disk file the backup does NOT
// reference — merge must leave it alone.
const BACKUP_FILE_PATH = 'ab/v3merge-check-hash.bin';
const LOCAL_ONLY_FILE_PATH = 'zz/v3merge-local-only.bin';
const BACKUP_FILE_BYTES = [7, 3, 1, 9, 4, 2];
const LOCAL_ONLY_BYTES = [42, 42, 42];

const TXID_SHARED = 'd'.repeat(64);
const TXID_LOCAL = 'e'.repeat(64);
const ADDR_SHARED = 'bc1qv3mergeshared00000000000000000000000000';
const ADDR_LOCAL = 'bc1qv3mergelocalonly0000000000000000000000';

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
      console.log(`[v3-merge-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
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

// The API requires the per-launch token (server/launch-token.ts); the page
// gets it via an injected <meta> tag. Node-side helpers scrape the same tag.
let launchTokenHeaders = null;
async function apiAuthHeaders() {
  if (!launchTokenHeaders) {
    const html = await (await fetch(BASE_URL)).text();
    const token = html.match(/name="kyutxo-launch-token" content="([^"]*)"/)?.[1];
    launchTokenHeaders = token ? { 'x-kyutxo-launch-token': token } : {};
  }
  return launchTokenHeaders;
}

// Attachments API helpers (Node side — same endpoints the web writer uses).
async function apiDeleteFile(relPath) {
  await fetch(`${BASE_URL}api/attachments/${relPath}`, { method: 'DELETE', headers: await apiAuthHeaders() }).catch(() => {});
}
async function apiWriteFile(relPath, bytes) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]));
  form.append('relativePath', relPath);
  const res = await fetch(`${BASE_URL}api/attachments/write`, { method: 'POST', body: form, headers: await apiAuthHeaders() });
  if (!res.ok) throw new Error(`write ${relPath} failed: ${res.status}`);
}
async function apiListFiles() {
  const res = await fetch(`${BASE_URL}api/attachments/list-all`, { headers: await apiAuthHeaders() });
  if (!res.ok) throw new Error(`list-all failed: ${res.status}`);
  const data = await res.json();
  return (data.files ?? []).map((f) => String(f).replace(/\\/g, '/'));
}
async function apiReadFile(relPath) {
  const res = await fetch(`${BASE_URL}api/attachments/download/${relPath}`, { headers: await apiAuthHeaders() });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

async function main() {
  const exe = resolveChromium();
  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[v3-merge-browser] dev server not up — starting `npm run dev` ...');
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

  // Clean slate for this check's on-disk files (idempotent).
  await apiDeleteFile(BACKUP_FILE_PATH);
  await apiDeleteFile(LOCAL_ONLY_FILE_PATH);

  const browser = await launchWithRetry(exe);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
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
        console.log(`[v3-merge-browser] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page);

    // ── Phase A: seed the backup-source vault and export a REAL v3 zip ──────
    const zipB64 = await page.evaluate(
      async ({ TXID_SHARED, ADDR_SHARED, BACKUP_FILE_PATH, BACKUP_FILE_BYTES }) => {
        const { bulkCreateRecords, clearAllRecords } = await import('/src/lib/data/record-crud.ts');
        const { addAttachment, clearAttachments } = await import('/src/lib/data/attachments-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants, clearTransactions, clearParticipants } =
          await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddAddressSyncState, clearAddressSyncState } =
          await import('/src/lib/data/address-sync-crud.ts');
        const {
          addUtxoLineage, addCustodySegment, addLineageSnapshot,
          clearUtxoLineage, clearCustodySegments, clearLineageSnapshots,
        } = await import('/src/lib/data/lineage-crud.ts');
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

        const [recordId] = await bulkCreateRecords(
          [{
            type: 'address',
            inputString: ADDR_SHARED,
            label: 'Shared merge-check address',
            tags: [],
            categories: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          }],
          { skipNotification: true, skipVocabularySync: true },
        );
        await addAttachment(
          {
            recordId,
            filename: 'merge-check-receipt.pdf',
            mimeType: 'application/pdf',
            size: BACKUP_FILE_BYTES.length,
            objectStoragePath: BACKUP_FILE_PATH,
            createdAt: 1_700_000_000_000,
          },
          { skipNotification: true },
        );
        await bulkAddTransactions(
          [{ txid: TXID_SHARED, blockHeight: 800_000, blockTime: 1_700_000_000, fee: 210, feeRate: 1.5, syncedAt: 1_700_000_500_000 }],
          { skipNotification: true },
        );
        await bulkAddParticipants(
          [{ txid: TXID_SHARED, role: 'output', address: ADDR_SHARED, amount: 50_000, vout: 0, recordId }],
          { skipNotification: true },
        );
        await bulkAddAddressSyncState(
          [{ address: ADDR_SHARED, recordId, lastSyncedHeight: 800_000, lastSyncedAt: 1_700_000_500_000, txCount: 1 }],
          { skipNotification: true },
        );
        await addUtxoLineage(
          {
            spentTxid: 'f'.repeat(64), spentVout: 0,
            spentAddress: 'bc1qv3mergeorigin000000000000000000000000',
            spentAmount: 60_000, consumingTxid: TXID_SHARED,
            createdTxid: TXID_SHARED, createdVout: 0,
            createdAddress: ADDR_SHARED, createdAmount: 50_000,
            spentOwned: false, createdOwned: true, isChange: false,
            confidence: 'confirmed', blockTime: 1_700_000_000, blockHeight: 800_000,
            segmentId: 'v3merge-seg-1', createdAt: 1_700_000_500_000,
          },
          { skipNotification: true },
        );
        await addCustodySegment(
          {
            segmentId: 'v3merge-seg-1', originTxid: TXID_SHARED, originVout: 0,
            originAddress: ADDR_SHARED, originDate: 1_700_000_000, originAmount: 50_000,
            currentAmount: 50_000, status: 'active', hopCount: 1,
            evidenceTxids: [TXID_SHARED], createdAt: 1_700_000_500_000, updatedAt: 1_700_000_500_000,
          },
          { skipNotification: true },
        );
        await addLineageSnapshot(
          {
            snapshotId: 'v3merge-snap-1', targetType: 'address', targetAddress: ADDR_SHARED,
            segments: ['v3merge-seg-1'], evidenceTxids: [TXID_SHARED], totalAmount: 50_000,
            earliestDate: 1_700_000_000, latestDate: 1_700_000_000, hopCount: 1,
            narrative: 'merge check snapshot', disclosureLevel: 'full', generatedAt: 1_700_000_500_000,
          },
          { skipNotification: true },
        );

        // Export a real v3 zip whose attachment FILE entry carries known bytes.
        const sink = new MemorySink();
        await exportBackup({
          sink,
          encrypted: false,
          batchSize: 25,
          attachmentIO: {
            async listAll() { return [BACKUP_FILE_PATH]; },
            async read(p) {
              return p === BACKUP_FILE_PATH ? new Uint8Array(BACKUP_FILE_BYTES).buffer : null;
            },
          },
        });
        const buf = new Uint8Array(await sink.blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return btoa(bin);
      },
      { TXID_SHARED, ADDR_SHARED, BACKUP_FILE_PATH, BACKUP_FILE_BYTES },
    );
    step('backup source seeded and real v3 zip exported', zipB64.length > 100, `${Math.round(zipB64.length * 0.75)} bytes`);

    // ── Phase B: reshape the live vault into the merge scenario ─────────────
    await page.evaluate(
      async ({ TXID_SHARED, TXID_LOCAL, ADDR_LOCAL, LOCAL_ONLY_FILE_PATH, LOCAL_ONLY_BYTES }) => {
        const { bulkCreateRecords } = await import('/src/lib/data/record-crud.ts');
        const { addAttachment } = await import('/src/lib/data/attachments-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants, clearTransactions, clearParticipants } =
          await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddAddressSyncState } = await import('/src/lib/data/address-sync-crud.ts');

        // Keep the shared record / attachment row / sync state / lineage (all
        // natural-key collisions the merge must skip), but downgrade the
        // shared tx to a PLACEHOLDER the merge must ENRICH.
        await clearTransactions({ skipNotification: true });
        await clearParticipants({ skipNotification: true });

        const [localRecordId] = await bulkCreateRecords(
          [{
            type: 'address',
            inputString: ADDR_LOCAL,
            label: 'Local-only merge-check address',
            tags: [],
            categories: [],
            createdAt: 1_700_000_100_000,
            updatedAt: 1_700_000_100_000,
          }],
          { skipNotification: true, skipVocabularySync: true },
        );
        // Local-only attachment row backed by the on-disk decoy file the
        // backup does not reference.
        await addAttachment(
          {
            recordId: localRecordId,
            filename: 'local-only-note.bin',
            mimeType: 'application/octet-stream',
            size: LOCAL_ONLY_BYTES.length,
            objectStoragePath: LOCAL_ONLY_FILE_PATH,
            createdAt: 1_700_000_100_000,
          },
          { skipNotification: true },
        );
        await bulkAddTransactions(
          [
            // Placeholder version of the SHARED tx: same txid, unresolved fields.
            { txid: TXID_SHARED, blockHeight: 0, blockTime: 0, fee: 0, feeRate: 0, syncedAt: 0 },
            // Local-only tx the backup does not carry.
            { txid: TXID_LOCAL, blockHeight: 810_000, blockTime: 1_701_000_000, fee: 100, feeRate: 1, syncedAt: 1_701_000_500_000 },
          ],
          { skipNotification: true },
        );
        await bulkAddParticipants(
          [
            // Placeholder participant for the shared tx: same vout, blank address.
            { txid: TXID_SHARED, role: 'output', address: '', amount: 0, vout: 0 },
            { txid: TXID_LOCAL, role: 'output', address: ADDR_LOCAL, amount: 10_000, vout: 0, recordId: localRecordId },
          ],
          { skipNotification: true },
        );
        await bulkAddAddressSyncState(
          [{ address: ADDR_LOCAL, recordId: localRecordId, lastSyncedHeight: 810_000, lastSyncedAt: 1_701_000_500_000, txCount: 1 }],
          { skipNotification: true },
        );
      },
      { TXID_SHARED, TXID_LOCAL, ADDR_LOCAL, LOCAL_ONLY_FILE_PATH, LOCAL_ONLY_BYTES },
    );
    // Put the local-only file on disk (the file a REPLACE would sweep).
    await apiWriteFile(LOCAL_ONLY_FILE_PATH, LOCAL_ONLY_BYTES);
    step('live vault reshaped: placeholder tx + local-only rows + local-only file on disk', true);

    // ── Phase C: drive the REAL Settings restore dialog with Merge ──────────
    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const openBtn = page.getByTestId('button-open-restore');
    await openBtn.scrollIntoViewIfNeeded();
    await openBtn.click();

    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'v3-merge-check-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipB64, 'base64'),
    });
    // Manifest peek renders the backup info card ("Records: 1").
    await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    step('file-select parsed the v3 manifest (backup info card shown)', true);

    await page.getByTestId('radio-merge').click();
    await page.getByTestId('button-continue-restore').click();
    await page.getByTestId('restore-preferences-preview').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('button-confirm-restore').click();

    // Toast: "Restore Successful" with the merge-specific suffix.
    await page.getByText('Restore Successful', { exact: false }).first().waitFor({ state: 'visible', timeout: 120_000 });
    const toastText = await page
      .locator('li[role="status"], [role="status"], .destructive, [data-radix-toast-announce-exclude]')
      .allInnerTexts()
      .then((t) => t.join(' '))
      .catch(() => '');
    const bodyText = toastText || (await page.locator('body').innerText());
    step(
      'restore toast reports merge semantics ("Merged with existing data")',
      bodyText.includes('Merged with existing data'),
      bodyText.slice(0, 200).replace(/\s+/g, ' '),
    );

    // ── Phase D: DB assertions — merged + local-only both present ──────────
    const db = await page.evaluate(
      async ({ TXID_SHARED, TXID_LOCAL, ADDR_SHARED, ADDR_LOCAL, BACKUP_FILE_PATH, LOCAL_ONLY_FILE_PATH }) => {
        const { getAllRecords } = await import('/src/lib/data/record-crud.ts');
        const { getAllAttachments } = await import('/src/lib/data/attachments-crud.ts');
        const { getTransactionsByTxids, getParticipantsByTxids } = await import('/src/lib/data/transaction-crud.ts');
        const { getAllAddressSyncState } = await import('/src/lib/data/address-sync-crud.ts');
        const { getAllUtxoLineage, getAllCustodySegments, getAllLineageSnapshots } =
          await import('/src/lib/data/lineage-crud.ts');

        const records = (await getAllRecords()).map((r) => r.inputString).sort();
        const attachments = (await getAllAttachments()).map((a) => a.objectStoragePath).sort();
        const txs = await getTransactionsByTxids([TXID_SHARED, TXID_LOCAL]);
        const shared = txs.find((t) => t.txid === TXID_SHARED) ?? null;
        const local = txs.find((t) => t.txid === TXID_LOCAL) ?? null;
        const parts = await getParticipantsByTxids([TXID_SHARED, TXID_LOCAL]);
        const sharedParts = parts.filter((p) => p.txid === TXID_SHARED);
        return {
          records,
          attachments,
          txCount: txs.length,
          sharedBlockHeight: shared?.blockHeight,
          sharedFee: shared?.fee,
          localBlockHeight: local?.blockHeight,
          sharedPartCount: sharedParts.length,
          sharedPartAddress: sharedParts[0]?.address,
          sharedPartAmount: sharedParts[0]?.amount,
          sharedPartHasRecordId: typeof sharedParts[0]?.recordId === 'number',
          syncAddresses: (await getAllAddressSyncState()).map((s) => s.address).sort(),
          lineage: (await getAllUtxoLineage()).length,
          segments: (await getAllCustodySegments()).length,
          snapshots: (await getAllLineageSnapshots()).length,
          expected: {
            records: [ADDR_LOCAL, ADDR_SHARED].sort(),
            attachments: [BACKUP_FILE_PATH, LOCAL_ONLY_FILE_PATH].sort(),
          },
        };
      },
      { TXID_SHARED, TXID_LOCAL, ADDR_SHARED, ADDR_LOCAL, BACKUP_FILE_PATH, LOCAL_ONLY_FILE_PATH },
    );

    step(
      'records de-duped by inputString, local-only record kept',
      JSON.stringify(db.records) === JSON.stringify(db.expected.records),
      db.records.join(', '),
    );
    step(
      'attachment rows de-duped by objectStoragePath, local-only row kept',
      JSON.stringify(db.attachments) === JSON.stringify(db.expected.attachments),
      db.attachments.join(', '),
    );
    step(
      'placeholder tx ENRICHED (not duplicated), local-only tx untouched',
      db.txCount === 2 && db.sharedBlockHeight === 800_000 && db.sharedFee === 210 && db.localBlockHeight === 810_000,
      `shared height=${db.sharedBlockHeight} fee=${db.sharedFee}; local height=${db.localBlockHeight}; txs=${db.txCount}`,
    );
    step(
      'placeholder participant enriched with address/amount/recordId',
      db.sharedPartCount === 1 && db.sharedPartAddress === ADDR_SHARED && db.sharedPartAmount === 50_000 && db.sharedPartHasRecordId,
      `count=${db.sharedPartCount} addr=${db.sharedPartAddress} amount=${db.sharedPartAmount}`,
    );
    step(
      'sync state de-duped by address, local-only kept',
      JSON.stringify(db.syncAddresses) === JSON.stringify([ADDR_LOCAL, ADDR_SHARED].sort()),
      db.syncAddresses.join(', '),
    );
    step(
      'lineage/segments/snapshots not doubled',
      db.lineage === 1 && db.segments === 1 && db.snapshots === 1,
      `lineage=${db.lineage} segments=${db.segments} snapshots=${db.snapshots}`,
    );

    // ── Phase E: real filesystem assertions via the attachments API ─────────
    const files = await apiListFiles();
    step(
      "backup's attachment file was written to disk by the merge",
      files.includes(BACKUP_FILE_PATH),
      files.filter((f) => f.includes('v3merge')).join(', ') || '(none)',
    );
    step(
      'local-only file was NOT swept (merge never sweeps old files)',
      files.includes(LOCAL_ONLY_FILE_PATH),
    );
    const written = await apiReadFile(BACKUP_FILE_PATH);
    step(
      'written attachment file carries the exact backup bytes (sha-path overwrite semantics)',
      !!written && written.length === BACKUP_FILE_BYTES.length && BACKUP_FILE_BYTES.every((b, i) => written[i] === b),
      written ? `[${Array.from(written).join(',')}]` : 'missing',
    );

    await context.close();
  } finally {
    await browser.close().catch(() => {});
    // Clean up this check's on-disk files.
    await apiDeleteFile(BACKUP_FILE_PATH).catch(() => {});
    await apiDeleteFile(LOCAL_ONLY_FILE_PATH).catch(() => {});
    if (devProc && devProc.pid) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[v3-merge-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; '));
    process.exit(1);
  }
  console.log('[v3-merge-browser] OK');
}

main().catch((err) => {
  console.error('[v3-merge-browser] FATAL:', err.stack || err.message);
  process.exit(1);
});
