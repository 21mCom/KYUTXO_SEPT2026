#!/usr/bin/env node
// Real-browser verification that the Continuity Proof custody-segment
// "Export PDF" button (client/src/components/ContinuityProof.tsx,
// handleExportSegmentPdf → client/src/lib/custody-proof-export.ts) actually
// produces a downloadable, readable PDF in a real Chromium.
//
// The jsdom unit tests (ContinuityProof.exportPdf.test.tsx) mock jsPDF, so
// they cannot catch real-browser-only failures: the dynamic `import("jspdf")`
// failing under the bundled/packaged configuration, `doc.save()` not firing a
// download, or WinAnsi punctuation (em-dashes, curly quotes, ellipsis) coming
// out garbled in the produced binary.
//
// This check:
//   1. Creates a fresh vault and seeds ONE custody segment via the real CRUD
//      helper, with punctuation-rich narrative/metadata (em-dash, curly
//      quotes, ellipsis — the same fixture family the unit test uses).
//   2. Opens /provenance (Provenance.tsx renders ContinuityProof), expands
//      the segment card and clicks the "Export PDF" button
//      (data-testid button-export-segment-pdf-<segmentId>).
//   3. Captures the resulting download, asserts the suggested filename is
//      custody-proof-<segmentId>.pdf and the bytes start with %PDF.
//   4. Re-parses the bytes in Node with pdf.js (legacy build — the oracle the
//      other PDF checks use) and asserts the title, segment id, narrative and
//      metadata round-trip with their punctuation intact (an em-dash that
//      fell back to a UTF-16BE byte stream would NOT match).
//   5. Fails on any page error or a logged "[ContinuityProof] PDF export
//      failed" console message.
//
// NOTE for reviewers: the button under test lives in
// client/src/components/ContinuityProof.tsx (renderSegmentCard footer); the
// PDF builder is client/src/lib/custody-proof-export.ts; /provenance is
// client/src/pages/Provenance.tsx.
//
// Usage: node scripts/check-custody-segment-export-pdf-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'segment-pdf-check-123';
const MAX_ATTEMPTS = 3;
const SEGMENT_ID = 'pdf-export-browser-seg-0001';

// Punctuation-rich fixture: em-dash, curly quotes, ellipsis. These only
// survive into the PDF text layer when sanitizePdfText remapped them to their
// single WinAnsi bytes; the garbled UTF-16BE fallback would not round-trip.
const NARRATIVE = 'Bought from a friend — held through “the fork”… untouched';
const OWNER = 'Alice “Ada” Example';
const WALLET_NAME = 'Vault — cold storage';

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
        `[segment-pdf] chromium launch failed (try ${i}): ${e.message.split('\n')[0]}`,
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

    // Seed one punctuation-rich custody segment via the real CRUD helper.
    const seeded = await page.evaluate(
      async ({ segmentId, narrative, owner, walletName }) => {
        const { bulkAddCustodySegments } = await import(
          '/src/lib/data/lineage-crud.ts'
        );
        const { db } = await import('/src/lib/database.ts');
        await bulkAddCustodySegments(
          [
            {
              segmentId,
              originTxid: 'ab'.repeat(32),
              originVout: 1,
              originAddress: 'bc1qsegmentpdforigin00000000000000000000',
              originDate: Math.floor(Date.now() / 1000) - 86_400 * 400,
              originAmount: 150_000_000,
              currentAddress: 'bc1qsegmentpdfcurrent0000000000000000000',
              currentAmount: 149_000_000,
              status: 'active',
              hopCount: 2,
              evidenceTxids: ['cd'.repeat(32), 'ef'.repeat(32)],
              narrative,
              owner,
              walletName,
              seedName: 'Seed “alpha”',
              acquisitionMethod: 'purchase',
              costBasisUsd: 41999.5,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          { skipNotification: true },
        );
        return db.custodySegments.count();
      },
      {
        segmentId: SEGMENT_ID,
        narrative: NARRATIVE,
        owner: OWNER,
        walletName: WALLET_NAME,
      },
    );
    step('seeded 1 custody segment', seeded === 1, `table count=${seeded}`);

    // Open the Provenance page (fresh load requires unlock again).
    await page.goto(`${BASE_URL}provenance`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    const unlockInput = page.getByTestId('input-password');
    await unlockInput.waitFor({ state: 'visible', timeout: 60_000 });
    await unlockInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    // Expand the segment card (collapsed by default; header is the trigger).
    const narrativeText = page.getByText(/Bought from a friend/);
    await narrativeText.waitFor({ state: 'visible', timeout: 60_000 });
    await narrativeText.click();

    const exportBtn = page.getByTestId(`button-export-segment-pdf-${SEGMENT_ID}`);
    await exportBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await exportBtn.scrollIntoViewIfNeeded({ timeout: 10_000 });

    // Click and capture the download. The dynamic import('jspdf') happens on
    // first click; give it a generous timeout for the Vite optimize pass.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      exportBtn.click(),
    ]);

    const suggested = download.suggestedFilename();
    step(
      'download fired with the expected filename',
      suggested === `custody-proof-${SEGMENT_ID}.pdf`,
      `suggested="${suggested}"`,
    );

    const bytes = await readDownloadBytes(download);
    const isPdf =
      bytes.byteLength > 500 &&
      bytes[0] === 0x25 && // %
      bytes[1] === 0x50 && // P
      bytes[2] === 0x44 && // D
      bytes[3] === 0x46; // F
    step(
      'downloaded bytes are a non-trivial PDF (%PDF header)',
      isPdf,
      `${bytes.byteLength} bytes`,
    );

    // The success toast (not the destructive failure toast) appeared.
    const successToast = await page
      .getByText('Custody proof exported to PDF file.')
      .first()
      .isVisible()
      .catch(() => false);
    step('success toast shown after export', successToast, '');

    step(
      'no page errors or PDF-export console errors',
      pageErrors.length === 0 && exportErrors.length === 0,
      `pageErrors=${pageErrors.length}, consoleErrors=${exportErrors.length}` +
        (exportErrors.length ? ` first="${exportErrors[0]}"` : ''),
    );

    return bytes;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[segment-pdf] chromium: ${exe}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[segment-pdf] starting dev server (npm run dev) ...');
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

  let pdfBytes;
  try {
    // Retry the whole session on environment flake (chromium crash, load
    // timeout under parallel validation); each attempt uses a fresh context.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      steps = [];
      const browser = await launchBrowser(exe);
      try {
        pdfBytes = await runSession(browser, step);
        break;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.log(`[segment-pdf] attempt ${attempt} crashed: ${msg.split('\n')[0]}`);
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

  // ── pdf.js oracle: parse the text layer in Node ─────────────────────────
  if (pdfBytes && pdfBytes.byteLength > 0) {
    const { numPages, text } = await extractPdfText(pdfBytes);
    // Line wrapping / label-value layout can split runs; collapse whitespace
    // so substring checks only depend on glyph identity, not layout.
    const flat = text.replace(/\s+/g, ' ');
    console.log(`[segment-pdf] parsed ${numPages} page(s), ${flat.length} chars of text`);

    step('parsed at least one page', numPages >= 1, `pages=${numPages}`);
    step(
      'title rendered',
      flat.includes('KYUTXO Custody Proof'),
      '',
    );
    step(
      'segment id rendered',
      flat.includes(`Segment ID: ${SEGMENT_ID}`),
      '',
    );
    step(
      'narrative punctuation round-trips (em-dash, curly quotes, ellipsis)',
      flat.includes('Bought from a friend —') &&
        flat.includes('“the fork”') &&
        flat.includes('… untouched'),
      '',
    );
    step('owner metadata with curly quotes rendered', flat.includes(OWNER), '');
    step(
      'wallet metadata with em-dash rendered',
      flat.includes(WALLET_NAME),
      '',
    );
    step(
      'evidence txids rendered',
      flat.includes(`1. ${'cd'.repeat(32)}`) && flat.includes(`2. ${'ef'.repeat(32)}`),
      '',
    );
    // A UTF-16BE fallback shows up as interleaved NULs / þÿ BOM junk in the
    // extracted text; none of that may appear.
    step(
      'no garbled UTF-16 fallback artifacts in the text layer',
      !/[\u0000\ufffd]|þÿ/.test(text),
      '',
    );
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[segment-pdf] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length || steps.length === 0) {
    console.error(
      'FAILED steps:',
      failed.map((s) => s.name).join('; ') || '(no steps ran)',
    );
    process.exit(1);
  }
  console.log('[segment-pdf] OK: custody-segment PDF export downloads and renders correctly.');
}

main().catch((err) => {
  console.error('[segment-pdf] FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
