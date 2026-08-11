#!/usr/bin/env node
// Real-browser regression guard for the Dusted page's spent-dust damage
// details at scale.
//
// NOTE for reviewers: the page under test is client/src/pages/DustedPage.tsx,
// routed at /dusted. computeDustings pass 3 resolves each spent dust output's
// spending transaction (getParticipantsByPrevOutKeys), that tx's co-input
// addresses (getParticipantsByTxids), and classifies them owned-in-scope /
// owned-out-of-scope / external (getRecordsByInputStrings). jsdom coverage
// lives in client/src/pages/DustedPage.spendDamage.test.tsx; this script
// proves the wiring in headless Chromium on a huge vault:
//   1. Create a fresh vault, seed N owned dust addresses whose single dust
//      output was spent — K dust outputs per shared spending tx plus one
//      external co-input per tx (via the live Vite CRUD singletons).
//   2. Reload once so the page scans the seeded vault.
//   3. Prove the scan stays cancellable mid-run (CPU-throttled), then run it
//      to completion.
//   4. Assert the damage summary banner shows the exact expected counts
//      (N spent outputs, N/K spending txs, N linked addresses).
//   5. Expand the first row and assert the Spent section renders: outpoint,
//      sats, harmful badge, spending TxidLink, owned AddressLink chips, and
//      the external-address count.
//   6. Scoped scan (pass 3c): switch scope to "By Wallet" → "Wallet A"
//      (records alternate Wallet A / Wallet B), re-assert the banner counts
//      for the scoped run, and prove the spend row still credits the other
//      wallet's co-inputs as OWNED out-of-scope AddressLink chips (resolved
//      via getRecordsByInputStrings) instead of lumping them into the
//      external count.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-dusted-spend-damage-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}dusted`;
const SETUP_PASSWORD = 'dusted-spend-check-123';

const N = 5000; // spent dust outputs (one per owned address)
const K = 20; // dust outputs combined per spending transaction
const SPEND_TX_COUNT = N / K;
const DUST_SATS = 500; // below the default 1000-sat threshold
const fmt = (n) => n.toLocaleString('en-US');

// Deterministic identifiers. Even-indexed dust addresses ("bc1qdust", Wallet A)
// and odd-indexed ones ("bc1qothr", Wallet B) use distinct prefixes so the
// scoped step can tell in-scope vs out-of-scope AddressLink chips apart by
// their `link-address-<first8>` testid. Counts within a row are still the
// primary assertion.
const dustAddr = (i) =>
  i % 2 === 0
    ? (`bc1qdust${String(i).padStart(6, '0')}` + 'q'.repeat(42)).slice(0, 42)
    : (`bc1qothr${String(i).padStart(6, '0')}` + 'q'.repeat(42)).slice(0, 42);
const extAddr = (g) => (`bc1qext${String(g).padStart(6, '0')}` + 'x'.repeat(42)).slice(0, 42);
const dustTxid = (i) => i.toString(16).padStart(8, '0') + 'dd'.repeat(28);
// Offset spend txids so their first-8-char testid prefix never collides with a
// dust txid's prefix.
const spendTxid = (g) => (0x10000000 + g).toString(16).padStart(8, '0') + 'ee'.repeat(28);

const TARGET_ADDR = dustAddr(0); // lexicographically smallest → first result row
const TARGET_DUST_TXID = dustTxid(0);
const TARGET_SPEND_TXID = spendTxid(0);

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.');
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

async function launchWithRetry(exe) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(`[dusted-spend-damage-browser] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dusted-spend-damage-browser] chromium: ${exe}`);

  let devProc = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[dusted-spend-damage-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[dusted-spend-damage-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[dusted-spend-damage-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[dusted-spend-damage-browser] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    // Fresh context => empty IndexedDB => "Create Vault" setup form. Block the
    // PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) console.log(`[dusted-spend-damage-browser][page-console] ${t}`);
    });
    const cdp = await context.newCDPSession(page);

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault ──────────────────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // Dismiss the legacy-migration overlay if it appears, or it swallows clicks.
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 3_000 })
      .catch(() => {});

    // Dusted page header renders once unlocked.
    await page.getByTestId('text-page-title').waitFor({ state: 'visible', timeout: 30_000 });

    // Re-unlock helper: every reload returns to the lock screen (session key).
    const unlockIfNeeded = async () => {
      const pw = page.getByTestId('input-password');
      const title = page.getByTestId('text-page-title');
      const first = await Promise.race([
        pw.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'locked'),
        title.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'unlocked'),
      ]).catch(() => 'timeout');
      if (first === 'locked') {
        await pw.fill(SETUP_PASSWORD);
        await page.getByTestId('button-submit').click();
        await page
          .getByTestId('button-dismiss-migration')
          .click({ timeout: 3_000 })
          .catch(() => {});
      }
      await title.waitFor({ state: 'visible', timeout: 30_000 });
    };

    // ── Seed: N owned dust addresses, each with one spent dust output ─────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // modules write to the exact same Dexie instance the page reads.
    const seedStart = Date.now();
    const targetRecordId = await page.evaluate(
      async ({ n, k, dustSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const vocabCrud = await import('/src/lib/data/vocabulary-crud.ts');

        // Wallet vocabulary rows so the "By Wallet" scope dropdown has values
        // (bulk create below skips vocabulary sync for speed).
        await vocabCrud.ensureWalletName('Wallet A');
        await vocabCrud.ensureWalletName('Wallet B');

        const dustAddr = (i) =>
          i % 2 === 0
            ? (`bc1qdust${String(i).padStart(6, '0')}` + 'q'.repeat(42)).slice(0, 42)
            : (`bc1qothr${String(i).padStart(6, '0')}` + 'q'.repeat(42)).slice(0, 42);
        const extAddr = (g) => (`bc1qext${String(g).padStart(6, '0')}` + 'x'.repeat(42)).slice(0, 42);
        const dustTxid = (i) => i.toString(16).padStart(8, '0') + 'dd'.repeat(28);
        const spendTxid = (g) => (0x10000000 + g).toString(16).padStart(8, '0') + 'ee'.repeat(28);

        // Records (chunked bulk insert, vocabulary sync skipped for speed).
        let firstId = null;
        const REC_CHUNK = 1000;
        for (let start = 0; start < n; start += REC_CHUNK) {
          const chunk = [];
          for (let i = start; i < Math.min(start + REC_CHUNK, n); i++) {
            chunk.push({
              type: 'address',
              inputString: dustAddr(i),
              label: `Dust target ${i}`,
              walletName: i % 2 === 0 ? 'Wallet A' : 'Wallet B',
            });
          }
          const ids = await recordCrud.bulkCreateRecords(chunk, {
            skipVocabularySync: true,
            skipNotification: true,
          });
          if (start === 0) firstId = ids[0];
        }

        // Participants: one dust output per address; each group of k dust
        // outputs is spent together by one shared spending tx that also has
        // one external co-input.
        const PART_CHUNK = 2000;
        let parts = [];
        const flush = async () => {
          if (parts.length === 0) return;
          await txCrud.bulkAddParticipants(parts);
          parts = [];
        };
        for (let i = 0; i < n; i++) {
          const g = Math.floor(i / k);
          parts.push({ txid: dustTxid(i), role: 'output', address: dustAddr(i), amount: dustSats, vout: 0 });
          parts.push({
            txid: spendTxid(g),
            role: 'input',
            address: dustAddr(i),
            amount: dustSats,
            prevTxid: dustTxid(i),
            prevVout: 0,
          });
          if (i % k === 0) {
            parts.push({
              txid: spendTxid(g),
              role: 'input',
              address: extAddr(g),
              amount: 50_000,
              prevTxid: (0x20000000 + g).toString(16).padStart(8, '0') + 'ff'.repeat(28),
              prevVout: 0,
            });
          }
          if (parts.length >= PART_CHUNK) await flush();
        }
        await flush();
        return firstId;
      },
      { n: N, k: K, dustSats: DUST_SATS },
    );
    record(
      'seed',
      typeof targetRecordId === 'number',
      `${fmt(N)} owned dust addresses + ${fmt(SPEND_TX_COUNT)} spending txs seeded in ${((Date.now() - seedStart) / 1000).toFixed(1)}s (target recordId=${targetRecordId})`,
    );

    // Reload once so the page's auto-scan runs against the fully seeded vault.
    await page.reload({ waitUntil: 'load' });
    await unlockIfNeeded();

    // ── Cancellability: cancel a mid-flight scan, expect a clean idle ──────
    // The scan auto-starts on mount. Throttle the CPU so it spans enough
    // progress frames for the cancel click; escalate throttle on retry if the
    // scan finishes before we get the click in.
    let cancelled = false;
    let cancelDetail = '';
    for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
      const rate = 4 * 2 ** attempt;
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      if (attempt > 0) {
        // Kick off a fresh scan (Re-scan/Scan button shows when not computing).
        await page
          .getByTestId('button-run-scan')
          .dispatchEvent('click')
          .catch(() => {});
      }
      const cancelBtn = page.getByTestId('button-cancel-scan');
      const sawComputing = await cancelBtn
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (!sawComputing) {
        cancelDetail = `attempt ${attempt + 1} (rate ${rate}x): scan finished before cancel button was clickable`;
        continue;
      }
      await cancelBtn.dispatchEvent('click').catch(() => {});
      const idleShown = await page
        .getByTestId('state-idle')
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (idleShown) {
        cancelled = true;
        cancelDetail = `attempt ${attempt + 1} (rate ${rate}x): cancel mid-scan returned to idle`;
      } else {
        cancelDetail = `attempt ${attempt + 1} (rate ${rate}x): idle state never appeared after cancel`;
      }
    }
    record('cancel', cancelled, cancelDetail);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    // ── Full scan to completion ────────────────────────────────────────────
    const scanStart = Date.now();
    await page.getByTestId('button-run-scan').dispatchEvent('click');
    await page.getByTestId('text-results-summary').waitFor({ state: 'visible', timeout: 180_000 });
    const scanElapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
    const resultsText = (await page.getByTestId('text-results-summary').textContent()) ?? '';
    record(
      'scan',
      resultsText.includes(fmt(N)),
      `scan completed in ${scanElapsed}s; results summary "${resultsText.trim().slice(0, 80)}" lists ${fmt(N)} addresses`,
    );

    // ── Damage summary banner with exact counts ────────────────────────────
    const banner = page.getByTestId('text-spend-damage-summary');
    await banner.waitFor({ state: 'visible', timeout: 15_000 });
    const bannerText = ((await banner.textContent()) ?? '').replace(/\s+/g, ' ');
    const bannerOk =
      bannerText.includes(`${fmt(N)} spent dust outputs`) &&
      bannerText.includes(`${fmt(SPEND_TX_COUNT)} transactions`) &&
      bannerText.includes(`linked ${fmt(N)} of your addresses together`);
    record('banner', bannerOk, `banner="${bannerText.trim()}" (expected ${fmt(N)} outputs / ${fmt(SPEND_TX_COUNT)} txs / ${fmt(N)} linked)`);

    // ── Expand the first row: Spent section with links and classification ──
    const toggle = page.getByTestId(`button-toggle-outputs-${targetRecordId}`);
    await toggle.waitFor({ state: 'visible', timeout: 15_000 });
    await toggle.dispatchEvent('click');

    await page.getByTestId(`header-spent-${targetRecordId}`).waitFor({ state: 'visible', timeout: 15_000 });
    const spendRow = page.getByTestId(`row-spend-${targetRecordId}-${TARGET_DUST_TXID}-0`);
    await spendRow.waitFor({ state: 'visible', timeout: 15_000 });

    const outpointText = (await page
      .getByTestId(`text-spend-outpoint-${targetRecordId}-${TARGET_DUST_TXID}-0`)
      .textContent()) ?? '';
    const satsText = (await page
      .getByTestId(`text-spend-sats-${targetRecordId}-${TARGET_DUST_TXID}-0`)
      .textContent()) ?? '';
    const badgeVisible = await page
      .getByTestId(`badge-links-owned-${targetRecordId}-${TARGET_DUST_TXID}-0`)
      .isVisible()
      .catch(() => false);
    record(
      'spent-row',
      outpointText === `${TARGET_DUST_TXID}:0` && satsText.includes(String(DUST_SATS)) && badgeVisible,
      `outpoint="${outpointText.slice(0, 20)}…" sats="${satsText.trim()}" harmfulBadge=${badgeVisible}`,
    );

    // Spending-tx link + owned co-input AddressLink chips + external count,
    // all scoped inside the spend row.
    const txLinkVisible = await spendRow
      .getByTestId(`link-txid-${TARGET_SPEND_TXID.slice(0, 8)}`)
      .isVisible()
      .catch(() => false);
    const ownedChipCount = await spendRow.locator('[data-testid^="link-address-"]').count();
    const externalText = (await page
      .getByTestId(`text-spend-external-${targetRecordId}-${TARGET_DUST_TXID}-0`)
      .textContent()) ?? '';
    record(
      'spend-links',
      txLinkVisible && ownedChipCount === K - 1 && externalText.includes('1 external address'),
      `txLink=${txLinkVisible} ownedChips=${ownedChipCount} (expected ${K - 1}) external="${externalText.trim()}"`,
    );

    // ── Scoped scan (pass 3c): "By Wallet" → Wallet A ─────────────────────
    // Even-indexed addresses (bc1qdust…) are Wallet A, odd (bc1qothr…) are
    // Wallet B. A Wallet-A-scoped scan must classify each spend row's Wallet B
    // co-inputs as OWNED out-of-scope chips, not external addresses.
    await page.getByTestId('select-scope-type').click();
    await page.getByRole('option', { name: 'By Wallet' }).click();
    await page.getByTestId('select-scope-value').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('select-scope-value').click();
    await page.getByRole('option', { name: 'Wallet A' }).click();

    // Selecting a scope value auto-runs the scan; wait for the banner to show
    // the scoped counts (previous banner still shows the all-scope numbers).
    const scopedN = N / 2; // in-scope spent dust outputs (Wallet A only)
    await page.waitForFunction(
      (expected) => {
        const el = document.querySelector('[data-testid="text-spend-damage-summary"]');
        return !!el && (el.textContent ?? '').includes(expected);
      },
      `${fmt(scopedN)}`,
      { timeout: 180_000 },
    );
    const scopedBannerText = ((await banner.textContent()) ?? '').replace(/\s+/g, ' ');
    // Every spending tx combines Wallet A + Wallet B dust, so all N owned
    // addresses still count as linked even in the scoped run.
    const scopedBannerOk =
      scopedBannerText.includes(`${fmt(scopedN)} spent dust outputs`) &&
      scopedBannerText.includes(`${fmt(SPEND_TX_COUNT)} transactions`) &&
      scopedBannerText.includes(`linked ${fmt(N)} of your addresses together`);
    record(
      'scoped-banner',
      scopedBannerOk,
      `banner="${scopedBannerText.trim()}" (expected ${fmt(scopedN)} outputs / ${fmt(SPEND_TX_COUNT)} txs / ${fmt(N)} linked)`,
    );

    // Re-expand the target row if the re-scan collapsed it.
    const scopedHeaderVisible = await page
      .getByTestId(`header-spent-${targetRecordId}`)
      .isVisible()
      .catch(() => false);
    if (!scopedHeaderVisible) {
      const scopedToggle = page.getByTestId(`button-toggle-outputs-${targetRecordId}`);
      await scopedToggle.waitFor({ state: 'visible', timeout: 15_000 });
      await scopedToggle.dispatchEvent('click');
      await page.getByTestId(`header-spent-${targetRecordId}`).waitFor({ state: 'visible', timeout: 15_000 });
    }
    const scopedSpendRow = page.getByTestId(`row-spend-${targetRecordId}-${TARGET_DUST_TXID}-0`);
    await scopedSpendRow.waitFor({ state: 'visible', timeout: 15_000 });

    // In-scope co-inputs: the other 9 Wallet A addresses (bc1qdust prefix).
    // Out-of-scope owned co-inputs: all 10 Wallet B addresses (bc1qothr
    // prefix). If pass 3c regressed, the bc1qothr chips vanish and the
    // external count balloons to 11.
    const inScopeChips = await scopedSpendRow.locator('[data-testid="link-address-bc1qdust"]').count();
    const outOfScopeChips = await scopedSpendRow.locator('[data-testid="link-address-bc1qothr"]').count();
    const scopedExternalText = (await page
      .getByTestId(`text-spend-external-${targetRecordId}-${TARGET_DUST_TXID}-0`)
      .textContent()) ?? '';
    record(
      'scoped-out-of-scope-chips',
      inScopeChips === K / 2 - 1 && outOfScopeChips === K / 2 && scopedExternalText.includes('1 external address'),
      `inScopeChips=${inScopeChips} (expected ${K / 2 - 1}) outOfScopeChips=${outOfScopeChips} (expected ${K / 2}) external="${scopedExternalText.trim()}"`,
    );

    await context.close();
  } finally {
    await browser.close();
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[dusted-spend-damage-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length > 0) {
    console.error('[dusted-spend-damage-browser] FAILED steps:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log(
    '[dusted-spend-damage-browser] PASSED: spent-dust damage details resolve, render, and stay cancellable in a real browser at scale.',
  );
}

main().catch((err) => {
  console.error('[dusted-spend-damage-browser] fatal:', err);
  process.exit(1);
});
