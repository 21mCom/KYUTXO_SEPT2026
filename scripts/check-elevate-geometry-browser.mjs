#!/usr/bin/env node
// Real-browser regression guard for two elevate-CSS-sensitive absolute
// overlays, driven on their REAL pages (not synthetic class probes):
//
//   1. Dashboard BlockchainToggle "+N" hidden-count badge — must straddle the
//      toggle button's TOP-RIGHT corner (`absolute -top-1 -right-1`).
//   2. Provenance Address Explorer clear (X) button — must sit INSIDE the
//      input at its right edge, spanning the input height
//      (`absolute right-0 top-0 h-full`).
//
// Root cause history: the elevate utilities in index.css set
// `position: relative; z-index: 0` with a two-class selector that
// out-specified Tailwind's single-class `.absolute`, silently dropping
// absolutely-positioned children of Buttons/Badges into normal flow. The fix
// wraps the elevate position rule in `:where()`. The searchbar clear button is
// covered by check-searchbar-clear-browser.mjs; the other consumers were only
// verified via computed-style probes with their class combinations. This
// script drives the ACTUAL pages:
//
//   1. Creates a fresh vault, seeds one blockchain-discovered address record
//      via the live Vite module singletons so the Dashboard toggle renders a
//      real "+1" badge (hiddenCount > 0 with the toggle off by default).
//   2. Reloads the Dashboard and asserts the badge's bounding box straddles
//      the toggle button's top-right corner and computes position:absolute.
//   3. Opens the Provenance page, types an address into the explorer input,
//      and asserts the clear X's box lies inside the input hugging the right
//      edge, spans the input height, and computes position:absolute.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-elevate-geometry-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'elevate-geometry-check-123';

// Fake-but-plausible bech32-looking address; the seed path matches records by
// string equality only. Also reused as the Provenance explorer input text
// (the clear X renders for ANY non-empty input).
const DISCOVERED_ADDR = 'bc1qelevategeomcheckdiscoveredaddrxxxxxx';

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
  const hasConfirm = await confirmInput.isVisible().catch(() => false);
  if (hasConfirm) {
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
 * subsequent interactions are not swallowed. No-op when it never shows.
 */
async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[elevate-geometry-browser] legacy-migration overlay detected; waiting it out ...');
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

const fmt = (b) =>
  b
    ? `x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} w=${b.width.toFixed(1)} h=${b.height.toFixed(1)}`
    : 'null';

async function main() {
  const exe = resolveChromium();
  console.log(`[elevate-geometry-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[elevate-geometry-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[elevate-geometry-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[elevate-geometry-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    // Fresh context => empty IndexedDB => setup form. Block the PWA service
    // worker so a stale cached bundle can't serve OLD css.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[elevate-geometry-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: one blockchain-discovered address record via the LIVE Vite
    //    module singletons (same URLs the app imported => same Dexie DB).
    //    source: 'blockchain-sync' derives addressImportance
    //    'blockchain-discovered', which feeds the Dashboard's
    //    blockchainDiscoveredCount => the "+1" badge on the toggle (the
    //    Dashboard defaults to includeBlockchainDiscovered=false). ───────────
    const recordId = await page.evaluate(async (addr) => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      return recordCrud.createRecord({
        type: 'address',
        inputString: addr,
        label: 'Elevate geometry check discovered address',
        source: 'blockchain-sync',
      });
    }, DISCOVERED_ADDR);
    steps.push({
      name: 'seeded one blockchain-discovered address record',
      passed: Number.isInteger(recordId) && recordId > 0,
      detail: `recordId=${recordId}`,
    });

    // ── Dashboard: reload so the page loads the seed on mount ───────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const toggleBtn = page.getByTestId('button-blockchain-toggle');
    await toggleBtn.waitFor({ state: 'visible', timeout: 30_000 });
    const badge = toggleBtn.getByText('+1', { exact: true });
    await badge.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'BlockchainToggle renders the "+1" hidden-count badge',
      passed: true,
      detail: 'badge visible with toggle off (hiddenCount=1)',
    });

    const badgePos = await badge.evaluate((el) => getComputedStyle(el).position);
    steps.push({
      name: 'badge computes position: absolute (elevate rule does not override it)',
      passed: badgePos === 'absolute',
      detail: `computed position = ${badgePos}`,
    });

    const btnBox = await toggleBtn.boundingBox();
    const badgeBox = await badge.boundingBox();
    // `-top-1 -right-1` => the badge crosses BOTH the button's top edge and
    // its right edge (straddles the top-right corner). If the elevate rule
    // wins again, the badge falls into normal flow inside/below the button.
    const crossesTop =
      badgeBox && btnBox &&
      badgeBox.y < btnBox.y &&
      badgeBox.y + badgeBox.height > btnBox.y;
    const crossesRight =
      badgeBox && btnBox &&
      badgeBox.x < btnBox.x + btnBox.width &&
      badgeBox.x + badgeBox.width > btnBox.x + btnBox.width;
    // And it must hug the corner: overhang beyond each edge is the -1 offset
    // (4px), so allow a small tolerance rather than "anywhere above".
    const topOverhang = badgeBox && btnBox ? btnBox.y - badgeBox.y : NaN;
    const rightOverhang =
      badgeBox && btnBox ? badgeBox.x + badgeBox.width - (btnBox.x + btnBox.width) : NaN;
    const hugsCorner =
      topOverhang >= 2 && topOverhang <= 8 && rightOverhang >= 2 && rightOverhang <= 8;
    steps.push({
      name: 'badge box straddles the toggle button top-right corner',
      passed: Boolean(crossesTop && crossesRight && hugsCorner),
      detail: `button(${fmt(btnBox)}) badge(${fmt(badgeBox)}) crossesTop=${crossesTop} crossesRight=${crossesRight} topOverhang=${topOverhang?.toFixed?.(1)} rightOverhang=${rightOverhang?.toFixed?.(1)}`,
    });

    // ── Provenance: type an address, assert the clear X geometry ────────────
    await page.goto(`${BASE_URL}provenance`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const explorerInput = page.getByTestId('input-explorer-address');
    await explorerInput.waitFor({ state: 'visible', timeout: 30_000 });
    await explorerInput.fill(DISCOVERED_ADDR);

    const clearBtn = page.getByTestId('button-clear-address');
    await clearBtn.waitFor({ state: 'visible', timeout: 10_000 });
    steps.push({
      name: 'Provenance explorer input renders the clear (X) button',
      passed: true,
      detail: 'button-clear-address visible after typing',
    });

    const clearPos = await clearBtn.evaluate((el) => getComputedStyle(el).position);
    steps.push({
      name: 'clear button computes position: absolute (elevate rule does not override it)',
      passed: clearPos === 'absolute',
      detail: `computed position = ${clearPos}`,
    });

    const inputBox = await explorerInput.boundingBox();
    const clearBox = await clearBtn.boundingBox();
    // `absolute right-0 top-0 h-full` => the X lies fully INSIDE the input,
    // flush against its right edge, spanning the input's height.
    const inside =
      clearBox && inputBox &&
      clearBox.x >= inputBox.x &&
      clearBox.x + clearBox.width <= inputBox.x + inputBox.width + 0.5 &&
      clearBox.y >= inputBox.y - 0.5 &&
      clearBox.y + clearBox.height <= inputBox.y + inputBox.height + 0.5;
    const hugsRight =
      clearBox && inputBox &&
      inputBox.x + inputBox.width - (clearBox.x + clearBox.width) <= 2;
    steps.push({
      name: 'clear button box lies inside the input, flush with the right edge',
      passed: Boolean(inside && hugsRight),
      detail: `input(${fmt(inputBox)}) clear(${fmt(clearBox)}) inside=${inside} hugsRight=${hugsRight}`,
    });

    const heightMatch =
      clearBox && inputBox && Math.abs(clearBox.height - inputBox.height) <= 2;
    const centerOff =
      clearBox && inputBox
        ? Math.abs(clearBox.y + clearBox.height / 2 - (inputBox.y + inputBox.height / 2))
        : Infinity;
    steps.push({
      name: 'clear button spans the input height (h-full) and is vertically centered',
      passed: Boolean(heightMatch) && centerOff <= 2,
      detail: `clear h=${clearBox?.height?.toFixed(1)} input h=${inputBox?.height?.toFixed(1)} centerOffset=${centerOff.toFixed(2)}px`,
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

  console.log(`[elevate-geometry-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[elevate-geometry-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[elevate-geometry-browser] PASSED: hidden-count badge straddles the toggle top-right corner and the Provenance clear X sits inside the input right edge, in a real browser.',
  );
}

main().catch((err) => {
  console.error('[elevate-geometry-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
