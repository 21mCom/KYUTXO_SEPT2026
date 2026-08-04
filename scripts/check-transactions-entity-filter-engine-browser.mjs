#!/usr/bin/env node
// Real-browser guard for the Transactions page entity filters when the FAST
// READ-ENGINE serves the page (Task #1866).
//
// scripts/check-transactions-entity-filter-browser.mjs only exercises the Dexie
// fallback — the engine mirror does not exist in the browser preview
// (isEngineAvailable() needs window.electronAPI.engine). This check closes that
// gap with the Task #1859 bridge technique (see
// scripts/check-dashboard-hidden-matches-engine-browser.mjs and
// .agents/memory/browser-engine-bridge-mock.md): an addInitScript-injected
// `window.electronAPI.engine` bridge (deliberately NO isElectron flag) reports
// READY, echoes the app's own ENGINE_SCHEMA_VERSION, and answers the
// transaction-scope queries — getTransactionsFingerprint /
// getParticipantsFingerprint / countTransactions / getTransactionPage —
// straight from the live IndexedDB vault, replicating the worker SQL semantics
// (client/src/lib/engine/engine-core.ts):
//   - entity dimensions AND-compose as independent participant/record txid
//     sets (INTERSECT), each dimension satisfiable by a DIFFERENT participant
//   - curatedOnly = some participant linked to a record with type='address'
//     AND addressImportance IN OWNED_TIERS
//   - page order = (COALESCE(blockTime,0) DESC, id DESC) with a keyset cursor
// Because the fingerprints are computed from the SAME IndexedDB the Dexie side
// reads, the REAL gate — evaluateEngineFreshness('transactions') — elects the
// engine ('ready-fresh'), driving the production engine read path end to end:
//   txCounts        → engineCountTransactions(engineFilterOpts)
//   loadedTransactions → engineGetTransactionPage(keyset) → Dexie hydration
//   search scan     → engineCountTransactions + engineGetTransactionPage batches
//
// Flow (equivalence proof):
//   1. create a fresh vault at /transactions; seed the SAME dataset as the
//      Dexie-fallback check (3 records, 225 transactions)
//   2. PHASE A — bridge inert: walk the filter scenarios on the Dexie fallback,
//      capturing the reported total AND the ordered first-page card testids
//   3. arm the bridge (localStorage flag + the app's ENGINE_SCHEMA_VERSION),
//      reload, assert evaluateEngineFreshness('transactions') === ready-fresh
//   4. Task #1882: the walkthrough also covers the OP_RETURN toggle (engine
//      opReturnOnly, browse + all-tiers) and the amount/date client-side
//      filters composed on the engine candidate scan (Transactions.tsx
//      scanResult path), with bridge proof that opReturnOnly reached both the
//      browse reads and the limit=1000 scan enumeration
//   5. PHASE B — engine-served: walk the SAME scenarios; every scenario must
//      report the same total and render the same ordered rows as phase A, and
//      the bridge instrumentation (window.__engineMock.countCalls/pageCalls)
//      must show the reads were engine-served with the expected filter opts
//
// Everything runs offline against local IndexedDB — no network requests.
// Usage: node scripts/check-transactions-entity-filter-engine-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { buildEngineBridgeInitScript } from './engine-bridge-mock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'tx-entity-engine-check-123';

const ADDR_ALPHA = 'bc1qtxengfilteralphaownedaddressxxxxxxxx';
const ADDR_BETA = 'bc1qtxengfilterbetaownedaddressxxxxxxxxx';
const ADDR_DISCOVERED = 'bc1qtxengfilterdiscoveredaddressxxxxxxxx';

const N_ALPHA = 120; // curated, wallet Alpha, owner Alice, tag hot — blockTime today
const N_BETA = 45; // curated, wallet Beta, owner Bob, tag cold — blockTime 2 days ago
const N_DISCOVERED = 60; // blockchain-discovered, walletName Alpha — blockTime 5 days ago

// OP_RETURN marks (Task #1882): alpha i%3===0, beta i%5===0, discovered i%4===0.
const OPRET_ALPHA = Math.ceil(N_ALPHA / 3); // 40
const OPRET_BETA = Math.ceil(N_BETA / 5); // 9
const OPRET_DISCOVERED = Math.ceil(N_DISCOVERED / 4); // 15
// Amount filter: participant amounts are 10_000+i sats, so min 0.0001006 BTC
// (10_060 sats) keeps alpha i>=60 only (beta tops out at 10_044 sats).
const AMOUNT_MIN_BTC = '0.0001006';
const N_AMOUNT_MIN = 60; // alpha i in 60..119
const N_OPRET_AMOUNT_MIN = 20; // alpha i in {60,63,...,117}

function txidFor(prefix, i) {
  return `${prefix}${String(i).padStart(4, '0')}`.padEnd(64, 'e');
}

// Injected before any app script on every navigation (shared scaffolding in
// scripts/engine-bridge-mock.mjs). Inert until the page sets
// localStorage.__engineMockEnabled = '1', so phase A (vault creation,
// seeding, Dexie-fallback walkthrough) is a plain browser session. The bridge
// implements ONLY the closed set of queries the transactions read path uses;
// anything else returns a failure envelope, which production code treats as
// "fall back to Dexie" — exactly like a real engine error.
const ENGINE_BRIDGE_INIT = buildEngineBridgeInitScript({
  stateFields: `
    countCalls: [], pageCalls: [],
    txFingerprintReads: 0, partFingerprintReads: 0, recFingerprintReads: 0,
    unsupported: [],`,
  helpers: `
  // Same list as OWNED_TIERS in client/src/lib/engine/engine-core.ts — the
  // curatedOnly (default curated view) record predicate.
  const OWNED_TIERS = ['verified', 'manual', 'wallet-import', 'xpub-derived'];

  // Same fields the Dexie getTransactionsFingerprint reports: count, max id,
  // max blockTime (Dexie's blockTime index only holds defined values).
  async function transactionsFingerprint() {
    return withDb(async (idb) => {
      const rows = await getAllRows(idb, 'blockchainTransactions');
      let maxId = 0, maxBlockTime = 0;
      for (const r of rows) {
        const id = Number(r.id) || 0;
        if (id > maxId) maxId = id;
        const bt = typeof r.blockTime === 'number' ? r.blockTime : null;
        if (bt !== null && bt > maxBlockTime) maxBlockTime = bt;
      }
      return { count: rows.length, maxId, maxBlockTime };
    });
  }

  // Same fields the Dexie getParticipantsFingerprint reports; the resolved-
  // prevout count matches the [prevTxid+prevVout] compound index semantics
  // (only rows where BOTH keys are defined/indexable are counted).
  async function participantsFingerprint() {
    return withDb(async (idb) => {
      const rows = await getAllRows(idb, 'transactionParticipants');
      let maxId = 0, resolvedPrevoutCount = 0;
      for (const r of rows) {
        const id = Number(r.id) || 0;
        if (id > maxId) maxId = id;
        if (r.prevTxid !== undefined && r.prevTxid !== null &&
            r.prevVout !== undefined && r.prevVout !== null) {
          resolvedPrevoutCount++;
        }
      }
      return { count: rows.length, maxId, resolvedPrevoutCount };
    });
  }

  // Replicates buildTransactionMatchSubquery: one txid set per active
  // dimension, AND-composed by intersection. Returns null when no dimension is
  // active (no restriction). Each dimension may be satisfied by a DIFFERENT
  // participant of the same transaction — sets are per-dimension, not per-row.
  function matchTxidSet(opts, participants, recordsById) {
    const dims = [];
    const recOf = (p) => (p.recordId != null ? recordsById.get(Number(p.recordId)) : undefined);
    if (opts.address) dims.push((p) => p.address === opts.address);
    if (opts.wallet) dims.push((p) => recOf(p)?.walletName === opts.wallet);
    if (opts.seed) dims.push((p) => recOf(p)?.seedName === opts.seed);
    if (opts.owner) dims.push((p) => recOf(p)?.owner === opts.owner);
    if (opts.tag) dims.push((p) => Array.isArray(recOf(p)?.tags) && recOf(p).tags.includes(opts.tag));
    if (opts.category) dims.push((p) => Array.isArray(recOf(p)?.categories) && recOf(p).categories.includes(opts.category));
    if (opts.curatedOnly) dims.push((p) => {
      const r = recOf(p);
      return !!r && r.type === 'address' && OWNED_TIERS.includes(r.addressImportance);
    });
    if (dims.length === 0) return null;
    let out = null;
    for (const pred of dims) {
      const set = new Set();
      for (const p of participants) if (pred(p)) set.add(p.txid);
      out = out === null ? set : new Set([...out].filter((t) => set.has(t)));
    }
    return out;
  }

  async function loadFilterInputs(idb) {
    const [txs, participants, records] = await Promise.all([
      getAllRows(idb, 'blockchainTransactions'),
      getAllRows(idb, 'transactionParticipants'),
      getAllRows(idb, 'records'),
    ]);
    const recordsById = new Map(records.map((r) => [Number(r.id), r]));
    return { txs, participants, recordsById };
  }

  function filteredTxs(opts, inputs) {
    const set = matchTxidSet(opts || {}, inputs.participants, inputs.recordsById);
    let rows = set === null ? inputs.txs : inputs.txs.filter((t) => set.has(t.txid));
    if (opts && opts.opReturnOnly) rows = rows.filter((t) => !!t.hasOpReturn);
    return rows;
  }

  async function countTransactions(opts) {
    return withDb(async (idb) => filteredTxs(opts, await loadFilterInputs(idb)).length);
  }

  // (COALESCE(blockTime,0) DESC, id DESC) keyset page + per-tx aggregates —
  // the getTransactionPage worker query's shape.
  async function getTransactionPage(opts) {
    return withDb(async (idb) => {
      const inputs = await loadFilterInputs(idb);
      let rows = filteredTxs(opts, inputs);
      const key = (t) => (typeof t.blockTime === 'number' ? t.blockTime : 0);
      rows.sort((a, b) => (key(b) - key(a)) || (Number(b.id) - Number(a.id)));
      const cur = opts && opts.cursor;
      if (cur) {
        rows = rows.filter((t) =>
          key(t) < cur.blockTime || (key(t) === cur.blockTime && Number(t.id) < cur.id));
      }
      rows = rows.slice(0, Math.max(0, Number(opts && opts.limit) || 0));
      const aggs = new Map();
      const wanted = new Set(rows.map((t) => t.txid));
      for (const p of inputs.participants) {
        if (!wanted.has(p.txid)) continue;
        const a = aggs.get(p.txid) || { totalOutputValue: 0, inputCount: 0, outputCount: 0 };
        if (p.role === 'output') { a.totalOutputValue += Number(p.amount) || 0; a.outputCount++; }
        else if (p.role === 'input') a.inputCount++;
        aggs.set(p.txid, a);
      }
      return rows.map((t) => {
        const a = aggs.get(t.txid) || { totalOutputValue: 0, inputCount: 0, outputCount: 0 };
        return {
          id: Number(t.id),
          txid: t.txid,
          blockHeight: t.blockHeight ?? null,
          blockTime: typeof t.blockTime === 'number' ? t.blockTime : null,
          fee: t.fee ?? null,
          feeRate: t.feeRate ?? null,
          vsize: t.vsize ?? null,
          hasOpReturn: t.hasOpReturn ? 1 : 0,
          totalOutputValue: a.totalOutputValue,
          inputCount: a.inputCount,
          outputCount: a.outputCount,
        };
      });
    });
  }
`,
  queryHandlers: `
        if (name === 'getRecordsFingerprint') {
          state.recFingerprintReads++;
          return env(await recordsFingerprint());
        }
        if (name === 'getTransactionsFingerprint') {
          state.txFingerprintReads++;
          return env(await transactionsFingerprint());
        }
        if (name === 'getParticipantsFingerprint') {
          state.partFingerprintReads++;
          return env(await participantsFingerprint());
        }
        if (name === 'countTransactions') {
          const n = await countTransactions(opts || {});
          state.countCalls.push({ opts: opts || {}, result: n });
          return env(n);
        }
        if (name === 'getTransactionPage') {
          const rows = await getTransactionPage(opts || {});
          state.pageCalls.push({
            opts: {
              address: opts?.address, wallet: opts?.wallet, seed: opts?.seed,
              owner: opts?.owner, tag: opts?.tag, category: opts?.category,
              curatedOnly: !!opts?.curatedOnly, opReturnOnly: !!opts?.opReturnOnly,
              limit: Number(opts?.limit) || 0, cursor: opts?.cursor ?? null,
            },
            txids: rows.map((r) => r.txid),
          });
          return env(rows);
        }
`,
});

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

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await overlay.isVisible().catch(() => false))) return;
    const dismiss = page.getByTestId('button-dismiss-migration');
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  throw new Error('legacy-migration overlay did not clear within 60s');
}

async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await dismissMigrationOverlayIfPresent(page);
    return false;
  }
  await pwInput.fill(SETUP_PASSWORD);
  const confirmInput = page.getByTestId('input-confirm-password');
  if (await confirmInput.isVisible().catch(() => false)) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
  return true;
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

/** Ordered testids of the currently rendered transaction cards. */
async function visibleCardIds(page) {
  return page.$$eval('[data-testid^="card-transaction-"]', (els) =>
    els.map((el) => el.getAttribute('data-testid')),
  );
}

async function openFilters(page) {
  await page.getByTestId('button-advanced-filters').click();
}

/**
 * Activate a Radix TabsTrigger inside the filters popover. Coordinate clicks
 * can hang mid-action against portal-rendered popover content (see
 * .agents/memory/detail-panel-click-races.md), so dispatch the events Radix
 * listens to directly (mousedown activates the tab, click for completeness).
 */
async function activateTab(page, testid) {
  const el = page.getByTestId(testid);
  await el.waitFor({ state: 'attached' });
  await el.dispatchEvent('mousedown');
  await el.dispatchEvent('click');
}

/**
 * Set a controlled React input's value without Playwright's actionability
 * polling (which wedges against this popover — same bug class as the tab
 * clicks above). Uses the native value setter so React's onChange fires.
 */
async function setInputValue(page, testid, value) {
  const el = page.getByTestId(testid);
  await el.waitFor({ state: 'attached' });
  await el.evaluate((node, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(node, v);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function selectEntity(page, dimension, value) {
  await openFilters(page);
  await page.getByTestId(`select-entity-${dimension}`).click();
  await page.getByTestId(`option-entity-${dimension}-${value}`).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

async function clearEntityChip(page, dimension) {
  await page.getByTestId(`button-clear-entity-${dimension}`).click();
}

/**
 * Drive the full filter scenario walkthrough once. Returns
 * { scenario: { total, ok, text, cards } } keyed by scenario name. Each
 * scenario's expected total is asserted here too (both phases must agree with
 * the seeded ground truth, not merely with each other).
 */
async function runScenarioWalkthrough(page) {
  const out = {};
  const capture = async (name, expected, timeoutMs) => {
    const res = await waitForTotal(page, expected, timeoutMs);
    // Give the row list a beat to settle on the same query the total answered.
    await page.waitForTimeout(500);
    out[name] = { expected, ok: res.ok, text: res.text, cards: await visibleCardIds(page) };
  };

  await capture('default-curated', N_ALPHA + N_BETA);

  await selectEntity(page, 'wallet', 'Alpha');
  await capture('wallet-alpha', N_ALPHA);

  await page.getByTestId('button-blockchain-toggle').click();
  await capture('wallet-alpha-include-discovered', N_ALPHA + N_DISCOVERED);
  await page.getByTestId('button-blockchain-toggle').click();
  await clearEntityChip(page, 'wallet');

  await selectEntity(page, 'owner', 'Bob');
  await capture('owner-bob', N_BETA);
  await clearEntityChip(page, 'owner');

  await openFilters(page);
  await page.getByTestId('input-entity-address').fill(ADDR_BETA);
  await page.keyboard.press('Escape');
  await capture('address-beta', N_BETA);
  await clearEntityChip(page, 'address');

  await selectEntity(page, 'tag', 'hot');
  await capture('tag-hot', N_ALPHA);

  const targetTxid = txidFor('aaaa', 7);
  await page.getByTestId('input-search').fill(targetTxid.slice(0, 16));
  await capture('tag-hot-plus-search', 1, 45_000);

  // ── Task #1882: OP_RETURN toggle + amount/date client-side filters ────────
  // These run LAST, and interact via evaluate/dispatchEvent instead of
  // coordinate clicks: after the scan scenarios, Playwright's actionability
  // polling wedges against this page (fills hang "waiting for editable",
  // popover children flap attached/detached mid-click).
  await setInputValue(page, 'input-search', '');
  await page.getByTestId('button-clear-entity-tag').dispatchEvent('click');
  await capture('reset-default-curated', N_ALPHA + N_BETA);

  // OP_RETURN toggle on the curated default view (engine opReturnOnly+curatedOnly).
  await page.getByTestId('button-opreturn-filter').dispatchEvent('click');
  await capture('opreturn-curated', OPRET_ALPHA + OPRET_BETA);

  // OP_RETURN across all tiers (engine opReturnOnly without curatedOnly).
  await page.getByTestId('button-blockchain-toggle').dispatchEvent('click');
  await capture('opreturn-all-tiers', OPRET_ALPHA + OPRET_BETA + OPRET_DISCOVERED);
  await page.getByTestId('button-blockchain-toggle').dispatchEvent('click');

  // Amount filter composed ON TOP of the OP_RETURN toggle: drives the
  // scanResult candidate scan (engine enumerates opReturnOnly+curatedOnly
  // candidates in SQL, amount filters client-side on the stream).
  await page.getByTestId('button-advanced-filters').dispatchEvent('click');
  await activateTab(page, 'tab-amount-range');
  await setInputValue(page, 'input-amount-min', AMOUNT_MIN_BTC);
  await page.keyboard.press('Escape');
  await capture('opreturn-plus-amount-min', N_OPRET_AMOUNT_MIN, 45_000);
  await page.getByTestId('button-clear-amount-filter').dispatchEvent('click');
  await page.getByTestId('button-opreturn-filter').dispatchEvent('click'); // OP_RETURN off

  // Amount filter alone on the curated view (scanResult path, no OP_RETURN).
  await page.getByTestId('button-advanced-filters').dispatchEvent('click');
  await activateTab(page, 'tab-amount-range');
  await setInputValue(page, 'input-amount-min', AMOUNT_MIN_BTC);
  await page.keyboard.press('Escape');
  await capture('amount-min-curated', N_AMOUNT_MIN, 45_000);
  await page.getByTestId('button-clear-amount-filter').dispatchEvent('click');

  // Date filter (From = today via the calendar): only today's alpha rows match.
  await page.getByTestId('button-advanced-filters').dispatchEvent('click');
  await activateTab(page, 'tab-date-range');
  await page.getByTestId('button-date-start').dispatchEvent('click');
  const todayCell = page.locator('.rdp button.bg-accent').first();
  await todayCell.waitFor({ state: 'attached' });
  await todayCell.dispatchEvent('click'); // today cell
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await capture('date-from-today-curated', N_ALPHA, 45_000);
  await page.getByTestId('button-clear-date-filter').dispatchEvent('click');

  // No reset needed: each phase starts from a fresh navigation.
  return out;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[tx-entity-engine-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[tx-entity-engine-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[tx-entity-engine-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel load.
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
      console.log(`[tx-entity-engine-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 2200 },
    });
    await context.addInitScript(ENGINE_BRIDGE_INIT);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[tx-entity-engine-browser][page-console] ${msg.text()}`);
      }
    });

    // ── 1. Create the vault (engine bridge still inert) ─────────────────────
    await page.goto(`${BASE_URL}transactions`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── 2. Seed — identical dataset to the Dexie-fallback check ─────────────
    const seed = await page.evaluate(
      async ({ addrAlpha, addrBeta, addrDiscovered, nAlpha, nBeta, nDiscovered }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const vocab = await import('/src/lib/data/vocabulary-crud.ts');

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
        // Deterministic, date-diverse blockTimes anchored on LOCAL midnight so
        // the calendar-driven date filter has a stable ground truth: alpha is
        // today (01:00 + i minutes), beta 2 days ago, discovered 5 days ago.
        // Every blockTime is unique, so the Dexie blockTime-desc sort needs no
        // id tie-break to agree with the engine ordering.
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const t0 = Math.floor(todayStart.getTime() / 1000);
        const txs = [];
        const parts = [];
        const push = (prefix, n, addr, recordId, baseTime, opReturnEvery) => {
          for (let i = 0; i < n; i++) {
            const txid = pad(prefix, i);
            txs.push({
              txid, blockHeight: 800000 + txs.length, blockTime: baseTime + i * 60,
              fee: 100, feeRate: 1, syncedAt: Date.now(),
              hasOpReturn: i % opReturnEvery === 0,
            });
            parts.push({ txid, role: 'output', address: addr, amount: 10_000 + i, vout: 0, recordId });
          }
        };
        push('aaaa', nAlpha, addrAlpha, alphaId, t0 + 3_600, 3);
        push('bbbb', nBeta, addrBeta, betaId, t0 - 2 * 86_400, 5);
        push('dddd', nDiscovered, addrDiscovered, discId, t0 - 5 * 86_400, 4);

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

    // ── 3. PHASE A — Dexie fallback baseline (bridge inert) ─────────────────
    await page.goto(`${BASE_URL}transactions`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const noEngine = await page.evaluate(async () => {
      const { isEngineAvailable } = await import('/src/lib/engine/engine-client.ts');
      return !isEngineAvailable();
    });
    steps.push({
      name: 'phase A runs without the engine (Dexie fallback baseline)',
      passed: noEngine,
      detail: `isEngineAvailable=${!noEngine}`,
    });

    const dexie = await runScenarioWalkthrough(page);
    for (const [name, r] of Object.entries(dexie)) {
      steps.push({
        name: `phase A (Dexie): ${name} total=${r.expected}`,
        passed: r.ok,
        detail: `total="${r.text}" expected=${r.expected}, ${r.cards.length} cards rendered`,
      });
    }

    // ── 4. Arm the bridge with the app's own schema version; reload ─────────
    await page.evaluate(async () => {
      const { ENGINE_SCHEMA_VERSION } = await import('/src/lib/engine/engine-core.ts');
      localStorage.setItem('__engineMockSchemaVersion', String(ENGINE_SCHEMA_VERSION));
      localStorage.setItem('__engineMockEnabled', '1');
    });
    await page.goto(`${BASE_URL}transactions`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const gate = await page.evaluate(async () => {
      const { isEngineAvailable } = await import('/src/lib/engine/engine-client.ts');
      const { evaluateEngineFreshness } = await import('/src/lib/engine/engine-freshness.ts');
      const decision = await evaluateEngineFreshness('transactions');
      return { available: isEngineAvailable(), decision };
    });
    steps.push({
      name: "engine bridge active: evaluateEngineFreshness('transactions') elects the engine (ready-fresh)",
      passed: gate.available && gate.decision.useEngine === true && gate.decision.reason === 'ready-fresh',
      detail: JSON.stringify(gate),
    });

    // ── 5. PHASE B — the same walkthrough, engine-served ────────────────────
    const callsBefore = await page.evaluate(() => ({
      counts: window.__engineMock?.countCalls.length ?? -1,
      pages: window.__engineMock?.pageCalls.length ?? -1,
    }));
    const engineRes = await runScenarioWalkthrough(page);
    const mock = await page.evaluate(() => ({
      countCalls: window.__engineMock?.countCalls ?? [],
      pageCalls: (window.__engineMock?.pageCalls ?? []).map((c) => c.opts),
      queryErrors: window.__engineMock?.queryErrors ?? ['__engineMock missing'],
      unsupported: window.__engineMock?.unsupported ?? [],
      txFingerprintReads: window.__engineMock?.txFingerprintReads ?? 0,
      partFingerprintReads: window.__engineMock?.partFingerprintReads ?? 0,
    }));

    for (const [name, r] of Object.entries(engineRes)) {
      const base = dexie[name];
      const sameTotal = r.ok && base?.ok && r.text === base.text;
      const sameRows = JSON.stringify(r.cards) === JSON.stringify(base?.cards);
      steps.push({
        name: `phase B (engine): ${name} matches the Dexie fallback (total + rendered rows)`,
        passed: sameTotal && sameRows,
        detail: `engine total="${r.text}" dexie total="${base?.text}" expected=${r.expected}; ` +
          `rowsEqual=${sameRows} (engine ${r.cards.length} vs dexie ${base?.cards.length} cards)`,
      });
    }

    // Engine-served proof: the walkthrough must have driven count AND page
    // reads through the bridge, with the expected filter opts observed, and
    // the bridge must never have thrown while answering.
    const sawOpts = (arr, pred) => arr.some(pred);
    const countOpts = mock.countCalls.map((c) => c.opts);
    const proof = {
      countCallsDuringWalkthrough: mock.countCalls.length - Math.max(0, callsBefore.counts),
      pageCallsDuringWalkthrough: mock.pageCalls.length - Math.max(0, callsBefore.pages),
      sawCuratedDefault: sawOpts(countOpts, (o) => o.curatedOnly === true && !o.wallet && !o.owner && !o.address && !o.tag),
      sawWalletAlphaCurated: sawOpts(countOpts, (o) => o.wallet === 'Alpha' && o.curatedOnly === true),
      sawWalletAlphaAllTiers: sawOpts(countOpts, (o) => o.wallet === 'Alpha' && !o.curatedOnly),
      sawOwnerBob: sawOpts(countOpts, (o) => o.owner === 'Bob'),
      sawAddressBeta: sawOpts(countOpts, (o) => o.address === ADDR_BETA),
      sawTagHot: sawOpts(countOpts, (o) => o.tag === 'hot'),
      pageSawWalletAlpha: sawOpts(mock.pageCalls, (o) => o.wallet === 'Alpha' && o.curatedOnly === true),
      pageSawTagHot: sawOpts(mock.pageCalls, (o) => o.tag === 'hot'),
      // Task #1882: opReturnOnly must reach the engine on the browse count/page
      // reads AND on the scanResult candidate enumeration (limit=1000 batches);
      // amount/date scans run the same enumeration with curatedOnly only.
      sawOpReturnCurated: sawOpts(countOpts, (o) => o.opReturnOnly === true && o.curatedOnly === true),
      sawOpReturnAllTiers: sawOpts(countOpts, (o) => o.opReturnOnly === true && !o.curatedOnly),
      pageSawOpReturnBrowse: sawOpts(mock.pageCalls, (o) => o.opReturnOnly === true && o.limit !== 1000),
      scanSawOpReturnCandidates: sawOpts(mock.pageCalls, (o) => o.opReturnOnly === true && o.curatedOnly === true && o.limit === 1000),
      scanSawCuratedCandidates: sawOpts(mock.pageCalls, (o) => !o.opReturnOnly && o.curatedOnly === true && o.limit === 1000),
      queryErrors: mock.queryErrors,
      unsupported: mock.unsupported,
      txFingerprintReads: mock.txFingerprintReads,
      partFingerprintReads: mock.partFingerprintReads,
    };
    steps.push({
      name: 'phase B reads were engine-served (bridge saw the count+page queries with the expected filter opts)',
      passed:
        proof.countCallsDuringWalkthrough > 0 &&
        proof.pageCallsDuringWalkthrough > 0 &&
        proof.sawCuratedDefault && proof.sawWalletAlphaCurated && proof.sawWalletAlphaAllTiers &&
        proof.sawOwnerBob && proof.sawAddressBeta && proof.sawTagHot &&
        proof.pageSawWalletAlpha && proof.pageSawTagHot &&
        proof.sawOpReturnCurated && proof.sawOpReturnAllTiers &&
        proof.pageSawOpReturnBrowse && proof.scanSawOpReturnCandidates &&
        proof.scanSawCuratedCandidates &&
        proof.txFingerprintReads > 0 && proof.partFingerprintReads > 0 &&
        proof.queryErrors.length === 0,
      detail: JSON.stringify(proof),
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
  console.log(`[tx-entity-engine-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[tx-entity-engine-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[tx-entity-engine-browser] PASSED: entity filters return identical rows on the engine-served path.');
}

main().catch((err) => {
  console.error('[tx-entity-engine-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
