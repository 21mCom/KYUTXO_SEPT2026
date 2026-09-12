#!/usr/bin/env node
// Real-browser end-to-end verification of the attachment happy paths AFTER the
// filesystem hardening (realpath symlink containment, multer size limits,
// crypto filename suffixes, restore path validation).
//
// The hardening was proven at the unit/route/IPC level; this check proves a
// legitimate user flow still works through the REAL UI in headless Chromium:
//   1. Upload a small file to a record via the record detail panel
//      (real <input type=file> → /api/attachments/upload) and confirm the
//      stored file lands inside the attachments tree with the crypto suffix.
//   2. Download it via the UI download button and verify the exact bytes.
//   3. An OVERSIZED file (> the multer cap) surfaces a clear "Upload Failed"
//      toast carrying the server's 413 message — not a silent failure — and
//      adds no attachment row.
//   4. Export a real v3 backup zip using the SAME attachment IO the Export
//      page uses (list-all + download endpoints), remove the attachment via
//      the UI, then restore the zip through the real Settings restore dialog
//      (replace mode) and confirm the restored attachment opens with the
//      exact original bytes.
//
// Usage: node scripts/check-attachment-hardening-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script, incl. server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'attach-hardening-123';

// The server-side multer cap (server/attachments.ts). Mirror its env override
// so a test-shrunk cap still exercises the same code path.
const MAX_ATTACHMENT_BYTES =
  Number(process.env.KYUTXO_MAX_ATTACHMENT_BYTES) > 0
    ? Number(process.env.KYUTXO_MAX_ATTACHMENT_BYTES)
    : 100 * 1024 * 1024;

// Checksum-valid mainnet P2WPKH address (BIP-173 test vector).
const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const PAYLOAD_TEXT = `attachment-hardening-check-payload-${Date.now()}`;
const PAYLOAD_BYTES = Array.from(new TextEncoder().encode(PAYLOAD_TEXT));
const UPLOAD_NAME = 'hardening-check-note.txt';

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
      console.log(`[attach-hardening] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
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

async function apiDeleteFile(relPath) {
  await fetch(`${BASE_URL}api/attachments/${relPath}`, { method: 'DELETE', headers: await apiAuthHeaders() }).catch(() => {});
}

// Open the seeded record's detail panel from the Dashboard.
async function openRecordPanel(page, recordId) {
  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page, SETUP_PASSWORD);
  // Dashboard defaults to the list view; the clickable record card lives in
  // the grid view.
  await page.getByTestId('button-view-grid').click();
  const card = page.getByTestId(`card-record-${recordId}`);
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.click();
  await page.getByTestId('button-show-upload').waitFor({ state: 'visible', timeout: 20_000 });
}

async function main() {
  const exe = resolveChromium();
  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[attach-hardening] dev server not up — starting `npm run dev` ...');
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
  let uploadedRelPath = null;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        loaded = true;
      } catch (err) {
        console.log(`[attach-hardening] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page, SETUP_PASSWORD);

    // ── Seed: fresh vault with one address record ───────────────────────────
    const recordId = await page.evaluate(async ({ ADDR }) => {
      const { bulkCreateRecords, clearAllRecords } = await import('/src/lib/data/record-crud.ts');
      const { clearAttachments } = await import('/src/lib/data/attachments-crud.ts');
      await clearAllRecords({ skipNotification: true });
      await clearAttachments({ skipNotification: true });
      const [id] = await bulkCreateRecords(
        [{
          type: 'address',
          inputString: ADDR,
          label: 'Attachment hardening check address',
          tags: [],
          categories: [],
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        }],
        { skipNotification: true, skipVocabularySync: true },
      );
      return id;
    }, { ADDR });
    step('seeded a fresh vault with one address record', typeof recordId === 'number', `recordId=${recordId}`);

    // ── Phase 1: UPLOAD via the real record-detail panel ─────────────────────
    const filesBefore = await apiListFiles();
    await openRecordPanel(page, recordId);
    await page.getByTestId('button-show-upload').click();
    await page.getByTestId('input-file-upload').setInputFiles({
      name: UPLOAD_NAME,
      mimeType: 'text/plain',
      buffer: Buffer.from(PAYLOAD_BYTES),
    });
    await page.getByTestId('button-upload-files').click();
    await page.getByText('Upload Complete', { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 });
    const attachmentCard = page.locator('[data-testid^="attachment-"]').first();
    await attachmentCard.waitFor({ state: 'visible', timeout: 20_000 });
    const attachmentId = (await attachmentCard.getAttribute('data-testid')).replace('attachment-', '');
    step('upload via the panel succeeded (toast + attachment row)', true, `attachment id=${attachmentId}`);

    // File landed on disk inside the attachments tree with the crypto suffix.
    const filesAfter = await apiListFiles();
    const newFiles = filesAfter.filter((f) => !filesBefore.includes(f));
    uploadedRelPath = newFiles[0] ?? null;
    step(
      'exactly one new file landed inside the attachments tree',
      newFiles.length === 1,
      newFiles.join(', ') || '(none)',
    );
    step(
      'stored filename carries the 8-hex crypto-random suffix',
      !!uploadedRelPath && /_[0-9a-f]{8}(\.[^./]*)?$/.test(uploadedRelPath),
      uploadedRelPath ?? '(missing)',
    );
    const onDisk = uploadedRelPath ? await apiReadFile(uploadedRelPath) : null;
    step(
      'on-disk bytes match the uploaded payload exactly',
      !!onDisk && onDisk.length === PAYLOAD_BYTES.length && PAYLOAD_BYTES.every((b, i) => onDisk[i] === b),
    );

    // ── Phase 2: DOWNLOAD via the UI button, verify exact bytes ─────────────
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByTestId(`button-download-${attachmentId}`).click(),
    ]);
    const dlPath = await download.path();
    const dlBytes = new Uint8Array(await fs.readFile(dlPath));
    step(
      'UI download delivers the original filename and exact bytes',
      download.suggestedFilename() === UPLOAD_NAME &&
        dlBytes.length === PAYLOAD_BYTES.length &&
        PAYLOAD_BYTES.every((b, i) => dlBytes[i] === b),
      `name=${download.suggestedFilename()} bytes=${dlBytes.length}`,
    );

    // ── Phase 3: OVERSIZED upload shows a clear rejection, not silence ──────
    // Build the too-big File IN the page (a DataTransfer on the real input →
    // real change handler) so no giant buffer crosses the CDP wire.
    const showUploadBtn = page.getByTestId('button-show-upload');
    if (await showUploadBtn.isVisible().catch(() => false)) {
      await showUploadBtn.click();
    }
    await page.getByTestId('input-file-upload').waitFor({ state: 'attached', timeout: 20_000 });
    await page.evaluate(({ cap }) => {
      const input = document.querySelector('[data-testid="input-file-upload"]');
      if (!input) throw new Error('upload input not found');
      const big = new File([new ArrayBuffer(cap + 1)], 'too-big.bin', { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(big);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { cap: MAX_ATTACHMENT_BYTES });
    await page.getByTestId('button-upload-files').click();
    await page.getByText('Upload Failed', { exact: false }).first().waitFor({ state: 'visible', timeout: 120_000 });
    const failToast = await page.locator('body').innerText();
    step('oversized upload surfaces a destructive "Upload Failed" toast', true);
    step(
      'rejection message carries the server 413 size-limit reason',
      failToast.includes('exceeds the maximum size'),
      failToast.match(/Upload Failed[\s\S]{0,140}/)?.[0]?.replace(/\s+/g, ' ') ?? '(toast text not captured)',
    );
    const rowCount = await page.locator('[data-testid^="attachment-"]').count();
    const filesAfterOversize = await apiListFiles();
    step(
      'oversized upload added no attachment row and no file on disk',
      rowCount === 1 && filesAfterOversize.length === filesAfter.length,
      `rows=${rowCount} files=${filesAfterOversize.length}`,
    );

    // ── Phase 4: export a REAL v3 zip using the Export page's attachment IO ─
    const zipB64 = await page.evaluate(async () => {
      const { exportBackup } = await import('/src/lib/backup/export.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');
      // Same IO the Export page wires up: list-all + download endpoints.
      const listAll = async () => {
        const res = await fetch('/api/attachments/list-all');
        const data = await res.json();
        return data.success ? (data.files || []) : [];
      };
      const read = async (relativePath) => {
        const res = await fetch(`/api/attachments/download/attachments/${relativePath}`);
        return res.ok ? await res.arrayBuffer() : null;
      };
      const sink = new MemorySink();
      await exportBackup({ sink, encrypted: false, batchSize: 25, attachmentIO: { listAll, read } });
      const buf = new Uint8Array(await sink.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin);
    });
    step('exported a real v3 zip carrying the attachment file', zipB64.length > 100, `${Math.round(zipB64.length * 0.75)} bytes`);

    // ── Phase 5: REMOVE the attachment via the UI ───────────────────────────
    await page.getByTestId(`button-delete-attachment-${attachmentId}`).click();
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByText('Attachment Removed', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator(`[data-testid="attachment-${attachmentId}"]`).waitFor({ state: 'detached', timeout: 20_000 });
    step('UI delete removed the attachment row with a confirmation toast', true);

    // ── Phase 6: RESTORE the zip through the real Settings dialog (replace) ─
    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD);
    const openBtn = page.getByTestId('button-open-restore');
    await openBtn.scrollIntoViewIfNeeded();
    await openBtn.click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'attachment-hardening-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipB64, 'base64'),
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('radio-replace').click();
    await page.getByTestId('button-continue-restore').click();
    await page.getByTestId('restore-preferences-preview').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('button-confirm-restore').click();
    await page.getByText('Restore Successful', { exact: false }).first().waitFor({ state: 'visible', timeout: 120_000 });
    step('replace restore of the exported zip succeeded', true);

    // ── Phase 7: restored attachment opens correctly ────────────────────────
    // A replace restore assigns fresh row ids — look the record up again.
    const restoredRecordId = await page.evaluate(async ({ ADDR }) => {
      const { getAllRecords } = await import('/src/lib/data/record-crud.ts');
      return (await getAllRecords()).find((r) => r.inputString === ADDR)?.id ?? null;
    }, { ADDR });
    step('restored vault contains the record again', typeof restoredRecordId === 'number', `id=${restoredRecordId}`);
    await openRecordPanel(page, restoredRecordId);
    const restoredCard = page.locator('[data-testid^="attachment-"]').first();
    await restoredCard.waitFor({ state: 'visible', timeout: 20_000 });
    const restoredId = (await restoredCard.getAttribute('data-testid')).replace('attachment-', '');
    const [restoredDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByTestId(`button-download-${restoredId}`).click(),
    ]);
    const restoredBytes = new Uint8Array(await fs.readFile(await restoredDownload.path()));
    step(
      'restored attachment downloads with the exact original bytes',
      restoredDownload.suggestedFilename() === UPLOAD_NAME &&
        restoredBytes.length === PAYLOAD_BYTES.length &&
        PAYLOAD_BYTES.every((b, i) => restoredBytes[i] === b),
      `name=${restoredDownload.suggestedFilename()} bytes=${restoredBytes.length}`,
    );
    const restoredOnDisk = uploadedRelPath ? await apiReadFile(uploadedRelPath) : null;
    step(
      'restore writer put the file back at its original path with exact bytes',
      !!restoredOnDisk && restoredOnDisk.length === PAYLOAD_BYTES.length && PAYLOAD_BYTES.every((b, i) => restoredOnDisk[i] === b),
      uploadedRelPath ?? '(missing)',
    );

    await context.close();
  } finally {
    await browser.close().catch(() => {});
    // Clean up this check's on-disk file (idempotent).
    if (uploadedRelPath) await apiDeleteFile(uploadedRelPath).catch(() => {});
    if (devProc && devProc.pid) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[attach-hardening] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; '));
    process.exit(1);
  }
  console.log('[attach-hardening] OK');
}

main().catch((err) => {
  console.error('[attach-hardening] FATAL:', err.stack || err.message);
  process.exit(1);
});
