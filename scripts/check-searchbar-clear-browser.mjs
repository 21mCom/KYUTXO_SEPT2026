#!/usr/bin/env node
// Real-browser regression guard for the Records (Dashboard "/") search box
// clear (X) button geometry.
//
// Root cause history: the elevate utilities in index.css set
// `position: relative; z-index: 0` with a TWO-class selector
// (`.hover-elevate:not(.no-default-hover-elevate)`), which out-specified
// Tailwind's single-class `.absolute`. Every Button bakes in
// `hover-elevate active-elevate-2`, so the SearchBar clear button silently
// computed `position: relative`, dropped into normal flow BELOW the
// full-width input, and the wrapper grew 36px -> 64px (X straddling the
// input's bottom-left corner, magnifier sinking to the bottom edge).
// The fix wraps the elevate position rule in `:where()` so an explicit
// positioning utility wins. jsdom tests can't catch this — they don't apply
// the built CSS cascade — so this drives a headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. On the Dashboard, types into the search box.
//   3. Asserts:
//      - the clear button computes position:absolute and its bounding box
//        lies INSIDE the input, hugging the right edge
//      - the clear button is vertically centered on the input
//      - the magnifier/pending icon stays vertically centered on the left
//      - the wrapper is no taller than the input (no layout jump)
//      - the elevate ::after hover overlay still covers the clear button
//
// Usage: node scripts/check-searchbar-clear-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'searchbar-clear-check-123';

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

async function main() {
  const exe = resolveChromium();
  console.log(`[searchbar-clear-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[searchbar-clear-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[searchbar-clear-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[searchbar-clear-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    // Fresh context => empty IndexedDB => setup form. Block the PWA service
    // worker so a stale cached bundle can't serve the OLD css.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[searchbar-clear-browser][page-console] ${t}`);
      }
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // Best-effort: dismiss the legacy-migration overlay if it appears after
    // unlock, otherwise it swallows clicks / covers the page.
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    // ── Dashboard search box ────────────────────────────────────────────────
    const searchInput = page.getByTestId('input-search');
    await searchInput.waitFor({ state: 'visible', timeout: 30_000 });

    const inputBoxBefore = await searchInput.boundingBox();
    const wrapperBoxBefore = await searchInput
      .locator('xpath=..')
      .boundingBox();

    await searchInput.fill('abc');

    const clearBtn = page.getByTestId('button-clear-search');
    await clearBtn.waitFor({ state: 'visible', timeout: 10_000 });

    const inputBox = await searchInput.boundingBox();
    const clearBox = await clearBtn.boundingBox();
    const wrapperBox = await searchInput.locator('xpath=..').boundingBox();

    const fmt = (b) =>
      b ? `x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} w=${b.width.toFixed(1)} h=${b.height.toFixed(1)}` : 'null';

    // 1. Clear button computes absolute positioning.
    const clearPos = await clearBtn.evaluate((el) => getComputedStyle(el).position);
    steps.push({
      name: 'clear button computes position: absolute (elevate rule no longer overrides it)',
      passed: clearPos === 'absolute',
      detail: `computed position = ${clearPos}`,
    });

    // 2. Clear button lies fully INSIDE the input, hugging the right edge.
    const inside =
      clearBox &&
      inputBox &&
      clearBox.x >= inputBox.x &&
      clearBox.x + clearBox.width <= inputBox.x + inputBox.width + 0.5 &&
      clearBox.y >= inputBox.y - 0.5 &&
      clearBox.y + clearBox.height <= inputBox.y + inputBox.height + 0.5;
    const hugsRight =
      clearBox && inputBox &&
      inputBox.x + inputBox.width - (clearBox.x + clearBox.width) <= 12;
    steps.push({
      name: 'clear button box lies inside the input, at the right edge',
      passed: Boolean(inside && hugsRight),
      detail: `input(${fmt(inputBox)}) clear(${fmt(clearBox)}) inside=${inside} hugsRight=${hugsRight}`,
    });

    // 3. Clear button vertically centered on the input.
    const clearCenterOff =
      clearBox && inputBox
        ? Math.abs(
            clearBox.y + clearBox.height / 2 - (inputBox.y + inputBox.height / 2),
          )
        : Infinity;
    steps.push({
      name: 'clear button is vertically centered on the input',
      passed: clearCenterOff <= 2,
      detail: `center offset = ${clearCenterOff.toFixed(2)}px (<= 2px)`,
    });

    // 4. Magnifier / pending icon vertically centered on the left.
    const icon = page
      .locator(
        '[data-testid="input-search"] ~ *, [data-testid="icon-search-pending"]',
      )
      .first();
    const iconBox = await page
      .locator('[data-testid="input-search"]')
      .locator('xpath=preceding-sibling::*[1]')
      .boundingBox()
      .catch(() => null);
    const iconCenterOff =
      iconBox && inputBox
        ? Math.abs(iconBox.y + iconBox.height / 2 - (inputBox.y + inputBox.height / 2))
        : Infinity;
    const iconOnLeft =
      iconBox && inputBox ? iconBox.x - inputBox.x >= 0 && iconBox.x - inputBox.x <= 20 : false;
    steps.push({
      name: 'magnifier/pending icon stays vertically centered at the input left edge',
      passed: iconCenterOff <= 2 && iconOnLeft,
      detail: `icon(${fmt(iconBox)}) centerOffset=${iconCenterOff.toFixed(2)}px onLeft=${iconOnLeft}`,
    });

    // 5. Wrapper no taller than the input — no layout jump when X appears.
    const noJump =
      wrapperBox && inputBox && wrapperBox.height <= inputBox.height + 0.5;
    const heightStable =
      wrapperBoxBefore && wrapperBox
        ? Math.abs(wrapperBox.height - wrapperBoxBefore.height) <= 0.5
        : false;
    steps.push({
      name: 'wrapper is no taller than the input and did not grow when X appeared',
      passed: Boolean(noJump && heightStable),
      detail: `wrapper h before=${wrapperBoxBefore?.height?.toFixed(1)} after=${wrapperBox?.height?.toFixed(1)} input h=${inputBox?.height?.toFixed(1)}`,
    });

    // 6. Elevate ::after overlay still covers the clear button (hover feedback
    //    intact on absolutely-positioned buttons).
    const overlay = await clearBtn.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return {
        content: s.content,
        position: s.position,
        inset: `${s.top} ${s.right} ${s.bottom} ${s.left}`,
      };
    });
    const overlayOk =
      overlay.content !== 'none' &&
      overlay.position === 'absolute' &&
      overlay.inset.split(' ').every((v) => v === '0px' || v === '-1px');
    steps.push({
      name: 'elevate ::after overlay still covers the clear button (hover feedback intact)',
      passed: overlayOk,
      detail: `::after content=${overlay.content} position=${overlay.position} inset=${overlay.inset}`,
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

  console.log(`[searchbar-clear-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[searchbar-clear-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[searchbar-clear-browser] PASSED: the search clear button renders inside the input with correct geometry in a real browser.',
  );
}

main().catch((err) => {
  console.error('[searchbar-clear-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
