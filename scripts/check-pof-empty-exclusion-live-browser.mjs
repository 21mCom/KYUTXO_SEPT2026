#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds **empty-address
// exclusion** feature on the LIVE / online balance source.
//
// Companion to `check-pof-empty-exclusion-browser.mjs`, which proves the
// exclusion for the OFFLINE (vault-data) balance source. The Proof-of-Funds
// page also supports a LIVE on-chain balance source: instead of reading the
// vault, it calls the configured node provider (default: mempool.space's
// Esplora API) over the network. The zero-balance exclusion logic is *shared*
// with the offline path — a resolved balance of 0 becomes an "empty" row that
// is excluded from the table, summarised in an alert, and kept out of the PDF —
// but it is fed by a *different* code path (`balanceSource === "live"`, real
// `fetch` calls), so the offline browser guard never exercises it.
//
// The unit tests (`proof-of-funds-empty-exclusion.test.tsx`) cover the live
// path in jsdom with the provider factory mocked. jsdom has an incomplete
// DOM/layout model, never paints a real PDF, and — most importantly — never
// runs the real Vite-bundled `createProviderFromSettings` → Esplora `fetch`
// path a user actually gets. This script drives the actual page in a headless
// Chromium: it creates a vault, switches to the LIVE source, stubs the
// mempool.space Esplora endpoints with Playwright network interception (one
// funded address returning a non-zero balance, one address returning a genuine
// zero balance), runs the on-chain balance check, and asserts on the real DOM
// plus a real downloaded PDF (re-parsed with pdf.js):
//
//   All-empty case (both addresses zero from the live source):
//     - the "all addresses empty" alert is present
//     - the "Generate PDF" button stays disabled
//     - no individual results-table rows are rendered
//
//   Mixed case (one funded, one empty):
//     - the "N empty addresses excluded" alert is present
//     - the empty address does NOT appear in any results-table row
//     - the funded address DOES appear in a results-table row
//     - the generated PDF contains the funded address and NOT the empty one
//
// The network is fully stubbed (Playwright `route`), so NO request ever leaves
// the machine — the guard is deterministic and offline-safe. pdf.js is only the
// verification *oracle* (KYUTXO never reads PDFs). We load pdf.js's *legacy*
// build because the Nix-pinned test Chromium (v125) predates `Promise.try`,
// which pdfjs' default build/worker needs — same flavor/reason as
// check-pof-empty-exclusion-browser.mjs and check-pdf-glyph-browser.mjs.
//
// Usage: node scripts/check-pof-empty-exclusion-live-browser.mjs
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
const SETUP_PASSWORD = 'pof-empty-live-check-123';

// Two valid mainnet addresses (same fixtures the unit test uses): one funded
// via the stubbed live provider, one returning a genuine zero balance.
const ADDR_FUNDED = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const ADDR_EMPTY = '12higDjoCCNXSA95xZMWUdPvXNmkAduhWv';
const FUNDED_SATS = 500_000;

// Default provider is mempool.space (Esplora) on mainnet. Its base URL is
// https://mempool.space/api and getAddressCoreStats hits /address/<addr>,
// getBlockHeight hits /blocks/tip/height. We intercept both.
const ESPLORA_HOST_GLOB = 'https://mempool.space/api/**';

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

/** Build an Esplora address-stats JSON body for a given confirmed balance. */
function esploraAddressBody(address, balanceSats) {
  const funded = Math.max(0, balanceSats);
  return JSON.stringify({
    address,
    chain_stats: {
      funded_txo_count: funded > 0 ? 1 : 0,
      funded_txo_sum: funded,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: funded > 0 ? 1 : 0,
    },
    mempool_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    },
  });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[pof-empty-live-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[pof-empty-live-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[pof-empty-live-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[pof-empty-live-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];
  let pdfBytes = null;

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
        console.log(`[pof-empty-live-browser][page-console] ${t}`);
      }
    });

    // ── Stub the live Esplora provider (mempool.space). Every case mutates
    // `balanceByAddress`; the route handler reads it per request, so NO real
    // network request ever leaves the machine. ──────────────────────────────
    const balanceByAddress = new Map();
    let liveRequestCount = 0;
    await context.route(ESPLORA_HOST_GLOB, async (route) => {
      const url = route.request().url();
      if (url.includes('/blocks/tip/height')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          body: '840000',
        });
        return;
      }
      const m = url.match(/\/address\/([^/?]+)/);
      if (m) {
        const address = m[1];
        liveRequestCount += 1;
        const sats = balanceByAddress.get(address) ?? 0;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: esploraAddressBody(address, sats),
        });
        return;
      }
      // Any other Esplora endpoint: an empty, well-formed response.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      });
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
    // CASE 1 — all addresses empty (live source returns zero for both)
    // ════════════════════════════════════════════════════════════════════════
    balanceByAddress.clear(); // both addresses resolve to 0
    await page.getByTestId('button-source-live').click();
    await textarea.fill([ADDR_EMPTY, ADDR_FUNDED].join('\n'));
    await page.getByTestId('button-check-balances').click();

    const allEmptyAlert = page.getByTestId('alert-all-empty');
    await allEmptyAlert.waitFor({ state: 'visible', timeout: 20_000 });
    steps.push({
      name: 'all-empty (live): "all addresses empty" alert is shown',
      passed: true,
      detail: 'alert-all-empty became visible',
    });

    steps.push({
      name: 'all-empty (live): the live provider was actually queried',
      passed: liveRequestCount >= 2,
      detail: `intercepted ${liveRequestCount} live address request(s) (expected >= 2)`,
    });

    {
      const pdfDisabled = await page
        .getByTestId('button-generate-pdf')
        .isDisabled();
      steps.push({
        name: 'all-empty (live): Generate PDF button stays disabled',
        passed: pdfDisabled === true,
        detail: pdfDisabled
          ? 'button-generate-pdf is disabled'
          : 'button-generate-pdf was unexpectedly enabled',
      });
    }

    {
      const rowCount = await page.locator('[data-testid^="row-address-"]').count();
      steps.push({
        name: 'all-empty (live): no individual results-table rows are rendered',
        passed: rowCount === 0,
        detail: `found ${rowCount} row(s) (expected 0)`,
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // CASE 2 — one funded, one empty (mixed) from the live source
    // ════════════════════════════════════════════════════════════════════════
    balanceByAddress.set(ADDR_FUNDED, FUNDED_SATS);
    balanceByAddress.set(ADDR_EMPTY, 0);

    await page.getByTestId('button-reset').click();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('button-source-live').click();
    await textarea.fill([ADDR_FUNDED, ADDR_EMPTY].join('\n'));
    await page.getByTestId('button-check-balances').click();

    // The live source resolves addresses sequentially, so the funded address
    // finishing (and its total appearing) does NOT mean the empty address has
    // resolved yet. Wait for the ENTIRE check to complete — the Cancel button is
    // only mounted while `isChecking` is true — before asserting on rows/alerts.
    await page
      .getByTestId('text-total-balance')
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page
      .getByTestId('button-cancel-check')
      .waitFor({ state: 'detached', timeout: 20_000 });

    {
      const excludedVisible = await page
        .getByTestId('alert-empty-excluded')
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'mixed (live): "N empty addresses excluded" alert is shown',
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
        name: 'mixed (live): funded address IS listed in the results table',
        passed: fundedListed === true,
        detail: fundedListed
          ? 'funded address found in a results-table row'
          : 'funded address missing from the results table',
      });
      steps.push({
        name: 'mixed (live): empty address is NOT listed in the results table',
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
      `[pof-empty-live-browser] captured PDF (${pdfBytes.byteLength} bytes, ` +
        `name: ${download.suggestedFilename()})`,
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
      name: 'mixed (live): a PDF was generated',
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
      name: 'mixed (live): funded address appears in the generated PDF',
      passed: fundedInPdf === true,
      detail: fundedInPdf
        ? 'funded address found in the PDF text layer'
        : 'funded address missing from the PDF text layer',
    });
    steps.push({
      name: 'mixed (live): empty address does NOT appear in the generated PDF',
      passed: emptyInPdf === false,
      detail: emptyInPdf
        ? 'empty address unexpectedly leaked into the PDF'
        : 'empty address correctly absent from the PDF',
    });
  }

  const ok = steps.every((s) => s.passed);

  console.log(`[pof-empty-live-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[pof-empty-live-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[pof-empty-live-browser] PASSED: empty-address exclusion holds on the LIVE source in a real browser (table, alerts and PDF).',
  );
}

main().catch((err) => {
  console.error('[pof-empty-live-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
