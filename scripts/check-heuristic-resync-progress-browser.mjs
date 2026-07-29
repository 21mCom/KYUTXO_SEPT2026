#!/usr/bin/env node
// Real-browser regression guard for the heuristic re-sync LIVE progress
// counter on the Balance page.
//
// The heuristic-mode banner's "Re-sync all" action shows, per address, a
// progress line (`text-heuristic-resync-address-progress`) with the address
// being fetched and a live "X/Y transactions fetched" counter
// (`text-heuristic-resync-tx-progress`). The counter only ticks if
// syncSingleAddress keeps streaming onProgress callbacks during the
// syncing-addresses phase (transactionsNew / transactionsFound carry the
// per-transaction "processed / total" counts). A regression anywhere in that
// chain — the onTxProgress plumbing in syncAddress, the progress mapping in
// syncSingleAddress, or the setHeuristicResyncAddressProgress wiring in
// handleResyncHeuristic — would make large addresses look frozen again, and
// only a real browser talking to a live provider can prove the counter
// actually updates.
//
// What this script does:
//   1. Finds a REAL mainnet address with a modest transaction history
//      (3–60 txs) by walking a recent block's inputs on mempool.space —
//      prevout addresses are spent by definition, which is exactly the
//      population the heuristic banner targets. (See
//      .agents/memory/heuristic-resync-browser-verify.md: fake addresses
//      never exercise the real provider fetch.)
//   2. Creates a fresh vault, then seeds via the live Vite module singletons
//      (same-origin dynamic imports => same Dexie instance):
//        - an address record for the real address,
//        - a fake confirmed tx with ONE input participant carrying NO
//          prevTxid/prevVout, which makes buildHasPrevoutByAddress classify
//          the address as heuristic and the banner appear,
//        - node settings pointing at the mempool-space provider.
//   3. Navigates to /balance AFTER seeding (the banner count is read on
//      mount), installs a MutationObserver that samples the progress-line
//      testids on every DOM mutation, and clicks "Re-sync all".
//   4. Asserts the per-address progress line appeared showing the seeded
//      address, and that the "X/Y transactions fetched" counter produced at
//      least two DISTINCT samples with monotonically non-decreasing fetched
//      counts — i.e. the counter genuinely ticked while the sync ran.
//
// Requires live network access to mempool.space (available in this env).
// Usage: node scripts/check-heuristic-resync-progress-browser.mjs
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
const SETUP_PASSWORD = 'heuristic-progress-check-123';
// Esplora-compatible API bases; mempool.space sometimes rate-limits/blocks an
// IP (fetches hang), blockstream.info serves the identical API as fallback.
const ESPLORA_BASES = ['https://mempool.space/api', 'https://blockstream.info/api'];
let MEMPOOL_API = ESPLORA_BASES[0];

async function pickReachableEsploraBase() {
  for (const base of ESPLORA_BASES) {
    try {
      const res = await fetch(`${base}/blocks/tip/hash`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        MEMPOOL_API = base;
        console.log(`[heuristic-resync-progress] esplora base: ${base}`);
        return;
      }
    } catch {
      /* try next base */
    }
  }
  throw new Error('No reachable Esplora API base (mempool.space, blockstream.info).');
}

// The counter renders one value per transaction scanned, so the address needs
// enough txs for the poller to observe at least two distinct counter values —
// tiny histories (e.g. 3-4 txs) fetch inside a single poll tick and flake the
// "counter ticked" assertion. Huge histories make the fetch slow/heavy.
const MIN_TXS = 12;
const MAX_TXS = 60;

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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/**
 * Walk recent blocks' transaction inputs for a real, spent mainnet address
 * with a modest tx history. Prevout addresses seen in a vin are spent by
 * definition (they funded that input), matching the heuristic banner's
 * "spent but no exact prevout data" population.
 */
async function findRealSpentAddress() {
  await pickReachableEsploraBase();
  const tipHash = await (await fetch(`${MEMPOOL_API}/blocks/tip/hash`)).text();
  let blockHash = tipHash.trim();
  const seen = new Set();

  for (let blockIdx = 0; blockIdx < 3; blockIdx++) {
    // First 25 txs of the block are enough candidates.
    const txs = await fetchJson(`${MEMPOOL_API}/block/${blockHash}/txs`);
    for (const tx of txs) {
      for (const vin of tx.vin ?? []) {
        const addr = vin.prevout?.scriptpubkey_address;
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        let info;
        try {
          info = await fetchJson(`${MEMPOOL_API}/address/${addr}`);
        } catch {
          continue;
        }
        const txCount = (info.chain_stats?.tx_count ?? 0);
        const spent = (info.chain_stats?.spent_txo_count ?? 0);
        if (txCount >= MIN_TXS && txCount <= MAX_TXS && spent >= 1) {
          console.log(
            `[heuristic-resync-progress] picked real address ${addr} (tx_count=${txCount}, spent_txo_count=${spent})`,
          );
          return addr;
        }
        if (seen.size >= 60) break;
      }
      if (seen.size >= 60) break;
    }
    // Move to the previous block if this one had no suitable candidate.
    const block = await fetchJson(`${MEMPOOL_API}/block/${blockHash}`);
    blockHash = block.previousblockhash;
    if (!blockHash) break;
  }
  throw new Error(
    `Could not find a mainnet address with ${MIN_TXS}-${MAX_TXS} txs and a spend in recent blocks.`,
  );
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

/** Fill the setup/unlock form when it is showing; no-op otherwise. */
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

/**
 * The legacy-migration overlay (z-index 9999) can appear right after unlock
 * and intercepts all pointer events while visible. Wait it out / dismiss it so
 * subsequent clicks are not swallowed. No-op when it never shows.
 */
async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[heuristic-resync-progress] legacy-migration overlay detected; waiting it out ...');
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

/** chromium.launch can hit EAGAIN under parallel-validation load; retry. */
async function launchChromiumWithRetry(exe, attempts = 3) {
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
      console.log(`[heuristic-resync-progress] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[heuristic-resync-progress] chromium: ${exe}`);

  // Pick the real address before spinning anything else up, so a mempool.space
  // outage fails fast with a clear message.
  const REAL_ADDR = await findRealSpentAddress();
  const SEED_TXID = 'd7e8'.repeat(16); // fake 64-char txid for the seeded no-prevout spend

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[heuristic-resync-progress] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[heuristic-resync-progress] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[heuristic-resync-progress] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchChromiumWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => first load shows the vault setup
    // form. Block the PWA service worker so it cannot serve a stale bundle.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[heuristic-resync-progress][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault (retry the initial goto: cold Vite builds flake) ──
    let landed = false;
    for (let i = 0; i < 2 && !landed; i++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await unlockIfNeeded(page);
        landed = true;
      } catch (err) {
        if (i === 1) throw err;
        console.log(`[heuristic-resync-progress] initial load retry after: ${err.message}`);
      }
    }
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed via the LIVE Vite module singletons ────────────────────────────
    // One address record for the REAL mainnet address, plus one input
    // participant WITHOUT prevTxid/prevVout — buildHasPrevoutByAddress then
    // classifies the address as heuristic-matched, so the banner shows and
    // "Re-sync all" targets exactly this address. Node settings point at the
    // real mempool.space provider so syncSingleAddress streams real progress.
    const seed = await page.evaluate(
      async ({ addr, txid, providerType }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const nodeCrud = await import('/src/lib/data/node-settings-crud.ts');

        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'Heuristic progress check address',
        });
        await txCrud.addTransaction({
          txid,
          blockHeight: 800000,
          blockTime: Math.floor(Date.now() / 1000) - 86400,
          fee: 100,
          feeRate: 1,
          syncedAt: Date.now(),
        });
        // Input participant with NO prevTxid/prevVout => heuristic-matched.
        await txCrud.addParticipant({
          txid,
          role: 'input',
          address: addr,
          amount: 5000,
          recordId,
        });
        await nodeCrud.putNodeSettings({
          id: 'default',
          providerType,
          useTor: false,
          requestTimeout: 30000,
          network: 'mainnet',
          allowLocalNetwork: false,
          trustedLocalHosts: [],
        });
        return { recordId };
      },
      {
        addr: REAL_ADDR,
        txid: SEED_TXID,
        // Match the in-app provider to the Esplora base that is actually
        // reachable from this environment (mempool.space can block an IP).
        providerType: MEMPOOL_API.includes('blockstream') ? 'blockstream' : 'mempool-space',
      },
    );
    steps.push({
      name: 'seeded heuristic address + esplora provider settings',
      passed: Number.isInteger(seed.recordId) && seed.recordId > 0,
      detail: `recordId=${seed.recordId}, address=${REAL_ADDR}`,
    });

    // ── Balance page: navigate AFTER seeding so the mount-time count read
    //    sees the data (the count effect re-reads on dbSignal, not on
    //    dynamic-import writes). ──────────────────────────────────────────────
    await page.goto(`${BASE_URL}balance`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const resyncBtn = page.getByTestId('button-resync-heuristic');
    await resyncBtn.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'heuristic banner appeared with Re-sync all action',
      passed: true,
      detail: 'button-resync-heuristic visible',
    });

    // ── Install a MutationObserver BEFORE clicking, sampling the progress
    //    testids on every DOM mutation. This captures intermediate counter
    //    values even if the sync finishes quickly. ───────────────────────────
    await page.evaluate(() => {
      window.__addrSamples = [];
      window.__txSamples = [];
      const sample = () => {
        const addrEl = document.querySelector('[data-testid="text-heuristic-resync-current-address"]');
        const txEl = document.querySelector('[data-testid="text-heuristic-resync-tx-progress"]');
        if (addrEl) {
          const a = addrEl.textContent.trim();
          if (window.__addrSamples[window.__addrSamples.length - 1] !== a) window.__addrSamples.push(a);
        }
        if (txEl) {
          const t = txEl.textContent.trim();
          if (window.__txSamples[window.__txSamples.length - 1] !== t) window.__txSamples.push(t);
        }
      };
      const mo = new MutationObserver(sample);
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__progressObserver = mo;
    });

    await resyncBtn.click();

    // The progress line must appear while the run is in flight.
    const progressLine = page.getByTestId('text-heuristic-resync-address-progress');
    const lineAppeared = await progressLine
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'per-address progress line appeared during the run',
      passed: lineAppeared,
      detail: lineAppeared
        ? 'text-heuristic-resync-address-progress visible'
        : 'progress line never appeared within 60s of clicking Re-sync all',
    });

    // Wait for the run to finish: the Stop button swaps back to Re-sync all
    // (or the banner disappears entirely because the address was promoted).
    const runDeadline = Date.now() + 180_000;
    while (Date.now() < runDeadline) {
      const stillRunning = await page
        .getByTestId('button-cancel-resync-heuristic')
        .isVisible()
        .catch(() => false);
      if (!stillRunning) break;
      await page.waitForTimeout(500);
    }

    const { addrSamples, txSamples } = await page.evaluate(() => {
      window.__progressObserver?.disconnect();
      return { addrSamples: window.__addrSamples, txSamples: window.__txSamples };
    });
    console.log(`[heuristic-resync-progress] address samples: ${JSON.stringify(addrSamples)}`);
    console.log(
      `[heuristic-resync-progress] tx counter samples (${txSamples.length}): ${JSON.stringify(txSamples.slice(0, 10))}${txSamples.length > 10 ? ' ...' : ''}`,
    );

    // The progress line must have shown the seeded address.
    steps.push({
      name: 'progress line showed the address being fetched',
      passed: addrSamples.includes(REAL_ADDR),
      detail: addrSamples.includes(REAL_ADDR)
        ? `observed current-address "${REAL_ADDR}"`
        : `never observed "${REAL_ADDR}"; saw: ${JSON.stringify(addrSamples)}`,
    });

    // The tx counter must have ticked: >= 2 distinct "X/Y transactions
    // fetched" samples with monotonically non-decreasing fetched counts.
    const parsed = txSamples
      .map((s) => {
        const m = /^([\d,]+)\/([\d,]+)\s+transactions fetched$/.exec(s);
        return m
          ? { fetched: Number(m[1].replace(/,/g, '')), total: Number(m[2].replace(/,/g, '')) }
          : null;
      })
      .filter(Boolean);
    // Later sync phases (e.g. the prevout-resolve pass) reuse the same
    // counter fields with a different total, so scope the tick assertion to
    // the LEADING run of samples sharing the first observed total — that run
    // is the per-address fetch phase this check guards.
    const fetchTotal = parsed.length > 0 ? parsed[0].total : 0;
    const fetchRun = [];
    for (const p of parsed) {
      if (p.total !== fetchTotal) break;
      fetchRun.push(p);
    }
    const distinct = new Set(fetchRun.map((p) => `${p.fetched}/${p.total}`));
    let monotonic = fetchRun.length > 0;
    for (let i = 1; i < fetchRun.length; i++) {
      if (fetchRun[i].fetched < fetchRun[i - 1].fetched) monotonic = false;
    }
    const sawFinal =
      fetchRun.length > 0 &&
      fetchTotal > 0 &&
      fetchRun[fetchRun.length - 1].fetched === fetchTotal;
    steps.push({
      name: 'tx counter updated live (>= 2 distinct well-formed values, non-decreasing)',
      passed:
        parsed.length === txSamples.length && distinct.size >= 2 && monotonic && sawFinal,
      detail:
        `parsed ${parsed.length}/${txSamples.length} samples; fetch-phase run: ${fetchRun.length} samples, ` +
        `${distinct.size} distinct, monotonic=${monotonic}, reached total=${sawFinal}` +
        (fetchRun.length ? `, last=${fetchRun[fetchRun.length - 1].fetched}/${fetchTotal}` : ''),
    });
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

  const ok = steps.every((s) => s.passed);
  console.log(`[heuristic-resync-progress] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[heuristic-resync-progress] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log(
    '[heuristic-resync-progress] PASSED: the per-address re-sync progress line appears and the "X/Y transactions fetched" counter ticks live in a real browser.',
  );
}

main().catch((err) => {
  console.error('[heuristic-resync-progress] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
