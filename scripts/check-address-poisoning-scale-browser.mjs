#!/usr/bin/env node
// Real-browser scale guard for the Address Poisoning page (task: "Confirm the
// Address Poisoning page stays smooth in a real browser on a 10k-address
// vault").
//
// The scanner's cooperative shape (bucketed lookalike matching, periodic
// yields, abort checks) is covered by the fake-indexeddb node test
// client/src/lib/address-poisoning.scale.test.ts — but fake-indexeddb timing
// is harness-bound, and the page's rendering of a huge virtualized result
// list plus the Cancel button wiring through the real UI is only verifiable
// against real IndexedDB in headless Chromium (same rationale as
// check-quantum-scan-scale-browser.mjs).
//
// NOTE for reviewers: the route under test is /address-poisoning, rendered by
// client/src/pages/AddressPoisoning.tsx, which calls scanAddressPoisoning
// from client/src/lib/address-poisoning.ts.
//
// This script drives a REAL headless Chromium against the running dev server:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds 10,000 vault address records plus one dust transaction per
//      address (dust output to the vault address + a lookalike counterparty
//      input + same-family strangers) via the live Vite module singletons
//   3. opens /address-poisoning, clicks Scan and clicks Cancel mid-scan —
//      asserts the scan stops (idle state, no results banner)
//   4. runs the scan to completion — asserts it finishes within a generous
//      budget and the summary reports all 10k suspects/targets
//   5. asserts the grouped result list is virtualized (bounded mounted rows),
//      that scrolling to the bottom swaps the window and the main thread
//      stays responsive (rAF round-trip)
//   6. selects a suspect tag and clicks "Tag all suspects (10,000)" — asserts
//      the busy state appears, the main thread stays responsive while the
//      chunked bulk writes stream (rAF probes), the run completes within a
//      generous budget, the success toast reports all 10k creations, and the
//      blockchain-discovered record count confirms the writes landed
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-address-poisoning-scale-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'poisoning-scale-check-123';

const ADDRESS_COUNT = 10_000;
// 1 lookalike + 2 same-family strangers per dust tx keeps the candidate set
// large (30k) without making seeding itself the bottleneck.
const STRANGERS_PER_TX = 2;
// Generous "seconds, not minutes" budget: the bucketed scan finishes in a few
// seconds locally; kept loose so parallel-validation load can't flake it.
const SCAN_BUDGET_MS = 90_000;
// Tagging 10k suspects = chunked bulk creates into real IndexedDB; generous
// "seconds, not minutes" budget so parallel-validation load can't flake it.
const TAG_BUDGET_MS = 120_000;

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

async function launchWithRetry(exe) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(`[poisoning-scale] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[poisoning-scale] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[poisoning-scale] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[poisoning-scale] starting dev server (npm run dev) ...`);
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
    console.log(`[poisoning-scale] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[poisoning-scale][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}address-poisoning`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'poisoning-scale' });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed 10k addresses + dust participants via the live singletons ──────
    // Address i: bc1q family with a unique 8-hex-char affix on both ends; its
    // lookalike attacker shares the first 12 and last 8 characters (well above
    // the default matchLength of 4), so every dust tx yields exactly one
    // suspect. Strangers get unique suffixes so they land in their own affix
    // buckets and never match.
    const seedStart = Date.now();
    const seed = await page.evaluate(async ({ count, strangers }) => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');

      const vaultAddr = (i) => {
        const h = i.toString(16).padStart(8, '0');
        return `bc1q${h}${'m'.repeat(20)}${h}`;
      };
      const lookalikeAddr = (i) => {
        const h = i.toString(16).padStart(8, '0');
        return `bc1q${h}${'z'.repeat(20)}${h}`;
      };
      const strangerAddr = (i, k) =>
        `bc1qstranger${'s'.repeat(12)}${i.toString(16).padStart(6, '0')}${k}x`;
      const txidFor = (i) => i.toString(16).padStart(8, '0').repeat(8);

      const CHUNK = 2000;
      let createdRecords = 0;
      for (let s = 0; s < count; s += CHUNK) {
        const batch = [];
        for (let i = s; i < Math.min(s + CHUNK, count); i++) {
          batch.push({
            type: 'address',
            inputString: vaultAddr(i),
            label: `Poisoning scale addr ${i}`,
            source: 'manual',
            tags: [],
            categories: [],
          });
        }
        const ids = await recordCrud.bulkCreateRecords(batch, {
          skipVocabularySync: true,
          skipNotification: true,
        });
        createdRecords += ids.length;
      }

      let createdParticipants = 0;
      let parts = [];
      const flush = async () => {
        if (parts.length === 0) return;
        const ids = await txCrud.bulkAddParticipants(parts, { skipNotification: true });
        createdParticipants += ids.length;
        parts = [];
      };
      for (let i = 0; i < count; i++) {
        const txid = txidFor(i);
        parts.push({ txid, role: 'output', address: vaultAddr(i), amount: 546, vout: 0 });
        parts.push({ txid, role: 'input', address: lookalikeAddr(i), amount: 600 });
        for (let k = 1; k <= strangers; k++) {
          parts.push({ txid, role: 'input', address: strangerAddr(i, k), amount: 700 });
        }
        if (parts.length >= 5000) await flush();
      }
      await flush();

      return { createdRecords, createdParticipants };
    }, { count: ADDRESS_COUNT, strangers: STRANGERS_PER_TX });
    const expectedParticipants = ADDRESS_COUNT * (2 + STRANGERS_PER_TX);
    steps.push({
      name: `seeded ${ADDRESS_COUNT} addresses + ${expectedParticipants} dust participants`,
      passed:
        seed.createdRecords === ADDRESS_COUNT &&
        seed.createdParticipants === expectedParticipants,
      detail: `records=${seed.createdRecords}, participants=${seed.createdParticipants} in ${Date.now() - seedStart}ms`,
    });

    // ── Reload so the page reads the seeded vault ────────────────────────────
    await page.goto(`${BASE_URL}address-poisoning`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'poisoning-scale' });

    const runButton = page.getByTestId('button-run-scan');
    await runButton.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Cancel mid-scan stops the scan ───────────────────────────────────────
    await runButton.click();
    const cancelButton = page.getByTestId('button-cancel-scan');
    const cancelVisible = await cancelButton
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    let cancelledToIdle = false;
    let scanOutranCancel = false;
    if (cancelVisible) {
      // Click as soon as the Cancel button is up — the 10k-address scan takes
      // multiple passes over real IndexedDB, so it is still running.
      const clicked = await cancelButton.click({ timeout: 3_000 }).then(
        () => true,
        () => false,
      );
      if (clicked) {
        cancelledToIdle = await page
          .getByTestId('state-idle')
          .waitFor({ state: 'visible', timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
      } else {
        // Cancel button detached under the click => the scan finished first.
        scanOutranCancel = true;
      }
    }
    const bannerAfterCancel = await page
      .getByTestId('banner-summary')
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'clicking Cancel mid-scan returns the page to idle with no results',
      passed: cancelVisible && cancelledToIdle && !bannerAfterCancel && !scanOutranCancel,
      detail: `cancelVisible=${cancelVisible}, idleAfterCancel=${cancelledToIdle}, bannerShown=${bannerAfterCancel}, scanOutranCancel=${scanOutranCancel}`,
    });

    // ── Full scan completes within budget ────────────────────────────────────
    await runButton.waitFor({ state: 'visible', timeout: 15_000 });
    const scanStart = Date.now();
    await runButton.click();
    const banner = page.getByTestId('banner-summary');
    const completed = await banner
      .waitFor({ state: 'visible', timeout: SCAN_BUDGET_MS + 30_000 })
      .then(() => true)
      .catch(() => false);
    const scanMs = Date.now() - scanStart;
    const summaryText = completed
      ? ((await page.getByTestId('text-summary').textContent().catch(() => '')) ?? '').trim()
      : '';
    steps.push({
      name: `full scan over ${ADDRESS_COUNT} addresses completes within ${SCAN_BUDGET_MS / 1000}s`,
      passed: completed && scanMs <= SCAN_BUDGET_MS,
      detail: `completed=${completed} in ${scanMs}ms`,
    });
    steps.push({
      name: 'summary reports all 10k suspects targeting all 10k addresses',
      passed:
        summaryText.includes(`${ADDRESS_COUNT.toLocaleString('en-US')} suspect`) &&
        summaryText.includes(`${ADDRESS_COUNT.toLocaleString('en-US')} of your`),
      detail: `summary="${summaryText}"`,
    });

    // ── Virtualized result list: bounded mounted rows ────────────────────────
    // 10k group headers + 10k suspect rows = 20k flat rows; only the visible
    // window (plus overscan) may mount.
    const mountedAfterScan = await page.locator('[data-testid^="row-suspect-"]').count();
    const mountedGroups = await page.locator('[data-testid^="group-"]').count();
    steps.push({
      name: 'only a virtualized window of result rows is mounted after the scan',
      passed:
        mountedAfterScan > 0 &&
        mountedAfterScan < 500 &&
        mountedGroups > 0 &&
        mountedGroups < 500,
      detail: `suspectRows=${mountedAfterScan}, groupRows=${mountedGroups} of ${ADDRESS_COUNT} each`,
    });

    // ── Scrolling swaps the window and the main thread stays responsive ─────
    const firstTopRow = await page
      .locator('[data-testid^="row-suspect-"]')
      .first()
      .getAttribute('data-testid');
    const scrollProbeStart = Date.now();
    await page.evaluate(() => {
      // The results scroll container is the overflow-y-auto sibling after the
      // summary banner.
      const banner = document.querySelector('[data-testid="banner-summary"]');
      const el = banner?.nextElementSibling;
      if (!el) throw new Error('results scroll container not found');
      el.scrollTop = el.scrollHeight;
    });
    // rAF round-trip after the scroll = main thread is alive, not frozen.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const scrollProbeMs = Date.now() - scrollProbeStart;
    await page.waitForTimeout(300);
    const bottomState = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid^="row-suspect-"]'));
      return {
        mounted: rows.length,
        firstTestId: rows[0]?.getAttribute('data-testid') ?? null,
      };
    });
    steps.push({
      name: 'scrolling to the bottom swaps the mounted window (still bounded) and stays responsive',
      passed:
        bottomState.mounted > 0 &&
        bottomState.mounted < 500 &&
        bottomState.firstTestId !== firstTopRow &&
        scrollProbeMs < 3_000,
      detail: `mounted=${bottomState.mounted}, firstRow ${firstTopRow} -> ${bottomState.firstTestId}, scroll+2xRAF=${scrollProbeMs}ms`,
    });

    // ── Tag all suspects at 10k scale stays responsive and completes ────────
    // The page pre-selects the default suspect tag ("suspected-poisoning"), so
    // the button is ready to click; applyPoisoningTags creates the vocabulary
    // row itself if missing.
    const tagAllButton = page.getByTestId('button-tag-all-suspects');
    await tagAllButton.waitFor({ state: 'visible', timeout: 10_000 });
    const buttonLabel = ((await tagAllButton.textContent()) ?? '').trim();

    const tagStart = Date.now();
    await tagAllButton.click();

    // Busy state: the button disables and shows a spinner while the chunked
    // bulk writes stream. Poll fast — 10k creates take multiple seconds.
    let busySeen = false;
    for (let i = 0; i < 100 && !busySeen; i++) {
      busySeen = await tagAllButton.isDisabled().catch(() => false);
      if (!busySeen) await page.waitForTimeout(50);
    }

    // Responsiveness while tagging: repeated rAF round-trips must keep
    // resolving. The pre-fix per-record loop would monopolise the main thread
    // for the whole run; the chunked+yielding path keeps every probe short.
    let maxProbeMs = 0;
    let probing = true;
    const probeLoop = (async () => {
      while (probing) {
        const t0 = Date.now();
        await page
          .evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          )
          .catch(() => {});
        maxProbeMs = Math.max(maxProbeMs, Date.now() - t0);
        await page.waitForTimeout(250);
      }
    })();

    // Live progress counter: the button label must repaint through distinct
    // intermediate "Tagging N / 10,000…" states while chunks stream (the jsdom
    // test only proves onProgress -> state; a real browser could still batch
    // every update into one final paint). Sample the PAINTED label fast via
    // in-page rAF-synced reads so we observe actual renders, not just state.
    const progressSamples = new Set();
    const progressLoop = (async () => {
      while (probing) {
        const label = await page
          .evaluate(() => {
            const btn = document.querySelector('[data-testid="button-tag-all-suspects"]');
            return btn ? btn.textContent ?? '' : '';
          })
          .catch(() => '');
        const m = label.match(/Tagging\s+([\d,]+)\s*\/\s*([\d,]+)/);
        if (m) progressSamples.add(`${m[1]}/${m[2]}`);
        await page.waitForTimeout(40);
      }
    })();

    // Success toast (Radix duplicates text into aria-live — use .first()).
    const toast = page.getByText(/Tagged \d+ record/).first();
    const tagCompleted = await toast
      .waitFor({ state: 'visible', timeout: TAG_BUDGET_MS })
      .then(() => true)
      .catch(() => false);
    const tagMs = Date.now() - tagStart;
    probing = false;
    await probeLoop;
    await progressLoop;
    const toastText = tagCompleted ? ((await toast.textContent()) ?? '').trim() : '';

    const expectedTotal = ADDRESS_COUNT.toLocaleString('en-US');
    const intermediateSamples = Array.from(progressSamples).filter((s) => {
      const [doneStr, totalStr] = s.split('/');
      return totalStr === expectedTotal && doneStr !== totalStr;
    });
    steps.push({
      name: 'live "Tagging N / 10,000…" counter repaints through at least two distinct intermediate states',
      passed: intermediateSamples.length >= 2,
      detail: `distinct intermediate renders=${intermediateSamples.length} (all sampled: ${Array.from(progressSamples).join(', ') || 'none'})`,
    });

    steps.push({
      name: `Tag all suspects (${ADDRESS_COUNT}) shows a busy state and completes within ${TAG_BUDGET_MS / 1000}s`,
      passed: busySeen && tagCompleted && tagMs <= TAG_BUDGET_MS,
      detail: `button="${buttonLabel}", busySeen=${busySeen}, completed=${tagCompleted} in ${tagMs}ms`,
    });
    steps.push({
      name: 'main thread stays responsive during the 10k tagging run',
      passed: maxProbeMs > 0 && maxProbeMs < 5_000,
      detail: `max rAF round-trip while tagging = ${maxProbeMs}ms`,
    });
    steps.push({
      name: 'toast reports all 10k suspects were newly created records',
      passed: toastText.includes(`created ${ADDRESS_COUNT} new record`),
      detail: `toast="${toastText}"`,
    });

    // The writes actually landed: 10k blockchain-discovered records now exist.
    const discoveredCount = await page.evaluate(async () => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      return recordCrud.countRecordsByImportanceTiersDirect(['blockchain-discovered']);
    });
    steps.push({
      name: `all ${ADDRESS_COUNT} suspects now have blockchain-discovered records`,
      passed: discoveredCount === ADDRESS_COUNT,
      detail: `blockchain-discovered count=${discoveredCount}`,
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
  console.log(`[poisoning-scale] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[poisoning-scale] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    `[poisoning-scale] PASSED: the Address Poisoning page scans a ${ADDRESS_COUNT}-address vault in seconds, cancels mid-scan, and renders 10k results through a bounded virtualized window, and tags all 10k suspects via chunked bulk writes without freezing.`,
  );
}

main().catch((err) => {
  console.error('[poisoning-scale] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
