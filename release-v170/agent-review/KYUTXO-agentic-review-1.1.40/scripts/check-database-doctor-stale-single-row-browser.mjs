#!/usr/bin/env node
// Real-browser regression guard for a missing-row bug in Database Doctor's
// stale-address list (StaleAddressList in client/src/pages/DatabaseDoctor.tsx).
//
// The list is virtualized (@tanstack/react-virtual) and feeds the visible
// window to a shared loader hook via an effect keyed off the first/last
// virtual item indices. Before this fix, the effect's dependency array did
// NOT include virtualItems.length. When the list mounts with exactly one row
// (or any content whose first visible item is at index 0), the pre-mount
// render (0 items, indices default to 0) and the post-mount render (1 item,
// real index 0) produce IDENTICAL dependency arrays, so React never re-runs
// the effect, `range` stays null forever, and the single row gets stuck on
// its "Loading…" placeholder forever (see row-stale-loading-0).
//
// This mirrors the already-fixed sibling bug in
// client/src/pages/dormant-coins/dormant-results-list.tsx (task 2125).
//
// This script, in a real Chromium:
//   1. creates a fresh vault
//   2. seeds EXACTLY ONE synced address with a deliberately wrong cached
//      balance so the Doctor's balance check flags exactly 1 stale address
//   3. on /database-doctor, runs the balance check and waits for the verdict
//      to report "1 of 1 ... stale cached balance"
//   4. asserts the single row actually renders its address/cached/computed
//      text (data-testid="text-stale-address-<id>") and that no
//      row-stale-loading-* placeholder is left behind
//
// Usage: node scripts/check-database-doctor-stale-single-row-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dbdoctor-stale-single-row-check-123';
const WRONG_CACHED_SATS = 456;

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

async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(
        `[dbdoctor-stale-single-row] goto ${url} failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dbdoctor-stale-single-row] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dbdoctor-stale-single-row] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dbdoctor-stale-single-row] starting dev server (npm run dev) ...`);
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
    console.log(`[dbdoctor-stale-single-row] dev server ready at ${BASE_URL}`);
  }

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
      console.log(
        `[dbdoctor-stale-single-row] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[dbdoctor-stale-single-row][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await gotoWithRetry(page, BASE_URL);
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'dbdoctor-stale-single-row',
    });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed EXACTLY ONE stale synced address ───────────────────────────────
    const seed = await page.evaluate(
      async ({ wrongCachedSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const syncCrud = await import('/src/lib/data/address-sync-crud.ts');

        const address = 'bc1qddsinglerowcheckxxxxxxxxxxxxxxxxxxxxx';

        const ids = await recordCrud.bulkCreateRecords(
          [{ type: 'address', inputString: address, label: 'DD single stale row' }],
          { skipVocabularySync: true, skipNotification: true },
        );

        await syncCrud.bulkAddAddressSyncState([
          {
            address,
            recordId: ids[0],
            lastSyncedHeight: 800_100,
            lastSyncedAt: Date.now(),
            txCount: 0,
          },
        ]);

        const now = Math.floor(Date.now() / 1000);
        await recordCrud.bulkUpdateAddressStats(
          [
            {
              id: ids[0],
              stats: {
                cachedBalanceSats: wrongCachedSats,
                cachedTxCount: 0,
                cachedLastActivityTime: now - 3_600,
                cachedUtxoCount: 0,
                statsComputedAt: Date.now(),
              },
            },
          ],
          { skipNotification: true },
        );

        return { created: ids.length, recordId: ids[0] };
      },
      { wrongCachedSats: WRONG_CACHED_SATS },
    );
    steps.push({
      name: 'seeded exactly 1 stale synced address',
      passed: seed.created === 1,
      detail: JSON.stringify(seed),
    });

    // ── Database Doctor: run the balance check ──────────────────────────────
    await gotoWithRetry(page, `${BASE_URL}database-doctor`);
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'dbdoctor-stale-single-row',
    });

    await page.getByTestId('button-run-balance-check').click();
    const verdict = page.getByTestId('text-balance-verdict');
    await verdict.waitFor({ state: 'visible', timeout: 120_000 });
    let verdictText = '';
    {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        verdictText = ((await verdict.textContent().catch(() => '')) ?? '').trim();
        if (/^1 of 1 /.test(verdictText)) break;
        await page.waitForTimeout(500);
      }
    }
    steps.push({
      name: 'balance check flagged exactly the 1 seeded address as stale',
      passed: /^1 of 1 /.test(verdictText) && verdictText.includes('stale cached balance'),
      detail: `verdict="${verdictText}"`,
    });

    // ── The single row must render, not get stuck on "Loading…" ─────────────
    const rowTextId = `text-stale-address-${seed.recordId}`;
    let rowVisible = false;
    let rowText = '';
    {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const loc = page.getByTestId(rowTextId);
        if (await loc.count()) {
          rowVisible = await loc.isVisible().catch(() => false);
          if (rowVisible) {
            rowText = ((await loc.textContent().catch(() => '')) ?? '').trim();
            break;
          }
        }
        await page.waitForTimeout(300);
      }
    }
    steps.push({
      name: 'the single stale row rendered its address text (did not get stuck on the missing-row bug)',
      passed: rowVisible && rowText.length > 0,
      detail: `testid=${rowTextId} visible=${rowVisible} text="${rowText}"`,
    });

    const loadingPlaceholderCount = await page
      .locator('[data-testid^="row-stale-loading-"]')
      .count();
    steps.push({
      name: 'no "Loading…" placeholder remains for the single row',
      passed: loadingPlaceholderCount === 0,
      detail: `remaining loading placeholders=${loadingPlaceholderCount}`,
    });

    const cachedText = (
      (await page.getByTestId(`text-stale-cached-${seed.recordId}`).textContent().catch(() => '')) ?? ''
    ).trim();
    const computedText = (
      (await page.getByTestId(`text-stale-computed-${seed.recordId}`).textContent().catch(() => '')) ?? ''
    ).trim();
    steps.push({
      name: 'cached/computed columns for the single row also rendered real values',
      passed: cachedText.length > 0 && computedText.length > 0,
      detail: `cached="${cachedText}" computed="${computedText}"`,
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

  console.log(`[dbdoctor-stale-single-row] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dbdoctor-stale-single-row] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dbdoctor-stale-single-row] PASSED: a single-row stale-address report renders past the loading placeholder.',
  );
}

main().catch((err) => {
  console.error('[dbdoctor-stale-single-row] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
