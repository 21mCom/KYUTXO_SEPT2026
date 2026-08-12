#!/usr/bin/env node
// Real-browser verification that the Continuity Proof "Export All as PDF"
// control (client/src/components/ContinuityProof.tsx,
// handleExportAllSegmentsPdf → downloadAllSegmentProofsPdf in
// client/src/lib/custody-proof-export.ts) actually:
//   1. Downloads a combined custody-proofs-<yyyy-mm-dd>.pdf whose cover page
//      counts every seeded segment and which contains one section per segment
//      (verified with the pdf.js legacy-build oracle in Node).
//   2. Narrows the export when the address filter is active: only matching
//      segments appear in the produced PDF and the count on the cover page
//      matches the filtered total (button re-labels "Export All as PDF
//      (filtered)").
//   3. Cancel mid-export saves NO file, shows the "Export Cancelled" toast
//      and returns the control to its idle state.
//
// The jsdom unit tests mock jsPDF, so none of this is covered outside a real
// Chromium: dynamic import('jspdf') under Vite, doc.save() firing a real
// download, and the AbortController racing the per-segment yield loop.
//
// NOTE for reviewers: the button under test is
// data-testid="button-export-all-segments-pdf" in
// client/src/components/ContinuityProof.tsx (rendered by /provenance, i.e.
// client/src/pages/Provenance.tsx); the combined-PDF builder is
// downloadAllSegmentProofsPdf in client/src/lib/custody-proof-export.ts.
//
// Usage: node scripts/check-continuity-proof-export-all-pdf-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'export-all-pdf-check-123';
const MAX_ATTEMPTS = 3;

const MATCH_COUNT = 12; // segments whose address contains the filter needle
const OTHER_COUNT = 8; // segments that must be excluded by the filter
const TOTAL_COUNT = MATCH_COUNT + OTHER_COUNT;
const FILTER_NEEDLE = 'zfilterq';
// Extra segments seeded before the cancel scenario so the export runs long
// enough (under CPU throttle) for the cancel click to land mid-run.
const CANCEL_EXTRA = 1200;

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH.');
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

async function launchBrowser(exe) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      lastErr = e;
      console.log(
        `[export-all-pdf] chromium launch failed (try ${i}): ${e.message.split('\n')[0]}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
  throw lastErr;
}

/** Read a Playwright download into a Uint8Array of its bytes. */
async function readDownloadBytes(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

/** Parse PDF bytes with the legacy pdf.js build (Node oracle) → full text. */
async function extractPdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
      );
      await page.cleanup();
    }
    return { numPages: pdf.numPages, text: pages.join('\n') };
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }
}

/** In-page seeding of custody segments via the real CRUD helper. */
async function seedSegments(page, { matchCount, otherCount, extraCount, needle }) {
  return page.evaluate(
    async ({ matchCount, otherCount, extraCount, needle }) => {
      const { bulkAddCustodySegments } = await import(
        '/src/lib/data/lineage-crud.ts'
      );
      const { db } = await import('/src/lib/database.ts');
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      const mk = (i, kind, addrNeedle) => ({
        segmentId: `${kind}-export-all-seg-${String(i).padStart(5, '0')}`,
        originTxid: (i % 2 ? 'ab' : 'cd').repeat(32),
        originVout: i % 4,
        originAddress: `bc1q${addrNeedle}origin${String(i).padStart(6, '0')}`,
        originDate: nowSec - 86_400 * (30 + i),
        originAmount: 1_000_000 + i * 1_000,
        currentAddress:
          i % 3 === 0 ? undefined : `bc1qcurrent${String(i).padStart(6, '0')}`,
        currentAmount: i % 3 === 0 ? 0 : 900_000 + i * 1_000,
        status: i % 3 === 0 ? 'spent' : 'active',
        hopCount: i % 5,
        evidenceTxids: ['ef'.repeat(32)],
        narrative: `Segment ${kind} #${i} — held “safely”…`,
        owner: 'Check Owner',
        walletName: 'Check Wallet',
        acquisitionMethod: 'purchase',
        createdAt: now,
        updatedAt: now,
      });
      const rows = [];
      for (let i = 0; i < matchCount; i++) rows.push(mk(i, 'flt', needle));
      for (let i = 0; i < otherCount; i++) rows.push(mk(i, 'oth', 'plain'));
      for (let i = 0; i < extraCount; i++) rows.push(mk(i, 'xtr', 'bulk'));
      // Chunked insert keeps single bulkAdd payloads modest.
      for (let off = 0; off < rows.length; off += 500) {
        await bulkAddCustodySegments(rows.slice(off, off + 500), {
          skipNotification: true,
        });
      }
      return db.custodySegments.count();
    },
    { matchCount, otherCount, extraCount, needle },
  );
}

async function unlockAt(page, path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'load', timeout: 60_000 });
  const pwInput = page.getByTestId('input-password');
  await pwInput.waitFor({ state: 'visible', timeout: 60_000 });
  await pwInput.fill(SETUP_PASSWORD);
  await page.getByTestId('button-submit').click();
  await page
    .getByTestId('button-dismiss-migration')
    .click({ timeout: 5_000 })
    .catch(() => {});
}

async function runSession(browser, step) {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    acceptDownloads: true,
  });
  const pageErrors = [];
  const exportErrors = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => {
      pageErrors.push(e.message);
      console.log(`[page-error] ${e.message}`);
    });
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('PDF export failed') || msg.type() === 'error') {
        exportErrors.push(t);
        console.log(`[page-console:${msg.type()}] ${t}`);
      }
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // Fresh vault via setup form (fresh context = fresh IndexedDB).
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 60_000 });
    await pwInput.fill(SETUP_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    const seeded = await seedSegments(page, {
      matchCount: MATCH_COUNT,
      otherCount: OTHER_COUNT,
      extraCount: 0,
      needle: FILTER_NEEDLE,
    });
    step(
      `seeded ${TOTAL_COUNT} custody segments`,
      seeded === TOTAL_COUNT,
      `table count=${seeded}`,
    );

    // ── Scenario 1: full export downloads a combined PDF ────────────────
    await unlockAt(page, 'provenance');
    const exportBtn = page.getByTestId('button-export-all-segments-pdf');
    await exportBtn.waitFor({ state: 'visible', timeout: 60_000 });
    // Wait for the count to hydrate so the button is enabled.
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="button-export-all-segments-pdf"]',
        );
        return el && !el.disabled;
      },
      undefined,
      { timeout: 60_000 },
    );

    const [download] = await Promise.all([
      // Generous timeout: first click pays the dynamic import('jspdf') cost.
      page.waitForEvent('download', { timeout: 120_000 }),
      exportBtn.click(),
    ]);

    const suggested = download.suggestedFilename();
    step(
      'full export downloads custody-proofs-<date>.pdf',
      /^custody-proofs-\d{4}-\d{2}-\d{2}\.pdf$/.test(suggested),
      `suggested="${suggested}"`,
    );

    const bytes = await readDownloadBytes(download);
    const isPdf =
      bytes.byteLength > 1000 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46;
    step(
      'full-export bytes are a non-trivial PDF (%PDF header)',
      isPdf,
      `${bytes.byteLength} bytes`,
    );

    const full = await extractPdfText(bytes);
    const fullFlat = full.text.replace(/\s+/g, ' ');
    step(
      `cover page counts all ${TOTAL_COUNT} segments`,
      fullFlat.includes(`Segments included: ${TOTAL_COUNT}`),
      `pages=${full.numPages}`,
    );
    const sectionCount = (fullFlat.match(/Segment ID: /g) || []).length;
    step(
      'one proof section per segment rendered',
      sectionCount === TOTAL_COUNT &&
        fullFlat.includes(`Custody Segment ${TOTAL_COUNT} of ${TOTAL_COUNT}`) &&
        full.numPages >= TOTAL_COUNT + 1,
      `sections=${sectionCount}, pages=${full.numPages}`,
    );
    step(
      'footer page numbering rendered on the combined PDF',
      fullFlat.includes(`Page 1 of ${full.numPages}`),
      '',
    );
    const successToast = await page
      .getByText(/custody segments exported to a combined PDF/)
      .first()
      .isVisible()
      .catch(() => false);
    step('success toast reports the exported count', successToast, '');

    // ── Scenario 2: active address filter narrows the export ────────────
    await page.getByTestId('input-filter-address').fill(FILTER_NEEDLE);
    // Debounced filter: wait for the button to re-label "(filtered)".
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="button-export-all-segments-pdf"]',
        );
        return (
          el && !el.disabled && (el.textContent || '').includes('(filtered)')
        );
      },
      undefined,
      { timeout: 60_000 },
    );

    const [filteredDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      exportBtn.click(),
    ]);
    const filteredBytes = await readDownloadBytes(filteredDownload);
    const filtered = await extractPdfText(filteredBytes);
    const filteredFlat = filtered.text.replace(/\s+/g, ' ');
    const filteredSections = (filteredFlat.match(/Segment ID: /g) || []).length;
    step(
      `filtered export contains exactly the ${MATCH_COUNT} matching segments`,
      filteredFlat.includes(`Segments included: ${MATCH_COUNT}`) &&
        filteredSections === MATCH_COUNT &&
        filteredFlat.includes(`Custody Segment ${MATCH_COUNT} of ${MATCH_COUNT}`),
      `sections=${filteredSections}`,
    );
    step(
      'no non-matching segment leaks into the filtered PDF',
      !filteredFlat.includes('oth-export-all-seg-') &&
        filteredFlat.includes('flt-export-all-seg-'),
      '',
    );

    // ── Scenario 3: cancel mid-export saves nothing, returns to idle ────
    const cancelTotal = await seedSegments(page, {
      matchCount: 0,
      otherCount: 0,
      extraCount: CANCEL_EXTRA,
      needle: FILTER_NEEDLE,
    });
    step(
      'seeded extra segments for the cancel scenario',
      cancelTotal === TOTAL_COUNT + CANCEL_EXTRA,
      `table count=${cancelTotal}`,
    );
    // Reload so the page's totals reflect the new seed (in-page writes with
    // skipNotification don't refresh the mounted list).
    await unlockAt(page, 'provenance');
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="button-export-all-segments-pdf"]',
        );
        return el && !el.disabled;
      },
      undefined,
      { timeout: 60_000 },
    );

    let downloadFiredDuringCancel = false;
    const onDownload = () => {
      downloadFiredDuringCancel = true;
    };
    page.on('download', onDownload);

    const cdp = await context.newCDPSession(page);
    // Warm re-runs are fast (JIT + jspdf cached): throttle the CPU and retry
    // with escalating rates if the export completes before the cancel lands.
    let cancelled = false;
    for (const rate of [8, 14, 20]) {
      downloadFiredDuringCancel = false;
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      // dispatchEvent: no actionability retries that could straddle
      // completion of a fast export.
      await page
        .getByTestId('button-export-all-segments-pdf')
        .dispatchEvent('click');
      try {
        await page
          .getByTestId('text-export-all-counter')
          .waitFor({ state: 'visible', timeout: 30_000 });
        await page
          .getByTestId('button-cancel-export-all')
          .dispatchEvent('click');
        // Cancel toast: abort is observed at the next segment boundary.
        await page
          .getByText('The combined PDF export was cancelled. No file was saved.')
          .first()
          .waitFor({ state: 'visible', timeout: 60_000 });
        cancelled = true;
      } catch (e) {
        console.log(
          `[export-all-pdf] cancel attempt at rate ${rate}x missed: ${String(
            e && e.message ? e.message.split('\n')[0] : e,
          )}`,
        );
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      if (cancelled && !downloadFiredDuringCancel) break;
      // Export finished (download fired) or cancel UI never showed — wait for
      // the control to settle back to idle before retrying harder.
      await page
        .getByTestId('button-export-all-segments-pdf')
        .waitFor({ state: 'visible', timeout: 120_000 })
        .catch(() => {});
      cancelled = false;
    }
    step(
      'cancel mid-export shows the Export Cancelled toast',
      cancelled,
      '',
    );

    // No file may be saved by the cancelled run (grace window for a late
    // doc.save()).
    await page.waitForTimeout(3_000);
    step(
      'no download fired for the cancelled export',
      !downloadFiredDuringCancel,
      '',
    );
    page.off('download', onDownload);

    // Control returned to idle: export button back, progress row gone.
    const idleBtnVisible = await page
      .getByTestId('button-export-all-segments-pdf')
      .isVisible()
      .catch(() => false);
    const progressGone =
      (await page.getByTestId('export-all-progress').count()) === 0;
    step(
      'control returned to idle after cancel',
      idleBtnVisible && progressGone,
      `idleBtn=${idleBtnVisible}, progressGone=${progressGone}`,
    );

    step(
      'no page errors or PDF-export console errors',
      pageErrors.length === 0 && exportErrors.length === 0,
      `pageErrors=${pageErrors.length}, consoleErrors=${exportErrors.length}` +
        (exportErrors.length ? ` first="${exportErrors[0]}"` : ''),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[export-all-pdf] chromium: ${exe}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[export-all-pdf] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error('Dev server did not become ready.');
    }
  }

  let steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    // Retry the whole session on environment flake (chromium crash, load
    // timeout under parallel validation); each attempt uses a fresh context.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      steps = [];
      const browser = await launchBrowser(exe);
      try {
        await runSession(browser, step);
        break;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.log(`[export-all-pdf] attempt ${attempt} crashed: ${msg.split('\n')[0]}`);
        if (attempt === MAX_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, 15_000 * attempt));
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } finally {
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[export-all-pdf] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length || steps.length === 0) {
    console.error(
      'FAILED steps:',
      failed.map((s) => s.name).join('; ') || '(no steps ran)',
    );
    process.exit(1);
  }
  console.log(
    '[export-all-pdf] OK: combined all-segments PDF export downloads, filters and cancels correctly.',
  );
}

main().catch((err) => {
  console.error('[export-all-pdf] FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
