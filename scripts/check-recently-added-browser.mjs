#!/usr/bin/env node
// Real-browser regression guard for the Records page "Date Added" controls:
// the Newest/Oldest sort toggle and the "Recently added" quick filter
// (preset windows + custom since-date) added with the createdAt keyset path.
//
// The jsdom unit tests cover keyset correctness, filter composition and
// control state, but not the live wiring: click handlers, the reload effect,
// active-badge rendering, the Added column, and the pagination/count footer.
// This script drives the actual page in headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons) four
//      address records whose createdAt values deliberately DISAGREE with
//      insertion (id) order — so true createdAt ordering is distinguishable
//      from the legacy id ordering.
//   3. Asserts the default view lists rows in id-desc order with NO Added
//      column and NO active badge.
//   4. Toggles the sort to "Oldest first" and asserts rows re-order by
//      createdAt ascending, the Added column renders non-empty dates, and
//      the active badge appears.
//   5. Applies the "Last 7 days" preset and asserts only the recent rows
//      remain and the badge shows the recency suffix.
//   6. Applies a custom since-date (~30 days back) and asserts the window
//      widens to exactly the three matching rows.
//   7. Clicks Reset and asserts the badge and Added column disappear and the
//      original id-desc ordering returns.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-recently-added-browser.mjs
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
const RECORDS_URL = `${BASE_URL}records`;
const SETUP_PASSWORD = 'recently-added-check-123';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Four owned addresses. Every first-8-chars prefix differs (testid collisions)
// and labels are unique so row identity can be read from the label cell.
// Insertion order is r4, r2, r1, r3 so id order ≠ createdAt order.
const SEED = [
  { key: 'r1', addr: 'bc1qadded10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', label: 'DateAdded r1 (60d ago)', ageMs: 60 * DAY },
  { key: 'r2', addr: 'bc1qadded2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', label: 'DateAdded r2 (10d ago)', ageMs: 10 * DAY },
  { key: 'r3', addr: 'bc1qadded3ccccccccccccccccccccccccccccccc', label: 'DateAdded r3 (3d ago)', ageMs: 3 * DAY },
  { key: 'r4', addr: 'bc1qadded4ddddddddddddddddddddddddddddddd', label: 'DateAdded r4 (1h ago)', ageMs: 1 * HOUR },
];
const INSERT_ORDER = ['r4', 'r2', 'r1', 'r3'];
const labelOf = (key) => SEED.find((s) => s.key === key).label;

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

/** Current visible row labels, top-to-bottom. */
async function rowLabels(page) {
  return page
    .locator('[data-testid^="row-record-"] [data-testid^="text-label-"]')
    .allTextContents()
    .then((texts) => texts.map((t) => t.trim()));
}

/**
 * Poll until the visible row labels equal `expected` (order-sensitive).
 * The Date Added controls trigger an async reload effect, so a single read
 * right after a click races the re-render.
 */
async function waitForRowOrder(page, expected, timeoutMs = 30_000) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    last = await rowLabels(page);
    // The label cell can append badge text (e.g. "Not Synced"), so match by prefix.
    if (last.length === expected.length && expected.every((l, i) => last[i].startsWith(l))) {
      return { ok: true, last };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, last };
}

async function main() {
  const exe = resolveChromium();
  console.log(`[recently-added-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[recently-added-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[recently-added-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[recently-added-browser] dev server ready at ${BASE_URL}`);
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
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[recently-added-browser][page-console] ${t}`);
      }
    });

    await page.goto(RECORDS_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // Best-effort: dismiss the legacy-migration overlay if it appears after
    // unlock, otherwise it swallows subsequent clicks.
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    // ── Seed: four records whose createdAt disagrees with id order ─────────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // module writes to the exact same Dexie instance the page reads, and the
    // page's dbChangeSignal reload picks the rows up live.
    const seedResult = await page.evaluate(
      async ({ seeds, order }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const now = Date.now();
        for (const key of order) {
          const s = seeds.find((x) => x.key === key);
          await recordCrud.createRecord({
            type: 'address',
            inputString: s.addr,
            label: s.label,
            createdAt: now - s.ageMs,
          });
        }
        return true;
      },
      { seeds: SEED, order: INSERT_ORDER },
    );
    steps.push({
      name: 'seed: 4 records with createdAt deliberately out of id order',
      passed: seedResult === true,
      detail: `inserted ${INSERT_ORDER.join(', ')} (ids ascending) with ages 1h/3d/10d/60d`,
    });

    // ── Default view: id-desc order, no Added column, no badge ─────────────
    // id order (insert order r4,r2,r1,r3) reversed => r3, r1, r2, r4.
    {
      const expected = ['r3', 'r1', 'r2', 'r4'].map(labelOf);
      const { ok, last } = await waitForRowOrder(page, expected);
      steps.push({
        name: 'default: rows list in legacy id-desc order',
        passed: ok,
        detail: ok ? `order = ${last.join(' | ')}` : `got ${last.join(' | ')} (expected ${expected.join(' | ')})`,
      });
      const addedHeader = await page.locator('[data-testid="header-added"]').count();
      const badge = await page.locator('[data-testid="badge-date-added-active"]').count();
      steps.push({
        name: 'default: no Added column and no active badge while untouched',
        passed: addedHeader === 0 && badge === 0,
        detail: `header-added count=${addedHeader}, badge count=${badge}`,
      });
    }

    // ── Toggle "Oldest first": createdAt-asc order + Added column + badge ──
    await page.getByTestId('button-date-added-sort').click();
    {
      const expected = ['r1', 'r2', 'r3', 'r4'].map(labelOf);
      const { ok, last } = await waitForRowOrder(page, expected);
      steps.push({
        name: 'oldest-first: rows re-order by createdAt ascending',
        passed: ok,
        detail: ok ? `order = ${last.join(' | ')}` : `got ${last.join(' | ')} (expected ${expected.join(' | ')})`,
      });

      const headerVisible = await page
        .locator('[data-testid="header-added"]')
        .isVisible()
        .catch(() => false);
      const addedCells = await page
        .locator('[data-testid^="text-added-"]')
        .allTextContents()
        .then((t) => t.map((x) => x.trim()));
      steps.push({
        name: 'oldest-first: Added column renders with non-empty dates for every row',
        passed: headerVisible && addedCells.length === 4 && addedCells.every((c) => c.length > 0),
        detail: `header=${headerVisible}, cells=[${addedCells.join(' | ')}]`,
      });

      const badgeText =
        (await page
          .locator('[data-testid="badge-date-added-active"]')
          .textContent()
          .catch(() => null)) ?? '';
      steps.push({
        name: 'oldest-first: active badge shows "Oldest first"',
        passed: badgeText.includes('Oldest first') && !badgeText.includes('recently added'),
        detail: `badge = ${JSON.stringify(badgeText)}`,
      });
    }

    // ── Preset "Last 7 days": only the 3d + 1h rows remain ─────────────────
    await page.getByTestId('button-added-preset-7d').click();
    {
      const expected = ['r3', 'r4'].map(labelOf); // still oldest-first
      const { ok, last } = await waitForRowOrder(page, expected);
      steps.push({
        name: 'preset 7d: only records added in the last 7 days remain (oldest first)',
        passed: ok,
        detail: ok ? `order = ${last.join(' | ')}` : `got ${last.join(' | ')} (expected ${expected.join(' | ')})`,
      });

      const badgeText =
        (await page
          .locator('[data-testid="badge-date-added-active"]')
          .textContent()
          .catch(() => null)) ?? '';
      steps.push({
        name: 'preset 7d: badge gains the "recently added" suffix',
        passed: badgeText.includes('Oldest first') && badgeText.includes('recently added'),
        detail: `badge = ${JSON.stringify(badgeText)}`,
      });
    }

    // ── Custom since-date (~30 days back): window widens to 3 rows ─────────
    {
      const since = new Date(Date.now() - 30 * DAY);
      const iso = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
      await page.getByTestId('input-added-since-date').fill(iso);

      const expected = ['r2', 'r3', 'r4'].map(labelOf); // 60d row excluded
      const { ok, last } = await waitForRowOrder(page, expected);
      steps.push({
        name: `custom date (${iso}): window widens to exactly the 10d/3d/1h rows`,
        passed: ok,
        detail: ok ? `order = ${last.join(' | ')}` : `got ${last.join(' | ')} (expected ${expected.join(' | ')})`,
      });
    }

    // ── Reset: badge + Added column gone, original id-desc order back ──────
    await page.getByTestId('button-date-added-reset').click();
    {
      const expected = ['r3', 'r1', 'r2', 'r4'].map(labelOf);
      const { ok, last } = await waitForRowOrder(page, expected);
      steps.push({
        name: 'reset: full list returns in the original id-desc order',
        passed: ok,
        detail: ok ? `order = ${last.join(' | ')}` : `got ${last.join(' | ')} (expected ${expected.join(' | ')})`,
      });

      const badgeGone = (await page.locator('[data-testid="badge-date-added-active"]').count()) === 0;
      const headerGone = (await page.locator('[data-testid="header-added"]').count()) === 0;
      steps.push({
        name: 'reset: active badge and Added column disappear',
        passed: badgeGone && headerGone,
        detail: `badgeGone=${badgeGone}, addedHeaderGone=${headerGone}`,
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

  console.log(`[recently-added-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[recently-added-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[recently-added-browser] PASSED: Date Added sort toggle, Recently-added presets, custom since-date, Added column, and badge/reset all work end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[recently-added-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
