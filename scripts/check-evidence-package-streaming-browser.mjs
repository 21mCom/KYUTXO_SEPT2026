#!/usr/bin/env node
// Real-browser end-to-end guard for Task #2116: streaming a large SELECTED
// evidence package straight to disk instead of buffering it in memory.
//
// client/src/lib/evidence-package-export.test.ts already proves (in Node,
// with fake attachment bytes) that buildEvidencePackageToSink produces a
// byte-identical archive to the in-memory builder and bypasses the 75 MiB
// AGGREGATE cap while still enforcing the 25 MiB PER-FILE cap. That test
// cannot exercise the real UI wiring: the opt-in toggle, the native
// save-dialog seams (File System Access API / Electron backup bridge), real
// uploaded attachment bytes flowing through attachments.ts, and safe
// cancellation of a real in-flight stream. This script covers exactly that,
// in headless Chromium against the dev server, with a selection whose total
// size genuinely exceeds the in-memory cap.
//
// Flow:
//   Context A (browser / File System Access API path):
//     1. Shim window.showSaveFilePicker with a fake writable that records
//        every chunk, and stub URL.createObjectURL so a Blob-download
//        fallback would be visibly detected.
//     2. Seed one evidence item with FOUR real ~20 MiB attachments (80 MiB
//        total) via the app's own upload path — each file is under the 25
//        MiB per-file cap, but the total is over the 75 MiB in-memory cap.
//     3. With the "Stream to disk" toggle ON: export succeeds, all bytes
//        land in the fake writable (not a Blob download), and the success
//        toast reports all 4 attachments.
//     4. With the toggle OFF: exporting the SAME oversized selection is
//        refused by the in-memory cap, and the error explicitly mentions
//        turning on streaming.
//     5. Cancellation: start a streamed export, click Cancel mid-flight —
//        the fake writable is aborted (never closed) and no success toast
//        appears.
//     6. Mid-stream disk write failure: make the fake writable's write()
//        reject partway through (simulating a full disk or a permission
//        revoked after the picker was confirmed) — the sink is aborted
//        (never closed), no success toast appears, and a destructive
//        failure toast is shown.
//   Context B (Electron backup-bridge path):
//     7. Shim window.electronAPI (isElectron + backupOpen/Write/Close/Abort
//        + saveAttachment/readAttachment backed by an in-memory map) AND a
//        File System Access shim, to prove Electron is preferred when both
//        are available. Seed the same oversized 80 MiB selection through the
//        Electron upload path and confirm the export streams through the
//        Electron sink (not the filesystem one) and succeeds.
//
// Usage: node scripts/check-evidence-package-streaming-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';
import { buildEngineBridgeInitScript } from './engine-bridge-mock.mjs';

await acquireBrowserCheckLock();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const EXPORT_URL = `${BASE_URL}export`;
const SETUP_PASSWORD_A = 'evidence-stream-browser-check-a-123';
const SETUP_PASSWORD_B = 'evidence-stream-browser-check-b-123';

const ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20 MiB — under the 25 MiB per-file cap
const ATTACHMENT_COUNT = 4; // 80 MiB total — over the 75 MiB aggregate cap
const TOTAL_SIZE = ATTACHMENT_SIZE * ATTACHMENT_COUNT;
const AGGREGATE_CAP = 75 * 1024 * 1024;
const ENGINE_SHIM = buildEngineBridgeInitScript({
  alwaysEnabled: true,
  queryHandlers: '// This check does not serve engine queries.',
});

// ── window shims (installed via addInitScript, run before any app code) ────

// File System Access API shim: showSaveFilePicker -> fake handle whose
// createWritable() records every chunk written, and can simulate an abort.
// window.__evidenceStreamDelayMs adds a per-chunk delay so a test can win the
// cancel-timing race against a fast synthetic stream.
const FS_ACCESS_SHIM = `
(() => {
  window.__fsWrites = [];
  window.__fsClosed = false;
  window.__fsAborted = false;
  window.__fsSuggestedName = null;
  window.__evidenceStreamDelayMs = 0;
  window.__createObjectURLCalls = 0;
  // Fails write() once the writable has already accepted this many chunks,
  // simulating a real mid-stream disk failure (disk full, permission
  // revoked) rather than an immediate rejection on the first byte. null
  // disables the failure injection.
  window.__evidenceStreamFailAfterWrites = null;
  window.__evidenceStreamWriteErrorMessage = 'Simulated disk write failure';
  const realCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (...args) => {
    window.__createObjectURLCalls++;
    return realCreateObjectURL(...args);
  };
  window.showSaveFilePicker = async (opts) => {
    window.__fsSuggestedName = opts && opts.suggestedName;
    return {
      createWritable: async () => ({
        write: async (chunk) => {
          if (window.__evidenceStreamDelayMs > 0) {
            await new Promise((r) => setTimeout(r, window.__evidenceStreamDelayMs));
          }
          if (
            window.__evidenceStreamFailAfterWrites != null &&
            window.__fsWrites.length >= window.__evidenceStreamFailAfterWrites
          ) {
            throw new Error(window.__evidenceStreamWriteErrorMessage);
          }
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          window.__fsWrites.push(bytes.length);
        },
        close: async () => { window.__fsClosed = true; },
        abort: async () => { window.__fsAborted = true; },
      }),
    };
  };
})();
`;

// Electron backup-bridge shim, layered with a full electronAPI stub (borrowed
// shape from check-about-electron-version-browser.mjs) so app init never
// throws on a missing IPC channel. saveAttachment/readAttachment are backed
// by an in-memory Map so seeding 80 MiB of real attachment bytes never
// touches the network.
const ELECTRON_SHIM = `
(() => {
  window.__electronWrites = [];
  window.__electronClosed = false;
  window.__electronAborted = false;
  window.__electronBackupOpenCalls = 0;
  window.__evidenceStreamDelayMs = 0;
  window.__createObjectURLCalls = 0;
  const realCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (...args) => {
    window.__createObjectURLCalls++;
    return realCreateObjectURL(...args);
  };
  // Also present (but must stay UNUSED when Electron is available) so the
  // "Electron is preferred" assertion is meaningful.
  window.__fsShimCalls = 0;
  window.showSaveFilePicker = async () => {
    window.__fsShimCalls++;
    throw Object.assign(new Error('should not be called'), { name: 'AbortError' });
  };

  // A plain in-memory Map here would be wiped by the deliberate page reload
  // between seeding and export (the shim script re-runs fresh on every
  // navigation), so back the fake "Electron disk" with a dedicated IndexedDB
  // database instead — that's real per-origin storage and survives reloads
  // just like the app's own Dexie database does.
  let attachmentSeq = 0;
  const shimDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('electron-shim-attachments', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function shimPut(path, arrayBuffer) {
    const db = await shimDbPromise;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(arrayBuffer, path);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function shimGet(path) {
    const db = await shimDbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').get(path);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  window.electronAPI = {
    ...window.electronAPI,
    isElectron: true,
    electronVersion: '43.4.0',
    platform: 'linux',
    isPortableMode: async () => false,
    torStatus: async () => ({ running: false }),
    torTest: async () => ({ success: false }),
    torRequest: async () => ({ success: false }),
    torUpdateSettings: async () => ({}),
    getDiskSpace: async () => ({ free: 1e12, total: 2e12 }),
    getAttachmentsSize: async () => 0,
    checkDemoVault: async () => ({ found: false }),
    readDemoVault: async () => ({ done: true, chunk: [] }),
    saveAttachment: async (hashedId, opaqueFilename, arrayBuffer) => {
      const path = 'shim-attachment-' + (++attachmentSeq) + '-' + opaqueFilename;
      await shimPut(path, arrayBuffer);
      return { success: true, path };
    },
    readAttachment: async (path) => {
      const data = await shimGet(path);
      if (!data) return { success: false, error: 'not found' };
      return { success: true, data };
    },
    deleteAttachment: async () => ({ success: true }),
    listAttachments: async () => [],
    listAllAttachments: async () => [],
    writeAttachment: async () => ({ ok: true }),
    renameAttachment: async () => ({ ok: true }),
    writeNeedsReview: async () => ({ ok: true }),
    openNeedsReviewFolder: async () => {},
    listNeedsReview: async () => [],
    readNeedsReview: async () => ({ ok: true, data: [] }),
    deleteNeedsReview: async () => ({ ok: true }),
    backupOpen: async () => {
      window.__electronBackupOpenCalls++;
      return { success: true, id: 'evidence-stream-shim' };
    },
    backupWrite: async (id, buf) => {
      if (window.__evidenceStreamDelayMs > 0) {
        await new Promise((r) => setTimeout(r, window.__evidenceStreamDelayMs));
      }
      const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf);
      window.__electronWrites.push(bytes.length);
      return { success: true };
    },
    backupClose: async () => { window.__electronClosed = true; return { success: true }; },
    backupAbort: async () => { window.__electronAborted = true; return { success: true }; },
    electrumTest: async () => ({ success: false }),
    electrumGetHistory: async () => ({ success: false, history: [] }),
    electrumGetUtxos: async () => ({ success: false, utxos: [] }),
    electrumGetTransaction: async () => ({ success: false }),
    electrumGetBlockHash: async () => ({ success: false }),
    electrumCancel: async () => ({ success: true }),
    electrumBatchGetHistory: async () => ({ success: false }),
    electrumBatchGetUtxos: async () => ({ success: false }),
    electrumTrustCertificate: async () => ({ success: true }),
    electrumGetCertificateTrust: async () => ({ trusted: false }),
    electrumRevokeCertificate: async () => ({ success: true }),
  };
})();
`;

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
      console.log(`[evidence-stream] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

// Seeds one evidence item with ATTACHMENT_COUNT real attachments of
// ATTACHMENT_SIZE bytes each, via the app's own upload path (attachments.ts),
// so the export builder reads and hashes genuine stored bytes. Returns the
// evidence id and the record id used as the export selection input.
async function seedOversizedEvidence(page, { title, attachmentSize, attachmentCount }) {
  return await page.evaluate(
    async ({ title, attachmentSize, attachmentCount }) => {
      const evCrud = await import('/src/lib/data/evidence-crud.ts');
      const attachments = await import('/src/lib/attachments.ts');

      const evidenceId = await evCrud.addEvidence({ title, documentType: 'other', tags: [] });
      const attachmentIds = [];
      for (let i = 0; i < attachmentCount; i++) {
        // Deterministic non-zero bytes (cheap, avoids an all-zero buffer that
        // some compressors could special-case) without a slow per-byte loop.
        const buf = new Uint8Array(attachmentSize);
        const word = new Uint32Array(buf.buffer);
        for (let w = 0; w < word.length; w++) word[w] = (w * 2654435761 + i) >>> 0;
        const filename = `evidence-stream-fixture-${i}.bin`;
        const file = new File([buf], filename, { type: 'application/octet-stream' });
        const storagePath = await attachments.uploadFile(file);
        const attachmentId = await evCrud.addEvidenceAttachment({
          evidenceId,
          filename,
          mimeType: 'application/octet-stream',
          size: attachmentSize,
          objectStoragePath: storagePath,
        });
        attachmentIds.push(attachmentId);
      }
      return { evidenceId, attachmentIds };
    },
    { title, attachmentSize, attachmentCount },
  );
}

async function main() {
  const exe = resolveChromium();
  console.log(`[evidence-stream] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[evidence-stream] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[evidence-stream] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
  }

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const browser = await launchWithRetry(exe);
  try {
    // ═══════════════ Context A: File System Access API path ═══════════════
    console.log('\n[evidence-stream] === Context A: browser File System Access streaming ===');
    {
      const context = await browser.newContext();
      await context.addInitScript(FS_ACCESS_SHIM);
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log(`[evidence-stream][page-error] ${e.message}`));

      let loaded = false;
      for (let i = 0; i < 3 && !loaded; i++) {
        try {
          await page.goto(EXPORT_URL, { waitUntil: 'load', timeout: 60_000 });
          loaded = true;
        } catch (e) {
          console.log(`[evidence-stream] goto retry ${i + 1}: ${e.message}`);
          await page.waitForTimeout(3_000);
        }
      }
      if (!loaded) throw new Error('app never loaded (context A)');
      await unlockIfNeeded(page, SETUP_PASSWORD_A);

      console.log(`[evidence-stream] seeding ${attachmentCountLabel()} ...`);
      const seed = await seedOversizedEvidence(page, {
        title: 'Streaming fixture (browser)',
        attachmentSize: ATTACHMENT_SIZE,
        attachmentCount: ATTACHMENT_COUNT,
      });
      step('seeded oversized evidence with real uploaded attachments (browser)', typeof seed.evidenceId === 'number' && seed.attachmentIds.length === ATTACHMENT_COUNT, `evidenceId=${seed.evidenceId} attachments=${seed.attachmentIds.length}`);

      // The evidence checklist reads via useLiveQuery at mount; the dynamic
      // imports above wrote through a separate Dexie connection, so reload
      // once to guarantee the new row is visible before interacting with it.
      // A full navigation also drops the in-memory vault key, so re-unlock.
      await page.goto(EXPORT_URL, { waitUntil: 'load', timeout: 60_000 });
      await unlockIfNeeded(page, SETUP_PASSWORD_A);

      const checkbox = page.getByTestId(`checkbox-evidence-${seed.evidenceId}`);
      await checkbox.waitFor({ state: 'visible', timeout: 20_000 });
      await checkbox.check();

      const streamToggle = page.getByTestId('switch-package-stream-to-disk');
      await streamToggle.waitFor({ state: 'visible', timeout: 10_000 });
      const toggleDisabled = await streamToggle.getAttribute('data-disabled');
      step('streaming toggle is enabled (File System Access API shimmed)', toggleDisabled === null, `data-disabled="${toggleDisabled}"`);

      // ── A1: streaming ON succeeds with the oversized (80 MiB) selection ──
      await streamToggle.click();
      await page.getByTestId('button-export-evidence-package').click();

      const successToast = page.getByText(/Evidence package exported/i).first();
      const sawSuccess = await successToast.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false);
      step('[A1] streamed export of an 80 MiB selection succeeds', sawSuccess);

      if (sawSuccess) {
        const savedToast = page.getByText(/saved to/i).first();
        step('[A1] success toast says the file was saved (not downloaded)', await savedToast.isVisible().catch(() => false));
      }

      const fsState = await page.evaluate(() => ({
        totalWritten: window.__fsWrites.reduce((a, b) => a + b, 0),
        closed: window.__fsClosed,
        aborted: window.__fsAborted,
        createObjectURLCalls: window.__createObjectURLCalls,
        suggestedName: window.__fsSuggestedName,
      }));
      step('[A1] all bytes landed in the fake disk sink, not a Blob download', fsState.createObjectURLCalls === 0, `createObjectURLCalls=${fsState.createObjectURLCalls}`);
      step('[A1] streamed total exceeds the 75 MiB in-memory cap', fsState.totalWritten > AGGREGATE_CAP, `totalWritten=${fsState.totalWritten} cap=${AGGREGATE_CAP}`);
      step('[A1] sink was closed (write completed cleanly)', fsState.closed === true && fsState.aborted !== true, `closed=${fsState.closed} aborted=${fsState.aborted}`);
      const packageVersion = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
      step(
        '[A1] suggested filename embeds the package-derived build and date',
        fsState.suggestedName === `kyutxo-evidence-package-v${packageVersion}-${new Date().toISOString().slice(0, 10)}.zip`,
        `suggestedName="${fsState.suggestedName}" packageVersion="${packageVersion}"`,
      );

      // ── A2: same oversized selection with streaming OFF is refused, and
      // the error mentions the streaming opt-in. ──
      await streamToggle.click(); // turn OFF
      await page.getByTestId('button-export-evidence-package').click();
      const failureToast = page.getByText(/Evidence package failed/i).first();
      const sawFailure = await failureToast.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
      step('[A2] in-memory export of the same oversized selection is refused', sawFailure);
      if (sawFailure) {
        const streamingHint = page.getByText(/streaming export/i).first();
        step('[A2] refusal message points the user at the streaming toggle', await streamingHint.isVisible().catch(() => false));
      }

      // ── A3: cancellation mid-stream aborts and never reports success ──
      await page.evaluate(() => { window.__fsWrites = []; window.__fsClosed = false; window.__fsAborted = false; window.__evidenceStreamDelayMs = 60; });
      await streamToggle.click(); // back ON
      await page.getByTestId('button-export-evidence-package').click();
      // Give the stream a moment to start writing before cancelling.
      await page.waitForFunction(() => window.__fsWrites.length > 0, undefined, { timeout: 15_000 }).catch(() => {});
      await page.getByTestId('button-cancel-evidence-package').click();

      const buttonReenabled = await page
        .waitForFunction(() => {
          const btn = document.querySelector('[data-testid="button-export-evidence-package"]');
          return btn && !btn.disabled;
        }, undefined, { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      step('[A3] export button re-enables after cancellation', buttonReenabled);

      const cancelState = await page.evaluate(() => ({ closed: window.__fsClosed, aborted: window.__fsAborted }));
      step('[A3] cancelled stream aborts the sink and never closes it', cancelState.aborted === true && cancelState.closed !== true, `aborted=${cancelState.aborted} closed=${cancelState.closed}`);
      const cancelledToast = page.getByText(/Export cancelled/i).first();
      step('[A3] a cancellation notice is shown (not a success toast)', await cancelledToast.isVisible().catch(() => false));
      const noNewSuccessToast = (await page.getByText(/Evidence package exported/i).count()) <= 1; // only the earlier A1 toast, if still mounted
      step('[A3] no additional success toast appears after cancelling', noNewSuccessToast);

      // ── A4: a genuine mid-stream WRITE failure (not a user cancel) also
      // aborts cleanly. The writable accepts a few chunks successfully (so
      // this is a real mid-stream failure, not an immediate rejection) and
      // then rejects every subsequent write(), the way a disk-full or
      // permission-revoked error would surface from the real File System
      // Access API partway through a large export. ──
      await page.evaluate(() => {
        window.__fsWrites = [];
        window.__fsClosed = false;
        window.__fsAborted = false;
        window.__evidenceStreamDelayMs = 0;
        window.__evidenceStreamFailAfterWrites = 2;
      });
      await page.getByTestId('button-export-evidence-package').click(); // streamToggle is still ON from A3
      const writeFailureToast = page.getByText(/Evidence package failed/i).first();
      const sawWriteFailure = await writeFailureToast.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
      step('[A4] a mid-stream disk write failure surfaces as a failed export (not silently swallowed)', sawWriteFailure);

      if (sawWriteFailure) {
        const writeFailureMessage = page.getByText(/Simulated disk write failure/i).first();
        step('[A4] failure toast surfaces the underlying write error', await writeFailureMessage.isVisible().catch(() => false));
        const isDestructive = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('[class*="destructive"]')];
          return nodes.some((node) => /Evidence package failed/i.test(node.textContent || ''));
        });
        step('[A4] failure toast is rendered as a destructive (not default/success) toast', isDestructive);
      }

      const writeFailureButtonReenabled = await page
        .waitForFunction(() => {
          const btn = document.querySelector('[data-testid="button-export-evidence-package"]');
          return btn && !btn.disabled;
        }, undefined, { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      step('[A4] export button re-enables after the write failure', writeFailureButtonReenabled);

      const writeFailureState = await page.evaluate(() => ({
        closed: window.__fsClosed,
        aborted: window.__fsAborted,
        writesAccepted: window.__fsWrites.length,
      }));
      step(
        '[A4] some chunks were accepted before the injected failure (a genuine mid-stream failure)',
        writeFailureState.writesAccepted > 0 && writeFailureState.writesAccepted <= 2,
        `writesAccepted=${writeFailureState.writesAccepted}`,
      );
      step(
        '[A4] a mid-stream write failure aborts the sink and never closes it',
        writeFailureState.aborted === true && writeFailureState.closed !== true,
        `aborted=${writeFailureState.aborted} closed=${writeFailureState.closed}`,
      );
      const noSuccessToastAfterWriteFailure = (await page.getByText(/Evidence package exported/i).count()) === 0;
      step('[A4] no success toast appears after a mid-stream write failure', noSuccessToastAfterWriteFailure);

      await context.close();
    }

    // ═══════════════ Context B: Electron backup-bridge path ═══════════════
    console.log('\n[evidence-stream] === Context B: Electron streaming (preferred over File System Access) ===');
    {
      const context = await browser.newContext();
      await context.addInitScript(ENGINE_SHIM);
      await context.addInitScript(ELECTRON_SHIM);
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log(`[evidence-stream][page-error] ${e.message}`));

      let loaded = false;
      for (let i = 0; i < 3 && !loaded; i++) {
        try {
          await page.goto(EXPORT_URL, { waitUntil: 'load', timeout: 60_000 });
          loaded = true;
        } catch (e) {
          console.log(`[evidence-stream] goto retry ${i + 1}: ${e.message}`);
          await page.waitForTimeout(3_000);
        }
      }
      if (!loaded) throw new Error('app never loaded (context B)');
      await unlockIfNeeded(page, SETUP_PASSWORD_B);

      const seed = await seedOversizedEvidence(page, {
        title: 'Streaming fixture (electron)',
        attachmentSize: ATTACHMENT_SIZE,
        attachmentCount: ATTACHMENT_COUNT,
      });
      step('seeded oversized evidence with real uploaded attachments (electron)', typeof seed.evidenceId === 'number' && seed.attachmentIds.length === ATTACHMENT_COUNT, `evidenceId=${seed.evidenceId} attachments=${seed.attachmentIds.length}`);

      // Full navigation drops the in-memory vault key too; re-unlock.
      await page.goto(EXPORT_URL, { waitUntil: 'load', timeout: 60_000 });
      await unlockIfNeeded(page, SETUP_PASSWORD_B);

      const checkbox = page.getByTestId(`checkbox-evidence-${seed.evidenceId}`);
      await checkbox.waitFor({ state: 'visible', timeout: 20_000 });
      await checkbox.check();

      const streamToggle = page.getByTestId('switch-package-stream-to-disk');
      await streamToggle.waitFor({ state: 'visible', timeout: 10_000 });
      await streamToggle.click();
      await page.getByTestId('button-export-evidence-package').click();

      const successToast = page.getByText(/Evidence package exported/i).first();
      const sawSuccess = await successToast.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false);
      step('[B1] Electron-streamed export of an 80 MiB selection succeeds', sawSuccess);

      const electronState = await page.evaluate(() => ({
        totalWritten: window.__electronWrites.reduce((a, b) => a + b, 0),
        closed: window.__electronClosed,
        aborted: window.__electronAborted,
        backupOpenCalls: window.__electronBackupOpenCalls,
        fsShimCalls: window.__fsShimCalls,
      }));
      step('[B1] Electron backup bridge was used to open the sink', electronState.backupOpenCalls === 1, `backupOpenCalls=${electronState.backupOpenCalls}`);
      step('[B1] File System Access API was never touched (Electron preferred)', electronState.fsShimCalls === 0, `fsShimCalls=${electronState.fsShimCalls}`);
      step('[B1] streamed total exceeds the 75 MiB in-memory cap', electronState.totalWritten > AGGREGATE_CAP, `totalWritten=${electronState.totalWritten} cap=${AGGREGATE_CAP}`);
      step('[B1] Electron sink was closed (write completed cleanly)', electronState.closed === true && electronState.aborted !== true, `closed=${electronState.closed} aborted=${electronState.aborted}`);

      await context.close();
    }
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
  console.log(`\n[evidence-stream] ok=${ok}`);
  if (!ok) {
    console.error('\n[evidence-stream] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) console.error(`  - ${s.name}: ${s.detail}`);
    process.exit(1);
  }
  console.log(
    `\n[evidence-stream] PASSED: a ${(TOTAL_SIZE / (1024 * 1024)).toFixed(0)} MiB selected evidence package ` +
      'streamed to disk (never buffered whole) via both the File System Access API and the Electron backup ' +
      'bridge, the in-memory fallback correctly refuses the same oversized selection with a streaming hint, ' +
      'and both a user cancellation AND a genuine mid-stream disk write failure abort the partial file cleanly ' +
      'without ever reporting success.',
  );
}

function attachmentCountLabel() {
  return `${ATTACHMENT_COUNT} x ${(ATTACHMENT_SIZE / (1024 * 1024)).toFixed(0)} MiB attachments`;
}

main().catch((err) => {
  console.error('[evidence-stream] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
