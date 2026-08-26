#!/usr/bin/env node
// Real-browser regression guard for the Privacy Audit flows that moved into
// the split subfiles (transaction-deep-dive.tsx, boltzmann-heatmap.tsx,
// sankey-helpers.ts, privacy-history-card.tsx).
//
// The adversary-view and dust-badge checks cover two Privacy Audit flows, but
// nothing proved the deep-dive dialog or the Privacy History export still work
// end to end after PrivacyAudit.tsx was split into 8 subfiles. This script
// drives the actual page in headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons) one owned
//      address that participates in a Whirlpool-pattern CoinJoin transaction:
//      2 inputs (one owned) and exactly 5 equal outputs of 100,000 sats — a
//      known pool denomination, so detectCoinJoin flags it COINJOIN_WHIRLPOOL
//      and the txid lands in coinjoinTxids.
//   3. Runs the audit and asserts the COINJOIN_WHIRLPOOL finding card renders.
//   4. Opens the finding's details, clicks the deep-dive button, and asserts
//      the REAL DeepDiveDialog flow: the dialog mounts, the Boltzmann worker
//      produces a result, the link-probability heatmap renders with exactly
//      inputs×outputs (2×5 = 10) cells each showing a percentage, and the
//      CoinJoin fund-flow Sankey SVG is visible (only rendered for CoinJoins).
//   5. Closes the dialog and exercises the Privacy History card recorded by
//      the audit run: Export CSV must download a parseable CSV whose header
//      and data row match the seeded run (score, COINJOIN_WHIRLPOOL count),
//      and Export PDF must download a real PDF (%PDF magic, non-trivial size).
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-privacy-audit-flows-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const AUDIT_URL = `${BASE_URL}privacy-audit`;
const SETUP_PASSWORD = 'audit-flows-check-123';

// One owned address co-spending into a Whirlpool-pattern CoinJoin. Fake-but-
// plausible bech32 strings are fine: the audit engine matches addresses by
// string equality, and every first-8-chars prefix differs so nothing collides.
const ADDR_OWNED = 'bc1qflowown0aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_EXT_IN = 'bc1qflowext1bbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_OUTS = [
  'bc1qflowout2ccccccccccccccccccccccccccccc',
  'bc1qflowout3ddddddddddddddddddddddddddddd',
  'bc1qflowout4eeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'bc1qflowout5fffffffffffffffffffffffffffff',
  'bc1qflowout6ggggggggggggggggggggggggggggg',
];
const COINJOIN_TXID = 'cf10'.repeat(16); // 64 chars; slice(0,8) = "cf10cf10"
const POOL_SATS = 100_000; // 0.001 BTC Whirlpool pool denomination

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

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  const exe = resolveChromium();
  console.log(`[privacy-audit-flows-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[privacy-audit-flows-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[privacy-audit-flows-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[privacy-audit-flows-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    // Fresh context => empty IndexedDB => the "Create Vault" setup form.
    // Block the PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[privacy-audit-flows-browser][page-console] ${t}`);
      }
    });

    await page.goto(AUDIT_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });

    // ── Wait for the Privacy Audit page to render ──────────────────────────
    const runBtn = page.getByTestId('button-run-audit');
    await runBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed: owned address + Whirlpool-pattern CoinJoin transaction ───────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // modules write to the exact same Dexie instance the page reads.
    const seedResult = await page.evaluate(
      async ({ owned, extIn, outs, txid, poolSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        await recordCrud.createRecord({
          type: 'address',
          inputString: owned,
          label: 'Audit-flows check owned input',
        });

        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({
          txid,
          blockHeight: 800_100,
          blockTime: now - 7200,
          fee: 5_000,
          feeRate: 5,
          syncedAt: Date.now(),
        });
        // Two inputs: one owned, one external (typical CoinJoin co-input).
        await txCrud.addParticipant({ txid, role: 'input', address: owned, amount: 250_000, vout: 0 });
        await txCrud.addParticipant({ txid, role: 'input', address: extIn, amount: 255_000, vout: 1 });
        // Exactly 5 equal outputs in a known Whirlpool pool denomination =>
        // detectCoinJoin flags COINJOIN_WHIRLPOOL and adds txid to coinjoinTxids.
        for (let i = 0; i < outs.length; i++) {
          await txCrud.addParticipant({ txid, role: 'output', address: outs[i], amount: poolSats, vout: i });
        }
        return true;
      },
      { owned: ADDR_OWNED, extIn: ADDR_EXT_IN, outs: ADDR_OUTS, txid: COINJOIN_TXID, poolSats: POOL_SATS },
    );
    steps.push({
      name: 'seed: owned address + Whirlpool CoinJoin tx written to vault',
      passed: seedResult === true,
      detail: `seeded ${ADDR_OWNED.slice(0, 14)}… in ${COINJOIN_TXID.slice(0, 8)}… (2 in / 5×${POOL_SATS} out)`,
    });

    // ── Run the audit ───────────────────────────────────────────────────────
    await runBtn.click();
    await page
      .locator('[data-testid="container-score-summary"]')
      .waitFor({ state: 'visible', timeout: 60_000 });

    // ── COINJOIN_WHIRLPOOL finding card renders ─────────────────────────────
    const findingCard = page.locator('[data-testid="card-finding-coinjoin_whirlpool"]');
    const findingVisible = await findingCard
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'audit: COINJOIN_WHIRLPOOL finding card renders after the run',
      passed: findingVisible,
      detail: findingVisible
        ? 'card-finding-coinjoin_whirlpool is visible'
        : 'card-finding-coinjoin_whirlpool never appeared',
    });
    if (!findingVisible) throw new Error('CoinJoin finding card missing — cannot continue.');

    // ── Open the deep-dive dialog from the finding card ─────────────────────
    await findingCard.getByTestId('button-toggle-details').click();
    const deepDiveBtn = findingCard.getByTestId(`button-deep-dive-${COINJOIN_TXID.slice(0, 8)}`);
    await deepDiveBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await deepDiveBtn.click();

    const dialog = page.locator('[data-testid="dialog-deep-dive"]');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    steps.push({
      name: 'deep-dive: dialog opens from the finding card',
      passed: true,
      detail: 'dialog-deep-dive became visible',
    });

    // autoAnalyse runs the Boltzmann worker; result summary appears first.
    await dialog
      .locator('[data-testid="container-boltzmann-result"]')
      .waitFor({ state: 'visible', timeout: 60_000 });

    // ── Heatmap renders with exactly inputs×outputs cells ───────────────────
    {
      const heatmap = dialog.locator('[data-testid="container-boltzmann-heatmap"]');
      const heatmapVisible = await heatmap
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'heatmap: link-probability heatmap renders in the dialog',
        passed: heatmapVisible,
        detail: heatmapVisible
          ? 'container-boltzmann-heatmap is visible'
          : 'container-boltzmann-heatmap never appeared',
      });

      const cellCount = await dialog.locator('[data-testid^="cell-heatmap-"]').count();
      steps.push({
        name: 'heatmap: cell grid matches the seeded 2 inputs × 5 outputs',
        passed: cellCount === 10,
        detail: `found ${cellCount} heatmap cells (expected 10)`,
      });

      const cell00 = (await dialog
        .locator('[data-testid="cell-heatmap-0-0"]')
        .textContent()
        .catch(() => null))?.trim() ?? '';
      // Every input can plausibly fund every output in a 5-equal-output
      // CoinJoin, so cell I0→O0 must show a non-empty percentage, not "–".
      steps.push({
        name: 'heatmap: cell I0→O0 shows a real probability value',
        passed: /^\d+$/.test(cell00),
        detail: `cell-heatmap-0-0 = ${JSON.stringify(cell00)} (expected a number)`,
      });
    }

    // ── CoinJoin Sankey diagram is visible ──────────────────────────────────
    {
      const sankey = dialog.locator('[data-testid="container-coinjoin-sankey"]');
      const sankeyVisible = await sankey
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      const svgCount = sankeyVisible ? await sankey.locator('svg').count() : 0;
      const pathCount = sankeyVisible ? await sankey.locator('svg path').count() : 0;
      steps.push({
        name: 'sankey: CoinJoin fund-flow diagram renders an SVG with flow paths',
        passed: sankeyVisible && svgCount >= 1 && pathCount > 0,
        detail: sankeyVisible
          ? `container-coinjoin-sankey visible with ${svgCount} svg / ${pathCount} paths`
          : 'container-coinjoin-sankey never appeared (only rendered for CoinJoin txs)',
      });
    }

    // ── Close the dialog ────────────────────────────────────────────────────
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });

    // ── Privacy History card was recorded by the audit run ─────────────────
    const historyCard = page.locator('[data-testid="container-privacy-history"]');
    const historyVisible = await historyCard
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'history: Privacy History card appears after the audit run',
      passed: historyVisible,
      detail: historyVisible
        ? 'container-privacy-history is visible'
        : 'container-privacy-history never appeared',
    });
    if (!historyVisible) throw new Error('Privacy History card missing — cannot test exports.');

    const scoreText =
      (await historyCard
        .locator('[data-testid="text-history-score"]')
        .first()
        .textContent()
        .catch(() => null)) ?? '';
    const scoreMatch = scoreText.match(/(\d+)\/100/);
    const recordedScore = scoreMatch ? scoreMatch[1] : null;

    // ── Export CSV: real download with matching header + data row ──────────
    {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        historyCard.getByTestId('button-export-history-csv').click(),
      ]);
      const buf = await readDownload(download);
      const csv = buf.toString('utf8');
      const suggested = download.suggestedFilename();

      const hasHeader = /Score/i.test(csv) && /Grade/i.test(csv);
      const hasScoreRow = recordedScore ? csv.includes(recordedScore) : false;
      const hasCoinjoinColumn = /Whirlpool/i.test(csv) || /COINJOIN_WHIRLPOOL/.test(csv);
      steps.push({
        name: 'export: CSV downloads with header, recorded score, and CoinJoin column',
        passed:
          suggested.endsWith('.csv') && csv.length > 0 && hasHeader && hasScoreRow && hasCoinjoinColumn,
        detail: `file=${suggested} bytes=${buf.length} header=${hasHeader} score(${recordedScore})=${hasScoreRow} coinjoinCol=${hasCoinjoinColumn}`,
      });
    }

    // ── Export PDF: real download with %PDF magic and non-trivial size ─────
    {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        historyCard.getByTestId('button-export-history-pdf').click(),
      ]);
      const buf = await readDownload(download);
      const suggested = download.suggestedFilename();
      const isPdf = buf.subarray(0, 5).toString('latin1').startsWith('%PDF-');
      steps.push({
        name: 'export: PDF downloads as a real PDF document',
        passed: suggested.endsWith('.pdf') && isPdf && buf.length > 1_000,
        detail: `file=${suggested} bytes=${buf.length} magic=${JSON.stringify(buf.subarray(0, 5).toString('latin1'))}`,
      });
    }
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

  console.log(`[privacy-audit-flows-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[privacy-audit-flows-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[privacy-audit-flows-browser] PASSED: deep-dive dialog (heatmap + CoinJoin Sankey) and Privacy History CSV/PDF exports work end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[privacy-audit-flows-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
