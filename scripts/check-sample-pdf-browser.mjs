#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds **sample / specimen** PDF.
//
// The unit tests capture the strings handed to jsPDF's `doc.text()` API, which
// proves the content is *passed in* but cannot prove that a real PDF, generated
// by the live Vite-bundled jsPDF code path and opened in a real PDF engine,
// actually renders:
//   - the diagonal "SPECIMEN" watermark on EVERY page (angle: 45, low opacity),
//   - the "SAMPLE / SPECIMEN — NOT A VALID DECLARATION" notice banner,
//   - the fictitious declarant ("Jane Q. Sample"),
//   - and that NO real 64-char SHA-256 fingerprint leaks into a specimen.
//
// This script drives the actual "Generate Sample PDF" button in a real headless
// Chromium (so the bytes come from the exact code users run), captures the
// downloaded blob, and re-parses it with pdf.js (the *legacy* build — the same
// engine Firefox ships and the same flavor the pdf-glyph check uses, because the
// Nix-pinned test Chromium predates `Promise.try` that pdfjs' default build
// needs). It then asserts on the recovered text layer:
//   - page count is plausible (>= 1)
//   - the watermark/footer "SPECIMEN" token appears on EVERY page
//   - on every non-first page, "SPECIMEN" appears >= 2 times (footer + the
//     diagonal watermark — those pages carry no banner, so the second
//     occurrence isolates the watermark)
//   - the red notice banner text ("NOT A VALID DECLARATION") and the word
//     "SAMPLE" are present
//   - the fictitious declarant "Jane Q. Sample" is present
//   - NO 64-char hex fingerprint appears anywhere (a specimen must never carry
//     a real SHA-256 content fingerprint)
//
// Usage: node scripts/check-sample-pdf-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PROOF_URL = `${BASE_URL}proof-of-funds`;
const SETUP_PASSWORD = 'sample-pdf-check-123';

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.',
    );
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

/** Read a Playwright download into a Uint8Array of its bytes. */
async function readDownloadBytes(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Parse PDF bytes with the legacy pdf.js build and return per-page text. */
async function extractPerPageText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    // getTextContent never paints to canvas, so font/eval helpers are unused.
    isEvalSupported: false,
  });
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
    return pages;
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }
}

/** Best-effort: turn a Radix switch ON by its data-testid. Never throws. */
async function ensureSwitchOn(page, testId) {
  try {
    const sw = page.getByTestId(testId);
    await sw.waitFor({ state: 'attached', timeout: 5000 });
    await sw.scrollIntoViewIfNeeded({ timeout: 5000 });
    const state = await sw.getAttribute('data-state');
    if (state !== 'checked') {
      await sw.click({ timeout: 5000 });
    }
    return true;
  } catch {
    console.log(`[sample-pdf-browser] note: could not enable switch ${testId} (skipping)`);
    return false;
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[sample-pdf-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[sample-pdf-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[sample-pdf-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[sample-pdf-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  let pdfBytes;
  let numPages = 0;
  try {
    // Fresh context => empty IndexedDB => the vault is uninitialized, so the
    // login screen shows the "Create Vault" setup form. Block the PWA service
    // worker so it cannot take control and reload the page mid-flow.
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[sample-pdf-browser][page-console] ${t}`);
      }
    });

    // Navigate straight to the Proof-of-Funds route. On a fresh vault the auth
    // gate intercepts with the setup form regardless of route; after the vault
    // is created the in-memory auth state flips to authenticated and the current
    // (proof-of-funds) route renders without a reload.
    await page.goto(PROOF_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // ── Wait for the Proof-of-Funds page to render ─────────────────────────
    const sampleBtn = page.getByTestId('button-generate-sample-pdf');
    await sampleBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // Enable the optional sections so the sample PDF exercises the QR,
    // provenance, AML, attestation and glossary code paths (and grows to
    // multiple pages, which the per-page watermark check relies on).
    await ensureSwitchOn(page, 'switch-include-qr');
    await ensureSwitchOn(page, 'switch-include-provenance');
    await ensureSwitchOn(page, 'switch-include-aml');
    await ensureSwitchOn(page, 'switch-include-attestation');
    await ensureSwitchOn(page, 'switch-include-glossary');

    // Re-locate the sample button (the DOM above it may have re-rendered) and
    // click it, capturing the resulting download.
    await sampleBtn.scrollIntoViewIfNeeded({ timeout: 10_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      sampleBtn.click(),
    ]);

    pdfBytes = await readDownloadBytes(download);
    console.log(
      `[sample-pdf-browser] captured sample PDF (${pdfBytes.byteLength} bytes, ` +
        `suggested name: ${download.suggestedFilename()})`,
    );
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!pdfBytes || pdfBytes.byteLength === 0) {
    console.error('[sample-pdf-browser] FAILED: no PDF bytes were captured.');
    process.exit(1);
  }

  // pdf.js parsing happens in Node — it is only our verification oracle; KYUTXO
  // itself never reads PDFs. The legacy build runs reliably in Node.
  const perPage = await extractPerPageText(pdfBytes);
  numPages = perPage.length;
  const fullText = perPage.join('\n');

  const steps = [];

  // 1) Plausible page count.
  steps.push({
    name: 'page count is plausible (>= 1)',
    passed: numPages >= 1,
    detail: `parsed ${numPages} page(s)`,
  });

  // 2) The "SPECIMEN" token (watermark + footer) appears on every page.
  {
    const missing = [];
    perPage.forEach((txt, idx) => {
      if (!txt.includes('SPECIMEN')) missing.push(idx + 1);
    });
    const passed = numPages >= 1 && missing.length === 0;
    steps.push({
      name: 'every page carries the "SPECIMEN" specimen marker',
      passed,
      detail: passed
        ? `all ${numPages} page(s) contain "SPECIMEN"`
        : `pages missing "SPECIMEN": ${missing.join(', ') || '(no pages parsed)'}`,
    });
  }

  // 3) Watermark isolation: every non-first page has >= 2 "SPECIMEN" runs
  //    (page footer + diagonal watermark; those pages carry no notice banner).
  {
    const countOf = (s) => (s.match(/SPECIMEN/g) || []).length;
    if (numPages < 2) {
      steps.push({
        name: 'diagonal watermark present on non-first pages',
        passed: false,
        detail:
          `expected a multi-page specimen (with optional sections enabled) so the ` +
          `watermark can be isolated from the banner, but only ${numPages} page(s) were produced`,
      });
    } else {
      const weak = [];
      for (let i = 1; i < numPages; i++) {
        if (countOf(perPage[i]) < 2) weak.push(i + 1);
      }
      const passed = weak.length === 0;
      steps.push({
        name: 'diagonal watermark present on every non-first page',
        passed,
        detail: passed
          ? `pages 2..${numPages} each contain the footer + watermark "SPECIMEN"`
          : `pages with no watermark (only one "SPECIMEN", the footer): ${weak.join(', ')}`,
      });
    }
  }

  // 4) The red notice banner text rendered.
  {
    const passed =
      fullText.includes('NOT A VALID DECLARATION') && fullText.includes('SAMPLE');
    steps.push({
      name: 'sample-notice banner text rendered',
      passed,
      detail: passed
        ? 'found "SAMPLE" and "NOT A VALID DECLARATION" in the text layer'
        : `banner text missing (has "SAMPLE": ${fullText.includes('SAMPLE')}, ` +
          `has "NOT A VALID DECLARATION": ${fullText.includes('NOT A VALID DECLARATION')})`,
    });
  }

  // 5) The fictitious declarant rendered.
  {
    const passed = fullText.includes('Jane Q. Sample');
    steps.push({
      name: 'fictitious declarant "Jane Q. Sample" rendered',
      passed,
      detail: passed
        ? 'found the placeholder declarant name'
        : 'expected "Jane Q. Sample" in the rendered text but it was missing',
    });
  }

  // 6) No real 64-char hex SHA-256 fingerprint leaked into the specimen.
  {
    const hexMatch = fullText.match(/\b[0-9a-fA-F]{64}\b/);
    const passed = hexMatch === null;
    steps.push({
      name: 'no 64-char hex fingerprint in the specimen',
      passed,
      detail: passed
        ? 'no real SHA-256 content fingerprint present (as expected for a sample)'
        : `found a 64-char hex string ("${hexMatch[0]}") — a specimen must not carry a real fingerprint`,
    });
  }

  const ok = steps.every((s) => s.passed);

  console.log(`[sample-pdf-browser] pages=${numPages} ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[sample-pdf-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[sample-pdf-browser] PASSED: the sample PDF watermark, banner and sections render correctly in a real browser.',
  );
}

main().catch((err) => {
  console.error('[sample-pdf-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
