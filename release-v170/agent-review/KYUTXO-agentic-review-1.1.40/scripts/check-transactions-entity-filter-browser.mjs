#!/usr/bin/env node
// Real-browser regression guard for the Transactions page entity filters
// (Task #1680: fast entity-filtered Transactions page).
//
// The page now filters transactions by linked address / wallet / seed / owner /
// tag / category (composing with OP_RETURN, include-discovered, and the text
// search) and serves the curated default view without pre-scanning every
// curated record's participants. In the browser preview the engine mirror is
// unavailable, so this exercises the Dexie fallback path end to end — the same
// filters, same semantics, just slower.
//
// The script drives a REAL headless Chromium against the running dev server:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds three address records — Alpha-wallet curated (owner Alice, tag
//      hot), Beta-wallet curated (owner Bob, tag cold), and one
//      blockchain-discovered address that ALSO carries walletName Alpha — plus
//      transactions linked to each (bulk CRUD helpers)
//   3. opens the Transactions page and asserts:
//      - the default curated view counts only the curated transactions
//      - wallet=Alpha filter matches only the curated Alpha transactions
//        (discovered rows excluded by the curated default view)
//      - toggling include-discovered widens wallet=Alpha to the discovered rows
//      - owner=Bob, tag=hot, and exact-address filters return the right counts
//      - an entity filter composes with the text search (single-txid match)
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-transactions-entity-filter-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'tx-entity-filter-check-123';

const ADDR_ALPHA = 'bc1qtxentityfilteralphaownedaddressxxxxx';
const ADDR_BETA = 'bc1qtxentityfilterbetaownedaddressxxxxxx';
const ADDR_DISCOVERED = 'bc1qtxentityfilterdiscoveredaddressxxxxx';

const N_ALPHA = 120; // curated, wallet Alpha, owner Alice, tag hot
const N_BETA = 45; // curated, wallet Beta, owner Bob, tag cold
const N_DISCOVERED = 60; // blockchain-discovered, walletName Alpha (inherited)

function txidFor(prefix, i) {
  return `${prefix}${String(i).padStart(4, '0')}`.padEnd(64, 'e');
}

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



/** Wait until text-total-transactions settles on `expected` (string match). */
async function waitForTotal(page, expected, timeoutMs = 30_000) {
  const el = page.getByTestId('text-total-transactions');
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = ((await el.textContent().catch(() => '')) ?? '').trim();
    if (text.replace(/,/g, '') === String(expected)) return { ok: true, text };
    await page.waitForTimeout(400);
  }
  return { ok: false, text };
}

async function openFilters(page) {
  await page.getByTestId('button-advanced-filters').click();
}

async function selectEntity(page, dimension, value) {
  // Each entity dimension is now a searchable MultiSelectCombobox (cmdk),
  // whose items expose role="option" but no per-item testid.
  await openFilters(page);
  await page.getByTestId(`select-entity-${dimension}`).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  // Close the popover so the page re-queries without an overlay in the way.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

async function clearEntityChip(page, dimension) {
  await page.getByTestId(`button-clear-entity-${dimension}`).click();
}

async function main() {
  const exe = resolveChromium();
  console.log(`[tx-entity-filter-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[tx-entity-filter-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[tx-entity-filter-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel
  // validation load.
  let browser = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`[tx-entity-filter-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 2200 },
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[tx-entity-filter-browser][page-console] ${msg.text()}`);
      }
    });

    await page.goto(`${BASE_URL}transactions`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed via the live Vite module singletons (bulk CRUD helpers) ────────
    const seed = await page.evaluate(
      async ({ addrAlpha, addrBeta, addrDiscovered, nAlpha, nBeta, nDiscovered }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const vocab = await import('/src/lib/data/vocabulary-crud.ts');

        // The entity dropdowns source their values from the vocabulary tables,
        // so register them like the add/import flows do (tolerate duplicates).
        const ensure = async (fn, name) => { try { await fn(name); } catch { /* exists */ } };
        await ensure(vocab.createWalletName, 'Alpha');
        await ensure(vocab.createWalletName, 'Beta');
        await ensure(vocab.createSeedName, 'SeedOne');
        await ensure(vocab.createOwner, 'Alice');
        await ensure(vocab.createOwner, 'Bob');
        await ensure(vocab.createTag, 'hot');
        await ensure(vocab.createTag, 'cold');
        await ensure(vocab.createCategory, 'exchange');

        const alphaId = await recordCrud.createRecord({
          type: 'address', inputString: addrAlpha, label: 'Alpha addr',
          walletName: 'Alpha', seedName: 'SeedOne', owner: 'Alice',
          tags: ['hot'], categories: ['exchange'], addressImportance: 'manual',
        });
        const betaId = await recordCrud.createRecord({
          type: 'address', inputString: addrBeta, label: 'Beta addr',
          walletName: 'Beta', owner: 'Bob', tags: ['cold'], addressImportance: 'verified',
        });
        const discId = await recordCrud.createRecord({
          type: 'address', inputString: addrDiscovered, label: 'Discovered addr',
          walletName: 'Alpha', addressImportance: 'blockchain-discovered',
        });

        const pad = (p, i) => `${p}${String(i).padStart(4, '0')}`.padEnd(64, 'e');
        const now = Math.floor(Date.now() / 1000);
        const txs = [];
        const parts = [];
        const push = (prefix, n, addr, recordId, baseTime) => {
          for (let i = 0; i < n; i++) {
            const txid = pad(prefix, i);
            txs.push({ txid, blockHeight: 800000 + txs.length, blockTime: baseTime - i * 60, fee: 100, feeRate: 1, syncedAt: Date.now() });
            parts.push({ txid, role: 'output', address: addr, amount: 10_000 + i, vout: 0, recordId });
          }
        };
        push('aaaa', nAlpha, addrAlpha, alphaId, now);
        push('bbbb', nBeta, addrBeta, betaId, now - 100_000);
        push('dddd', nDiscovered, addrDiscovered, discId, now - 200_000);

        const CHUNK = 200;
        for (let i = 0; i < txs.length; i += CHUNK) {
          await txCrud.bulkAddTransactions(txs.slice(i, i + CHUNK));
        }
        for (let i = 0; i < parts.length; i += CHUNK) {
          await txCrud.bulkAddParticipants(parts.slice(i, i + CHUNK));
        }
        return { alphaId, betaId, discId, txCount: txs.length };
      },
      {
        addrAlpha: ADDR_ALPHA, addrBeta: ADDR_BETA, addrDiscovered: ADDR_DISCOVERED,
        nAlpha: N_ALPHA, nBeta: N_BETA, nDiscovered: N_DISCOVERED,
      },
    );
    steps.push({
      name: 'seeded vault (3 records, 225 transactions)',
      passed: seed.txCount === N_ALPHA + N_BETA + N_DISCOVERED,
      detail: JSON.stringify(seed),
    });

    // Reload so the page queries see the seeded rows from a clean mount.
    const t0 = Date.now();
    await page.goto(`${BASE_URL}transactions`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    // ── Default curated view: only Alpha+Beta transactions ──────────────────
    const defaultTotal = await waitForTotal(page, N_ALPHA + N_BETA);
    steps.push({
      name: 'default curated view counts only curated transactions',
      passed: defaultTotal.ok,
      detail: `total="${defaultTotal.text}" expected=${N_ALPHA + N_BETA} (loaded in ${Date.now() - t0}ms)`,
    });

    // ── wallet=Alpha (curated default view keeps discovered rows out) ───────
    await selectEntity(page, 'wallet', 'Alpha');
    const walletTotal = await waitForTotal(page, N_ALPHA);
    steps.push({
      name: 'wallet=Alpha filter matches curated Alpha transactions only',
      passed: walletTotal.ok,
      detail: `total="${walletTotal.text}" expected=${N_ALPHA}`,
    });

    // ── include-discovered widens wallet=Alpha to the discovered rows ───────
    await page.getByTestId('button-blockchain-toggle').click();
    const walletAllTotal = await waitForTotal(page, N_ALPHA + N_DISCOVERED);
    steps.push({
      name: 'include-discovered + wallet=Alpha adds the discovered transactions',
      passed: walletAllTotal.ok,
      detail: `total="${walletAllTotal.text}" expected=${N_ALPHA + N_DISCOVERED}`,
    });
    await page.getByTestId('button-blockchain-toggle').click();
    await clearEntityChip(page, 'wallet');

    // ── owner=Bob ────────────────────────────────────────────────────────────
    await selectEntity(page, 'owner', 'Bob');
    const ownerTotal = await waitForTotal(page, N_BETA);
    steps.push({
      name: 'owner=Bob filter matches the Beta transactions',
      passed: ownerTotal.ok,
      detail: `total="${ownerTotal.text}" expected=${N_BETA}`,
    });
    await clearEntityChip(page, 'owner');

    // ── exact address filter (typed, unlinked-participant semantics) ────────
    await openFilters(page);
    await page.getByTestId('input-entity-address').fill(ADDR_BETA);
    await page.keyboard.press('Escape');
    const addrTotal = await waitForTotal(page, N_BETA);
    steps.push({
      name: 'exact address filter matches the Beta transactions',
      passed: addrTotal.ok,
      detail: `total="${addrTotal.text}" expected=${N_BETA}`,
    });
    await clearEntityChip(page, 'address');

    // ── tag=hot ──────────────────────────────────────────────────────────────
    await selectEntity(page, 'tag', 'hot');
    const tagTotal = await waitForTotal(page, N_ALPHA);
    steps.push({
      name: 'tag=hot filter matches the Alpha transactions',
      passed: tagTotal.ok,
      detail: `total="${tagTotal.text}" expected=${N_ALPHA}`,
    });

    // ── entity filter composes with text search (scan path, final step) ─────
    const targetTxid = txidFor('aaaa', 7);
    await page.getByTestId('input-search').fill(targetTxid.slice(0, 16));
    const searchTotal = await waitForTotal(page, 1, 45_000);
    steps.push({
      name: 'tag filter composes with text search down to one match',
      passed: searchTotal.ok,
      detail: `total="${searchTotal.text}" expected=1 (txid prefix search)`,
    });
    const card = page.getByTestId(`card-transaction-${targetTxid.slice(0, 8)}`);
    const cardVisible = await card.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    steps.push({
      name: 'the matching transaction card is rendered',
      passed: cardVisible,
      detail: `card-transaction-${targetTxid.slice(0, 8)} visible=${cardVisible}`,
    });
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
  console.log(`[tx-entity-filter-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[tx-entity-filter-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[tx-entity-filter-browser] PASSED: entity filters work end to end on the Dexie fallback path.');
}

main().catch((err) => {
  console.error('[tx-entity-filter-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
