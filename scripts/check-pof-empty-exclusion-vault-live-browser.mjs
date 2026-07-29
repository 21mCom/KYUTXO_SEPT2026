#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds **empty-address
// exclusion** feature for the last uncovered source combination: addresses
// selected FROM THE SAVED VAULT (the "From Vault" tab + owner filter) but
// resolved via the LIVE on-chain balance source (`balanceSource === "live"`
// in use-balance-check.ts).
//
// Companions:
//   - check-pof-empty-exclusion-browser.mjs        (pasted + offline)
//   - check-pof-empty-exclusion-live-browser.mjs   (pasted + live)
//   - check-pof-empty-exclusion-vault-browser.mjs  (vault  + offline)
//
// This guard covers vault + live: vault-derived rows are fed into the live
// fetch loop, a different pairing than any sibling exercises. A regression
// specific to that pairing (e.g. an address-normalization difference between
// vault records and the pasted textarea before the Esplora fetch) would slip
// past all three existing guards but fail here.
//
// The script drives the actual page in a headless Chromium: it creates a
// vault, seeds THREE saved address records via the live Vite module singletons
// (record-crud — the same Dexie instance the page uses):
//
//   - ADDR_FUNDED (owner "Alice Holdings") — the stubbed live provider
//     returns a non-zero balance for it
//   - ADDR_EMPTY  (owner "Alice Holdings") — live provider returns zero
//   - ADDR_DECOY  (owner "Bob Reserves")   — live provider WOULD return a
//     non-zero balance, but the owner filter must keep it out of the check
//     entirely (if the filter leaked, the funded decoy would show up; the
//     request counter also proves the live loop never fetched it)
//
// NO vault transaction data is seeded — balances come exclusively from the
// stubbed Esplora endpoints (Playwright network interception, fully offline).
//
//   All-empty case (vault tab, all owners, live source returns zero for all):
//     - the "all addresses empty" alert is present
//     - the "Generate PDF" button stays disabled
//     - no individual results-table rows are rendered
//     - the live provider was actually queried (>= 3 address requests)
//
//   Mixed case (vault tab, owner filter = "Alice Holdings", live source):
//     - the "N empty addresses excluded" alert is present
//     - the funded address DOES appear in a results-table row
//     - the empty address does NOT appear in any results-table row
//     - the DECOY does NOT appear AND was never requested from the live
//       provider (owner filter applied before the fetch loop)
//     - the generated PDF contains the funded address and neither the empty
//       address nor the decoy
//
// pdf.js is only the verification *oracle* (KYUTXO never reads PDFs). We load
// pdf.js's *legacy* build because the Nix-pinned test Chromium (v125) predates
// `Promise.try`, which pdfjs' default build/worker needs — same flavor/reason
// as the sibling guards.
//
// Usage: node scripts/check-pof-empty-exclusion-vault-live-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PROOF_URL = `${BASE_URL}proof-of-funds`;
const SETUP_PASSWORD = 'pof-empty-vault-live-check-123';

// Three valid mainnet addresses with distinct first-8 prefixes.
const ADDR_FUNDED = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const ADDR_EMPTY = '12higDjoCCNXSA95xZMWUdPvXNmkAduhWv';
const ADDR_DECOY = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const OWNER_SELECTED = 'Alice Holdings';
const OWNER_DECOY = 'Bob Reserves';
const FUNDED_SATS = 500_000;
const DECOY_SATS = 750_000;

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
  console.log(`[pof-empty-vault-live-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[pof-empty-vault-live-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[pof-empty-vault-live-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[pof-empty-vault-live-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];
  let pdfBytes = null;
  let decoyEverRequested = false;

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
        console.log(`[pof-empty-vault-live-browser][page-console] ${t}`);
      }
    });

    // ── Stub the live Esplora provider (mempool.space). Every case mutates
    // `balanceByAddress`; the route handler reads it per request, so NO real
    // network request ever leaves the machine. ──────────────────────────────
    const balanceByAddress = new Map();
    let liveRequestCount = 0;
    const requestedAddresses = new Set();
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
        requestedAddresses.add(address);
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

    // Under completion validation several sibling browser checks hammer the
    // same Vite dev server at once, so the first load can be very slow. Retry
    // the initial navigation until the login form actually renders.
    const pwInput = page.getByTestId('input-password');
    let loaded = false;
    for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
      try {
        await page.goto(PROOF_URL, { waitUntil: 'load', timeout: 90_000 });
        await pwInput.waitFor({ state: 'visible', timeout: 60_000 });
        loaded = true;
      } catch (err) {
        if (attempt === 3) throw err;
        console.log(
          `[pof-empty-vault-live-browser] initial load attempt ${attempt} failed (${err.message}); retrying...`,
        );
      }
    }
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // ── Wait for the Proof-of-Funds page to render ─────────────────────────
    const pasteTab = page.getByTestId('tab-paste-addresses');
    await pasteTab.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed the SAVED VAULT: two owners + three address records, via the
    //    live Vite module singletons (same Dexie instance the page uses). No
    //    transaction data is ever seeded — balances come ONLY from the
    //    stubbed live provider. ────────────────────────────────────────────
    const seedRecords = await page.evaluate(
      async ({ funded, empty, decoy, ownerA, ownerB }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const vocabCrud = await import('/src/lib/data/vocabulary-crud.ts');
        for (const name of [ownerA, ownerB]) {
          try {
            await vocabCrud.createOwner(name);
          } catch {
            // already exists — fine
          }
        }
        await recordCrud.createRecord({
          type: 'address',
          inputString: funded,
          label: 'Vault funded address (live-stubbed)',
          owner: ownerA,
        });
        await recordCrud.createRecord({
          type: 'address',
          inputString: empty,
          label: 'Vault empty address',
          owner: ownerA,
        });
        await recordCrud.createRecord({
          type: 'address',
          inputString: decoy,
          label: 'Vault decoy address (other owner)',
          owner: ownerB,
        });
        return true;
      },
      {
        funded: ADDR_FUNDED,
        empty: ADDR_EMPTY,
        decoy: ADDR_DECOY,
        ownerA: OWNER_SELECTED,
        ownerB: OWNER_DECOY,
      },
    );
    steps.push({
      name: 'seed: three saved vault address records (two owners) created',
      passed: seedRecords === true,
      detail:
        `${ADDR_FUNDED} + ${ADDR_EMPTY} (${OWNER_SELECTED}), ` +
        `${ADDR_DECOY} (${OWNER_DECOY})`,
    });

    // ════════════════════════════════════════════════════════════════════════
    // CASE 1 — all vault addresses empty from the LIVE source (stub returns 0
    // for everything). Rows come from the vault tab (all owners).
    // ════════════════════════════════════════════════════════════════════════
    balanceByAddress.clear(); // every address resolves to 0
    await page.getByTestId('tab-vault-addresses').click();
    await page
      .getByTestId('select-filter-owner')
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('button-source-live').click();
    await page.getByTestId('button-check-balances').click();

    const allEmptyAlert = page.getByTestId('alert-all-empty');
    await allEmptyAlert.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'all-empty (vault+live): "all addresses empty" alert is shown',
      passed: true,
      detail: 'alert-all-empty became visible',
    });

    steps.push({
      name: 'all-empty (vault+live): the live provider was actually queried for the vault rows',
      passed: liveRequestCount >= 3,
      detail: `intercepted ${liveRequestCount} live address request(s) (expected >= 3)`,
    });

    {
      const pdfDisabled = await page
        .getByTestId('button-generate-pdf')
        .isDisabled();
      steps.push({
        name: 'all-empty (vault+live): Generate PDF button stays disabled',
        passed: pdfDisabled === true,
        detail: pdfDisabled
          ? 'button-generate-pdf is disabled'
          : 'button-generate-pdf was unexpectedly enabled',
      });
    }

    {
      const rowCount = await page.locator('[data-testid^="row-address-"]').count();
      steps.push({
        name: 'all-empty (vault+live): no individual results-table rows are rendered',
        passed: rowCount === 0,
        detail: `found ${rowCount} row(s) (expected 0)`,
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // CASE 2 — vault tab + owner filter, LIVE source: funded address gets a
    // non-zero stubbed balance, empty stays zero, and the decoy (other owner)
    // would be funded if it ever reached the live loop — the owner filter must
    // keep it out of both the results AND the fetch loop.
    // ════════════════════════════════════════════════════════════════════════
    balanceByAddress.set(ADDR_FUNDED, FUNDED_SATS);
    balanceByAddress.set(ADDR_EMPTY, 0);
    balanceByAddress.set(ADDR_DECOY, DECOY_SATS);
    requestedAddresses.clear();

    await page.getByTestId('button-reset').click();
    await page.getByTestId('tab-vault-addresses').click();
    const ownerTrigger = page.getByTestId('select-filter-owner');
    await ownerTrigger.waitFor({ state: 'visible', timeout: 10_000 });
    await ownerTrigger.click();
    await page
      .getByRole('option', { name: OWNER_SELECTED })
      .click({ timeout: 10_000 });
    // Radix reflects the selection in the trigger text — confirm before running.
    await page.waitForFunction(
      (owner) => {
        const el = document.querySelector('[data-testid="select-filter-owner"]');
        return el && el.textContent && el.textContent.includes(owner);
      },
      OWNER_SELECTED,
      { timeout: 10_000 },
    );
    steps.push({
      name: 'mixed (vault+live): owner filter set via the vault selection UI',
      passed: true,
      detail: `select-filter-owner now shows "${OWNER_SELECTED}"`,
    });

    await page.getByTestId('button-source-live').click();
    await page.getByTestId('button-check-balances').click();

    // The live source resolves addresses sequentially, so the funded address
    // finishing (and its total appearing) does NOT mean the empty address has
    // resolved yet. Wait for the ENTIRE check to complete — the Cancel button
    // is only mounted while `isChecking` is true — before asserting.
    await page
      .getByTestId('text-total-balance')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page
      .getByTestId('button-cancel-check')
      .waitFor({ state: 'detached', timeout: 30_000 });

    {
      const excludedVisible = await page
        .getByTestId('alert-empty-excluded')
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'mixed (vault+live): "N empty addresses excluded" alert is shown',
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
      const decoyListed = rowsText.includes(ADDR_DECOY);
      steps.push({
        name: 'mixed (vault+live): funded address IS listed in the results table',
        passed: fundedListed === true,
        detail: fundedListed
          ? 'funded address found in a results-table row'
          : 'funded address missing from the results table',
      });
      steps.push({
        name: 'mixed (vault+live): empty address is NOT listed in the results table',
        passed: emptyListed === false,
        detail: emptyListed
          ? 'empty address unexpectedly appeared in a results-table row'
          : 'empty address correctly excluded from the results table',
      });
      steps.push({
        name: 'mixed (vault+live): funded DECOY under another owner is NOT listed (owner filter applied)',
        passed: decoyListed === false,
        detail: decoyListed
          ? 'decoy address leaked past the owner filter into the results table'
          : 'decoy address correctly filtered out by owner selection',
      });
    }

    decoyEverRequested = requestedAddresses.has(ADDR_DECOY);
    steps.push({
      name: 'mixed (vault+live): decoy was never fetched from the live provider (filter applied before the fetch loop)',
      passed: decoyEverRequested === false,
      detail: decoyEverRequested
        ? 'live provider received a request for the decoy address'
        : `live loop only requested: ${[...requestedAddresses].join(', ')}`,
    });

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
      `[pof-empty-vault-live-browser] captured PDF (${pdfBytes.byteLength} bytes, ` +
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

  // ── Verify the generated PDF excludes the empty address AND the decoy ────
  if (!pdfBytes || pdfBytes.byteLength === 0) {
    steps.push({
      name: 'mixed (vault+live): a PDF was generated',
      passed: false,
      detail: 'no PDF bytes were captured',
    });
  } else {
    const fullText = await extractPdfText(pdfBytes);
    // pdf.js can split a long mono token across text runs; compare against a
    // whitespace-stripped copy too so a wrapped address still matches.
    const stripped = fullText.replace(/\s+/g, '');
    const has = (needle) =>
      fullText.includes(needle) || stripped.includes(needle);
    const fundedInPdf = has(ADDR_FUNDED);
    const emptyInPdf = has(ADDR_EMPTY);
    const decoyInPdf = has(ADDR_DECOY);
    steps.push({
      name: 'mixed (vault+live): funded address appears in the generated PDF',
      passed: fundedInPdf === true,
      detail: fundedInPdf
        ? 'funded address found in the PDF text layer'
        : 'funded address missing from the PDF text layer',
    });
    steps.push({
      name: 'mixed (vault+live): empty address does NOT appear in the generated PDF',
      passed: emptyInPdf === false,
      detail: emptyInPdf
        ? 'empty address unexpectedly leaked into the PDF'
        : 'empty address correctly absent from the PDF',
    });
    steps.push({
      name: 'mixed (vault+live): funded decoy does NOT appear in the generated PDF',
      passed: decoyInPdf === false,
      detail: decoyInPdf
        ? 'decoy address leaked past the owner filter into the PDF'
        : 'decoy address correctly absent from the PDF',
    });
  }

  const ok = steps.every((s) => s.passed);

  console.log(`[pof-empty-vault-live-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[pof-empty-vault-live-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[pof-empty-vault-live-browser] PASSED: empty-address exclusion holds when vault-selected ' +
      'addresses are checked against the LIVE balance source in a real browser (table, alerts and PDF).',
  );
}

main().catch((err) => {
  console.error('[pof-empty-vault-live-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
