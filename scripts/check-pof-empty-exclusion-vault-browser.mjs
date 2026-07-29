#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds **empty-address
// exclusion** feature when the addresses come from the SAVED VAULT (the
// "From Vault" tab + owner filter), not the paste textarea.
//
// Companion to `check-pof-empty-exclusion-browser.mjs` (offline source, pasted
// addresses) and `check-pof-empty-exclusion-live-browser.mjs` (live source,
// pasted addresses). The Proof-of-Funds page can also build its address row
// list from saved vault records via a wallet/owner filter — a DIFFERENT code
// path (`addressTab === "vault"` in use-balance-check's resolveAddresses reads
// record-crud's getRecordsByType + owner/wallet filtering) that neither
// existing browser guard exercises. jsdom unit tests touch the vault-selection
// path but cannot prove the live, Vite-bundled app excludes a zero-balance
// vault address in a real browser (real DOM alerts, real results table, real
// downloaded PDF).
//
// This script drives the actual page in a headless Chromium: it creates a
// vault, seeds THREE saved address records via the live Vite module singletons
// (record-crud / transaction-crud — the same Dexie instance the page uses):
//
//   - ADDR_FUNDED  (owner "Alice Holdings", wallet "Cold Storage A") — later
//     funded with a confirmed tx
//   - ADDR_EMPTY   (owner "Alice Holdings", wallet "Cold Storage A") — never
//     funded (genuine zero)
//   - ADDR_DECOY   (owner "Bob Reserves", wallet "Hot Wallet B") — FUNDED, but
//     a different owner AND a different wallet name
//
// then selects addresses via the "From Vault" tab (never touching the paste
// textarea), runs the OFFLINE balance check, and asserts:
//
//   All-empty case (vault tab, all owners, before any tx is seeded):
//     - the "all addresses empty" alert is present
//     - the "Generate PDF" button stays disabled
//     - no individual results-table rows are rendered
//
//   Mixed case (vault tab, owner filter = "Alice Holdings"):
//     - the "N empty addresses excluded" alert is present
//     - the funded address DOES appear in a results-table row
//     - the empty address does NOT appear in any results-table row
//     - the DECOY (funded, but different owner) does NOT appear either —
//       proving the owner filter actually narrowed the vault selection (the
//       decoy is funded, so if the filter leaked it would show up)
//     - the generated PDF contains the funded address and neither the empty
//       address nor the decoy
//
//   Wallet-filter case (vault tab, owner = all, wallet = "Cold Storage A"):
//     - `use-balance-check.ts` filters on `r.walletName` in a SEPARATE branch
//       from the owner filter, so the owner case above does not cover it
//     - same assertions: excluded alert, funded listed, empty + funded decoy
//       (different wallet name) absent from the table AND the generated PDF
//
// pdf.js is only the verification *oracle* (KYUTXO never reads PDFs). We load
// pdf.js's *legacy* build because the Nix-pinned test Chromium (v125) predates
// `Promise.try`, which pdfjs' default build/worker needs — same flavor/reason
// as the two sibling guards.
//
// Usage: node scripts/check-pof-empty-exclusion-vault-browser.mjs
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
const SETUP_PASSWORD = 'pof-empty-vault-check-123';

// Three valid mainnet addresses with distinct first-8 prefixes.
const ADDR_FUNDED = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const ADDR_EMPTY = '12higDjoCCNXSA95xZMWUdPvXNmkAduhWv';
const ADDR_DECOY = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const OWNER_SELECTED = 'Alice Holdings';
const OWNER_DECOY = 'Bob Reserves';
const WALLET_SELECTED = 'Cold Storage A';
const WALLET_DECOY = 'Hot Wallet B';
const FUNDED_SATS = 500_000;
const DECOY_SATS = 750_000;
const FUNDED_TXID =
  'a1b2c3d4e5f6071829304152637485960718293041526374859607182930a1b2';
const DECOY_TXID =
  'b2c3d4e5f6071829304152637485960718293041526374859607182930a1b2c3';

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
  console.log(`[pof-empty-vault-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[pof-empty-vault-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[pof-empty-vault-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[pof-empty-vault-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];
  let ownerPdfBytes = null;
  let walletPdfBytes = null;

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
        console.log(`[pof-empty-vault-browser][page-console] ${t}`);
      }
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
          `[pof-empty-vault-browser] initial load attempt ${attempt} failed (${err.message}); retrying...`,
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
    //    transaction data yet, so every saved address has a zero balance. ─────
    const seedRecords = await page.evaluate(
      async ({ funded, empty, decoy, ownerA, ownerB, walletA, walletB }) => {
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
          label: 'Vault funded address',
          owner: ownerA,
          walletName: walletA,
        });
        await recordCrud.createRecord({
          type: 'address',
          inputString: empty,
          label: 'Vault empty address',
          owner: ownerA,
          walletName: walletA,
        });
        await recordCrud.createRecord({
          type: 'address',
          inputString: decoy,
          label: 'Vault decoy address (other owner + other wallet)',
          owner: ownerB,
          walletName: walletB,
        });
        return true;
      },
      {
        funded: ADDR_FUNDED,
        empty: ADDR_EMPTY,
        decoy: ADDR_DECOY,
        ownerA: OWNER_SELECTED,
        ownerB: OWNER_DECOY,
        walletA: WALLET_SELECTED,
        walletB: WALLET_DECOY,
      },
    );
    steps.push({
      name: 'seed: three saved vault address records (two owners, two wallets) created',
      passed: seedRecords === true,
      detail:
        `${ADDR_FUNDED} + ${ADDR_EMPTY} (${OWNER_SELECTED} / ${WALLET_SELECTED}), ` +
        `${ADDR_DECOY} (${OWNER_DECOY} / ${WALLET_DECOY})`,
    });

    // ════════════════════════════════════════════════════════════════════════
    // CASE 1 — all vault addresses empty (no tx data seeded yet). The rows are
    // built from the vault tab (all owners), NOT the paste textarea.
    // ════════════════════════════════════════════════════════════════════════
    await page.getByTestId('tab-vault-addresses').click();
    await page
      .getByTestId('select-filter-owner')
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('button-source-offline').click();
    await page.getByTestId('button-check-balances').click();

    const allEmptyAlert = page.getByTestId('alert-all-empty');
    await allEmptyAlert.waitFor({ state: 'visible', timeout: 20_000 });
    steps.push({
      name: 'all-empty (vault): "all addresses empty" alert is shown',
      passed: true,
      detail: 'alert-all-empty became visible',
    });

    {
      const pdfDisabled = await page
        .getByTestId('button-generate-pdf')
        .isDisabled();
      steps.push({
        name: 'all-empty (vault): Generate PDF button stays disabled',
        passed: pdfDisabled === true,
        detail: pdfDisabled
          ? 'button-generate-pdf is disabled'
          : 'button-generate-pdf was unexpectedly enabled',
      });
    }

    {
      const rowCount = await page.locator('[data-testid^="row-address-"]').count();
      steps.push({
        name: 'all-empty (vault): no individual results-table rows are rendered',
        passed: rowCount === 0,
        detail: `found ${rowCount} row(s) (expected 0)`,
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // Fund the funded address AND the decoy address (confirmed tx + unspent
    // output each). computeStatsForAddresses reads these participant rows, so
    // the offline check now reports non-zero balances for both. The empty
    // address stays at a genuine zero. Funding the DECOY matters: it proves
    // the owner filter below actually excluded it (a funded leak would show).
    // ════════════════════════════════════════════════════════════════════════
    const seedTxs = await page.evaluate(
      async ({ entries }) => {
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const now = Math.floor(Date.now() / 1000);
        for (const { addr, sats, txid } of entries) {
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
        }
        return true;
      },
      {
        entries: [
          { addr: ADDR_FUNDED, sats: FUNDED_SATS, txid: FUNDED_TXID },
          { addr: ADDR_DECOY, sats: DECOY_SATS, txid: DECOY_TXID },
        ],
      },
    );
    steps.push({
      name: 'seed: funded + decoy addresses given confirmed unspent outputs',
      passed: seedTxs === true,
      detail: `${ADDR_FUNDED}=${FUNDED_SATS} sat, ${ADDR_DECOY}=${DECOY_SATS} sat`,
    });

    // ════════════════════════════════════════════════════════════════════════
    // CASE 2 — vault tab + owner filter: one funded, one empty for the chosen
    // owner; a FUNDED decoy under a different owner must be filtered out.
    // ════════════════════════════════════════════════════════════════════════
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
      name: 'mixed (vault): owner filter set via the vault selection UI',
      passed: true,
      detail: `select-filter-owner now shows "${OWNER_SELECTED}"`,
    });

    await page.getByTestId('button-source-offline').click();
    await page.getByTestId('button-check-balances').click();

    await page
      .getByTestId('text-total-balance')
      .waitFor({ state: 'visible', timeout: 20_000 });

    {
      const excludedVisible = await page
        .getByTestId('alert-empty-excluded')
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'mixed (vault): "N empty addresses excluded" alert is shown',
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
        name: 'mixed (vault): funded address IS listed in the results table',
        passed: fundedListed === true,
        detail: fundedListed
          ? 'funded address found in a results-table row'
          : 'funded address missing from the results table',
      });
      steps.push({
        name: 'mixed (vault): empty address is NOT listed in the results table',
        passed: emptyListed === false,
        detail: emptyListed
          ? 'empty address unexpectedly appeared in a results-table row'
          : 'empty address correctly excluded from the results table',
      });
      steps.push({
        name: 'mixed (vault): funded DECOY under another owner is NOT listed (owner filter applied)',
        passed: decoyListed === false,
        detail: decoyListed
          ? 'decoy address leaked past the owner filter into the results table'
          : 'decoy address correctly filtered out by owner selection',
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
    ownerPdfBytes = await readDownloadBytes(download);
    console.log(
      `[pof-empty-vault-browser] captured owner-filter PDF (${ownerPdfBytes.byteLength} bytes, ` +
        `name: ${download.suggestedFilename()})`,
    );

    // ════════════════════════════════════════════════════════════════════════
    // CASE 3 — vault tab + WALLET filter (owner reset to "all"): the wallet
    // filter is a SEPARATE branch in use-balance-check's resolveAddresses
    // (`r.walletName`), so the owner case above does not cover it. The funded
    // decoy carries a different wallet name — if the wallet filter leaked it,
    // it would show up in the table and PDF.
    // ════════════════════════════════════════════════════════════════════════
    await page.getByTestId('button-reset').click();
    await page.getByTestId('tab-vault-addresses').click();

    // handleReset does NOT clear the filters — owner is still set from CASE 2.
    // Reset it to "All owners" so the decoy's exclusion below can only come
    // from the wallet filter.
    const ownerTrigger2 = page.getByTestId('select-filter-owner');
    await ownerTrigger2.waitFor({ state: 'visible', timeout: 10_000 });
    await ownerTrigger2.click();
    await page
      .getByRole('option', { name: 'All owners' })
      .click({ timeout: 10_000 });
    await page.waitForFunction(
      (owner) => {
        const el = document.querySelector('[data-testid="select-filter-owner"]');
        return el && el.textContent && !el.textContent.includes(owner);
      },
      OWNER_SELECTED,
      { timeout: 10_000 },
    );

    const walletTrigger = page.getByTestId('select-filter-wallet');
    await walletTrigger.waitFor({ state: 'visible', timeout: 10_000 });
    await walletTrigger.click();
    await page
      .getByRole('option', { name: WALLET_SELECTED })
      .click({ timeout: 10_000 });
    await page.waitForFunction(
      (wallet) => {
        const el = document.querySelector('[data-testid="select-filter-wallet"]');
        return el && el.textContent && el.textContent.includes(wallet);
      },
      WALLET_SELECTED,
      { timeout: 10_000 },
    );
    steps.push({
      name: 'wallet (vault): owner reset to all + wallet filter set via the vault selection UI',
      passed: true,
      detail: `select-filter-wallet now shows "${WALLET_SELECTED}", owner filter back to All owners`,
    });

    await page.getByTestId('button-source-offline').click();
    await page.getByTestId('button-check-balances').click();

    await page
      .getByTestId('text-total-balance')
      .waitFor({ state: 'visible', timeout: 20_000 });

    {
      const excludedVisible = await page
        .getByTestId('alert-empty-excluded')
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'wallet (vault): "N empty addresses excluded" alert is shown',
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
        name: 'wallet (vault): funded address IS listed in the results table',
        passed: fundedListed === true,
        detail: fundedListed
          ? 'funded address found in a results-table row'
          : 'funded address missing from the results table',
      });
      steps.push({
        name: 'wallet (vault): empty address is NOT listed in the results table',
        passed: emptyListed === false,
        detail: emptyListed
          ? 'empty address unexpectedly appeared in a results-table row'
          : 'empty address correctly excluded from the results table',
      });
      steps.push({
        name: 'wallet (vault): funded DECOY under another wallet is NOT listed (wallet filter applied)',
        passed: decoyListed === false,
        detail: decoyListed
          ? 'decoy address leaked past the wallet filter into the results table'
          : 'decoy address correctly filtered out by wallet selection',
      });
    }

    // ── Fill required declarant fields again and generate the wallet-case PDF ─
    await page.getByTestId('input-declarant-name').fill('Alice Example');
    await page.getByTestId('input-declaration-date').fill('2026-06-30');
    await page.getByTestId('input-purpose').fill('Bank account opening');

    const walletPdfBtn = page.getByTestId('button-generate-pdf');
    await walletPdfBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="button-generate-pdf"]');
        return b && !b.hasAttribute('disabled');
      },
      { timeout: 15_000 },
    );
    await walletPdfBtn.scrollIntoViewIfNeeded({ timeout: 10_000 });
    const [walletDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      walletPdfBtn.click(),
    ]);
    walletPdfBytes = await readDownloadBytes(walletDownload);
    console.log(
      `[pof-empty-vault-browser] captured wallet-filter PDF (${walletPdfBytes.byteLength} bytes, ` +
        `name: ${walletDownload.suggestedFilename()})`,
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

  // ── Verify both generated PDFs exclude the empty address AND the decoy ────
  const pdfCases = [
    {
      label: 'mixed (vault)',
      filterLabel: 'owner filter',
      bytes: ownerPdfBytes,
    },
    {
      label: 'wallet (vault)',
      filterLabel: 'wallet filter',
      bytes: walletPdfBytes,
    },
  ];
  for (const { label, filterLabel, bytes } of pdfCases) {
    if (!bytes || bytes.byteLength === 0) {
      steps.push({
        name: `${label}: a PDF was generated`,
        passed: false,
        detail: 'no PDF bytes were captured',
      });
      continue;
    }
    const fullText = await extractPdfText(bytes);
    // pdf.js can split a long mono token across text runs; compare against a
    // whitespace-stripped copy too so a wrapped address still matches.
    const stripped = fullText.replace(/\s+/g, '');
    const has = (needle) =>
      fullText.includes(needle) || stripped.includes(needle);
    const fundedInPdf = has(ADDR_FUNDED);
    const emptyInPdf = has(ADDR_EMPTY);
    const decoyInPdf = has(ADDR_DECOY);
    steps.push({
      name: `${label}: funded address appears in the generated PDF`,
      passed: fundedInPdf === true,
      detail: fundedInPdf
        ? 'funded address found in the PDF text layer'
        : 'funded address missing from the PDF text layer',
    });
    steps.push({
      name: `${label}: empty address does NOT appear in the generated PDF`,
      passed: emptyInPdf === false,
      detail: emptyInPdf
        ? 'empty address unexpectedly leaked into the PDF'
        : 'empty address correctly absent from the PDF',
    });
    steps.push({
      name: `${label}: funded decoy does NOT appear in the generated PDF`,
      passed: decoyInPdf === false,
      detail: decoyInPdf
        ? `decoy address leaked past the ${filterLabel} into the PDF`
        : 'decoy address correctly absent from the PDF',
    });
  }

  const ok = steps.every((s) => s.passed);

  console.log(`[pof-empty-vault-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[pof-empty-vault-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[pof-empty-vault-browser] PASSED: empty-address exclusion holds when addresses ' +
      'come from the saved vault (owner- AND wallet-filtered) in a real browser (table, alerts and PDFs).',
  );
}

main().catch((err) => {
  console.error('[pof-empty-vault-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
