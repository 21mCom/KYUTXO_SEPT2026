#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds **empty-address
// exclusion** feature.
//
// Zero-balance addresses are automatically excluded from the declaration: they
// are NOT listed individually in the results table, they are summarised in an
// "N empty addresses excluded" alert, and they never reach the generated PDF.
// When EVERY address resolves to zero an "all addresses empty" alert is shown
// and the "Generate PDF" button stays disabled.
//
// The unit tests (`proof-of-funds-empty-exclusion.test.tsx`) cover this in
// jsdom with the balance source, the jsPDF text sink and the record CRUD all
// mocked. jsdom has an incomplete DOM/layout model and never paints a real PDF,
// so it cannot prove the exclusion holds in the live, Vite-bundled app rendered
// in a real browser. This script drives the actual page in a headless Chromium:
// it creates a vault, seeds the vault's IndexedDB with ONE funded address (a
// confirmed transaction + an unspent output participant) and pastes a SECOND
// zero-balance address alongside it, runs the OFFLINE balance check, and then
// asserts on the real DOM + a real downloaded PDF (re-parsed with pdf.js):
//
//   Mixed case (one funded, one empty):
//     - the "N empty addresses excluded" alert is present
//     - the empty address does NOT appear in any results-table row
//     - the funded address DOES appear in a results-table row
//     - the generated PDF contains the funded address and NOT the empty one
//
//   All-empty case (both addresses zero):
//     - the "all addresses empty" alert is present
//     - the "Generate PDF" button stays disabled
//     - no individual results-table rows are rendered
//
//   Full-featured case (one funded, one empty, ALL optional sections ON):
//     - the QR, Acquisition & Provenance, and AML / Risk Screening switches are
//       all turned on before the PDF is generated
//     - the generated PDF contains the funded address (full form, drawn by the
//       QR section, AND truncated 8+8 form, drawn by the provenance table)
//     - the empty address never appears in ANY section, in either its full form
//       or its truncated 8+8 form (the truncation the QR/provenance/AML sections
//       use). This closes the gap left by the default OFF-sections run: those
//       optional sections render addresses in a truncated `first8...last8` shape
//       that plain full-string substring matching would have missed.
//
// pdf.js is only the verification *oracle* (KYUTXO never reads PDFs). We load
// pdf.js's *legacy* build because the Nix-pinned test Chromium (v125) predates
// `Promise.try`, which pdfjs' default build/worker needs — same flavor/reason as
// check-sample-pdf-browser.mjs and check-pdf-glyph-browser.mjs.
//
// Usage: node scripts/check-pof-empty-exclusion-browser.mjs
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
const SETUP_PASSWORD = 'pof-empty-check-123';

// Two valid mainnet addresses (same fixtures the unit test uses): one we fund
// via seeded vault data, one left with no transaction data (zero balance).
const ADDR_FUNDED = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const ADDR_EMPTY = '12higDjoCCNXSA95xZMWUdPvXNmkAduhWv';
const FUNDED_SATS = 500_000;
const FUNDED_TXID =
  'a1b2c3d4e5f6071829304152637485960718293041526374859607182930a1b2';

// The QR / provenance / AML sections render addresses in a truncated 8+8 shape
// via `truncateAddress(addr, 8, 8)` => `first8...last8` (see client/src/lib/
// bitcoin.ts). Mirror that here so we can assert on the truncated form too.
function truncate88(address) {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}
const ADDR_FUNDED_TRUNC = truncate88(ADDR_FUNDED);
const ADDR_EMPTY_TRUNC = truncate88(ADDR_EMPTY);

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

/** Parse PDF bytes with the legacy pdf.js build and return the joined text. */
async function extractPdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
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
    return pages.join('\n');
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[pof-empty-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[pof-empty-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[pof-empty-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[pof-empty-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];
  let pdfBytes = null;
  let fullPdfBytes = null;

  try {
    // Fresh context => empty IndexedDB => the login screen shows the "Create
    // Vault" setup form. Block the PWA service worker so it cannot reload the
    // page mid-flow.
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[pof-empty-browser][page-console] ${t}`);
      }
    });

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
    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });

    // ════════════════════════════════════════════════════════════════════════
    // CASE 1 — all addresses empty (no vault data seeded yet)
    // ════════════════════════════════════════════════════════════════════════
    await page.getByTestId('button-source-offline').click();
    await textarea.fill([ADDR_EMPTY, ADDR_FUNDED].join('\n'));
    await page.getByTestId('button-check-balances').click();

    const allEmptyAlert = page.getByTestId('alert-all-empty');
    await allEmptyAlert.waitFor({ state: 'visible', timeout: 20_000 });
    steps.push({
      name: 'all-empty: "all addresses empty" alert is shown',
      passed: true,
      detail: 'alert-all-empty became visible',
    });

    {
      const pdfDisabled = await page
        .getByTestId('button-generate-pdf')
        .isDisabled();
      steps.push({
        name: 'all-empty: Generate PDF button stays disabled',
        passed: pdfDisabled === true,
        detail: pdfDisabled
          ? 'button-generate-pdf is disabled'
          : 'button-generate-pdf was unexpectedly enabled',
      });
    }

    {
      const rowCount = await page.locator('[data-testid^="row-address-"]').count();
      steps.push({
        name: 'all-empty: no individual results-table rows are rendered',
        passed: rowCount === 0,
        detail: `found ${rowCount} row(s) (expected 0)`,
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // Seed ONE funded address: a confirmed transaction + one unspent output.
    // computeStatsForAddresses reads these participant/blocktime rows directly,
    // so the offline balance check will report a non-zero balance for it. The
    // empty address is left with no data (genuine zero balance). We go through
    // the dedicated CRUD modules (addTransaction/addParticipant) to respect the
    // data-layer write guards. Vite serves a singleton module graph, so the
    // dynamically-imported `db` is the same instance the page uses.
    // ════════════════════════════════════════════════════════════════════════
    const seedResult = await page.evaluate(
      async ({ addr, sats, txid }) => {
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({
          txid,
          blockHeight: 800_000,
          blockTime: now - 3600,
          fee: 1000,
          feeRate: 5,
          syncedAt: Date.now(),
        });
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: addr,
          amount: sats,
          vout: 0,
        });
        return true;
      },
      { addr: ADDR_FUNDED, sats: FUNDED_SATS, txid: FUNDED_TXID },
    );
    steps.push({
      name: 'seed: funded address transaction + output written to vault',
      passed: seedResult === true,
      detail: `seeded ${ADDR_FUNDED} with ${FUNDED_SATS} sat`,
    });

    // ════════════════════════════════════════════════════════════════════════
    // CASE 2 — one funded, one empty (mixed)
    // ════════════════════════════════════════════════════════════════════════
    await page.getByTestId('button-reset').click();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('button-source-offline').click();
    await textarea.fill([ADDR_FUNDED, ADDR_EMPTY].join('\n'));
    await page.getByTestId('button-check-balances').click();

    // The funded address reaches the total-balance display.
    await page
      .getByTestId('text-total-balance')
      .waitFor({ state: 'visible', timeout: 20_000 });

    {
      const excludedVisible = await page
        .getByTestId('alert-empty-excluded')
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'mixed: "N empty addresses excluded" alert is shown',
        passed: excludedVisible === true,
        detail: excludedVisible
          ? 'alert-empty-excluded is visible'
          : 'alert-empty-excluded was missing',
      });
    }

    {
      const rowsText = (
        await page.locator('[data-testid^="row-address-"]').allTextContents()
      ).join(' ');
      const fundedListed = rowsText.includes(ADDR_FUNDED);
      const emptyListed = rowsText.includes(ADDR_EMPTY);
      steps.push({
        name: 'mixed: funded address IS listed in the results table',
        passed: fundedListed === true,
        detail: fundedListed
          ? 'funded address found in a results-table row'
          : 'funded address missing from the results table',
      });
      steps.push({
        name: 'mixed: empty address is NOT listed in the results table',
        passed: emptyListed === false,
        detail: emptyListed
          ? 'empty address unexpectedly appeared in a results-table row'
          : 'empty address correctly excluded from the results table',
      });
    }

    // ── Fill required declarant fields and generate the real PDF ───────────
    await page.getByTestId('input-declarant-name').fill('Alice Example');
    await page.getByTestId('input-declaration-date').fill('2026-06-30');
    await page.getByTestId('input-purpose').fill('Bank account opening');

    const pdfBtn = page.getByTestId('button-generate-pdf');
    await pdfBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="button-generate-pdf"]');
        return b && !b.hasAttribute('disabled');
      },
      { timeout: 15_000 },
    );
    await pdfBtn.scrollIntoViewIfNeeded({ timeout: 10_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      pdfBtn.click(),
    ]);
    pdfBytes = await readDownloadBytes(download);
    console.log(
      `[pof-empty-browser] captured PDF (${pdfBytes.byteLength} bytes, ` +
        `name: ${download.suggestedFilename()})`,
    );

    // ════════════════════════════════════════════════════════════════════════
    // CASE 3 — one funded, one empty, with ALL optional sections ON.
    // The QR, provenance, and AML sections render addresses in a truncated 8+8
    // form, so a leak there wouldn't be caught by the plain full-string PDF
    // check above. Turn every optional-section switch on and regenerate.
    // ════════════════════════════════════════════════════════════════════════
    const switchIds = [
      'switch-include-qr',
      'switch-include-provenance',
      'switch-include-aml',
    ];
    for (const id of switchIds) {
      const sw = page.getByTestId(id);
      await sw.scrollIntoViewIfNeeded({ timeout: 10_000 });
      // Radix Switch exposes its state via aria-checked; only click when off so
      // we deterministically end up ON regardless of any default.
      const checked = await sw.getAttribute('aria-checked');
      if (checked !== 'true') {
        await sw.click();
      }
      await page.waitForFunction(
        (testId) => {
          const el = document.querySelector(`[data-testid="${testId}"]`);
          return el && el.getAttribute('aria-checked') === 'true';
        },
        id,
        { timeout: 10_000 },
      );
    }
    steps.push({
      name: 'full: QR, provenance and AML switches are all ON',
      passed: true,
      detail: switchIds.join(', ') + ' aria-checked=true',
    });

    // The generate button must still be enabled (optional sections don't gate
    // it) — regenerate the now full-featured PDF.
    await page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="button-generate-pdf"]');
        return b && !b.hasAttribute('disabled');
      },
      { timeout: 15_000 },
    );
    await pdfBtn.scrollIntoViewIfNeeded({ timeout: 10_000 });
    const [fullDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      pdfBtn.click(),
    ]);
    fullPdfBytes = await readDownloadBytes(fullDownload);
    console.log(
      `[pof-empty-browser] captured full-featured PDF (${fullPdfBytes.byteLength} bytes, ` +
        `name: ${fullDownload.suggestedFilename()})`,
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

  // ── Verify the generated PDF excludes the empty address ──────────────────
  if (!pdfBytes || pdfBytes.byteLength === 0) {
    steps.push({
      name: 'mixed: a PDF was generated',
      passed: false,
      detail: 'no PDF bytes were captured',
    });
  } else {
    const fullText = await extractPdfText(pdfBytes);
    // pdf.js can split a long mono token across text runs; compare against a
    // whitespace-stripped copy too so a wrapped address still matches.
    const stripped = fullText.replace(/\s+/g, '');
    const fundedInPdf =
      fullText.includes(ADDR_FUNDED) || stripped.includes(ADDR_FUNDED);
    const emptyInPdf =
      fullText.includes(ADDR_EMPTY) || stripped.includes(ADDR_EMPTY);
    steps.push({
      name: 'mixed: funded address appears in the generated PDF',
      passed: fundedInPdf === true,
      detail: fundedInPdf
        ? 'funded address found in the PDF text layer'
        : 'funded address missing from the PDF text layer',
    });
    steps.push({
      name: 'mixed: empty address does NOT appear in the generated PDF',
      passed: emptyInPdf === false,
      detail: emptyInPdf
        ? 'empty address unexpectedly leaked into the PDF'
        : 'empty address correctly absent from the PDF',
    });
  }

  // ── Verify the FULL-FEATURED PDF (QR + provenance + AML) excludes empty ────
  if (!fullPdfBytes || fullPdfBytes.byteLength === 0) {
    steps.push({
      name: 'full: a full-featured PDF was generated',
      passed: false,
      detail: 'no full-featured PDF bytes were captured',
    });
  } else {
    const fullText = await extractPdfText(fullPdfBytes);
    const stripped = fullText.replace(/\s+/g, '');
    const has = (needle) =>
      fullText.includes(needle) || stripped.includes(needle);

    // Funded must appear: full form (QR section prints r.raw) AND truncated 8+8
    // form (provenance table prints truncateAddress(addr, 8, 8)). Requiring both
    // proves the optional sections actually rendered — otherwise an "empty
    // absent" pass could be vacuously true (no section drew any address).
    const fundedFull = has(ADDR_FUNDED);
    const fundedTrunc = has(ADDR_FUNDED_TRUNC);
    steps.push({
      name: 'full: funded address (full form) appears in the full-featured PDF',
      passed: fundedFull === true,
      detail: fundedFull
        ? 'funded full address found (QR section rendered)'
        : `funded full address ${ADDR_FUNDED} missing from the PDF text layer`,
    });
    steps.push({
      name: 'full: funded address (truncated 8+8) appears in the full-featured PDF',
      passed: fundedTrunc === true,
      detail: fundedTrunc
        ? `funded truncated address ${ADDR_FUNDED_TRUNC} found (provenance section rendered)`
        : `funded truncated address ${ADDR_FUNDED_TRUNC} missing — provenance section may not have rendered`,
    });

    // Empty must NOT appear in EITHER its full or truncated form, anywhere in
    // the QR / provenance / AML sections.
    const emptyFull = has(ADDR_EMPTY);
    const emptyTrunc = has(ADDR_EMPTY_TRUNC);
    steps.push({
      name: 'full: empty address (full form) does NOT appear in the full-featured PDF',
      passed: emptyFull === false,
      detail: emptyFull
        ? `empty full address ${ADDR_EMPTY} leaked into the full-featured PDF`
        : 'empty full address correctly absent',
    });
    steps.push({
      name: 'full: empty address (truncated 8+8) does NOT appear in the full-featured PDF',
      passed: emptyTrunc === false,
      detail: emptyTrunc
        ? `empty truncated address ${ADDR_EMPTY_TRUNC} leaked into an optional section`
        : 'empty truncated address correctly absent from every optional section',
    });
  }

  const ok = steps.every((s) => s.passed);

  console.log(`[pof-empty-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[pof-empty-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[pof-empty-browser] PASSED: empty-address exclusion holds in a real browser ' +
      '(table, alerts, plain PDF, and the full-featured PDF with QR + provenance + AML on).',
  );
}

main().catch((err) => {
  console.error('[pof-empty-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
