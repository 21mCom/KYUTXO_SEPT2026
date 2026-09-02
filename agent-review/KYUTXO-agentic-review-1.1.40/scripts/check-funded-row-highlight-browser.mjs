#!/usr/bin/env node
// Real-browser regression guard for the Address Checker funded-row highlight.
//
// Rows with balance > 0 get `bg-primary/10 hover:bg-primary/15 dark:bg-primary/15
// dark:hover:bg-primary/20` plus data-funded="true". jsdom tests assert the
// attribute/class strings, but only a real browser proves the tint actually
// renders visually distinguishable from a normal row — Tailwind opacity
// utilities plus theme tokens can silently compute to a near-invisible or
// fully transparent background in either theme.
//
// This drives a headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. Navigates to /address-checker.
//   3. Intercepts the mempool.space address-stats calls, returning a funded
//      (balance > 0) response for one address and a zero-balance response for
//      another, then runs a check on both.
//   4. Asserts, in BOTH light and dark mode:
//      - the funded row carries data-funded="true", the zero row does not
//      - the funded row's computed background-color differs from the zero row's
//      - the funded tint has non-trivial alpha (actually visible, not ~0)
//   5. Asserts the funded row's dark-mode background differs from its
//      light-mode background (the dark: variants actually apply).
//
// Usage: node scripts/check-funded-row-highlight-browser.mjs
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
const SETUP_PASSWORD = 'funded-row-highlight-check-123';

// Both genuinely valid mainnet addresses (validateAddress runs client-side);
// the stats responses are stubbed, so the values below are entirely ours.
const FUNDED_ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ZERO_ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

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

function statsBody(address, { funded }) {
  const fundedSum = funded ? 150_000 : 50_000;
  const spentSum = funded ? 0 : 50_000; // zero row: fully spent => balance 0
  return JSON.stringify({
    address,
    chain_stats: {
      funded_txo_count: 1,
      funded_txo_sum: fundedSum,
      spent_txo_count: funded ? 0 : 1,
      spent_txo_sum: spentSum,
      tx_count: funded ? 1 : 2,
    },
    mempool_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    },
  });
}

function parseRgb(color) {
  // getComputedStyle backgroundColor: "rgb(r, g, b)" or "rgba(r, g, b, a)".
  const m = /rgba?\(([^)]+)\)/.exec(color || '');
  if (!m) return null;
  const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
  const [r, g, b, a = 1] = parts;
  return { r, g, b, a };
}

// "Visually distinguishable": either the alpha differs meaningfully, or the
// opaque channels differ by a perceptible amount.
function visiblyDifferent(cFunded, cZero) {
  const a = parseRgb(cFunded);
  const b = parseRgb(cZero);
  if (!a || !b) return false;
  const alphaDiff = Math.abs(a.a - b.a);
  const channelDiff =
    Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  // If both are effectively transparent, they are NOT distinguishable.
  if (a.a < 0.03 && b.a < 0.03) return false;
  return alphaDiff >= 0.03 || (channelDiff >= 8 && (a.a >= 0.03 || b.a >= 0.03));
}

async function main() {
  const exe = resolveChromium();
  console.log(`[funded-row-highlight-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[funded-row-highlight-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[funded-row-highlight-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[funded-row-highlight-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    // Fresh context => empty IndexedDB => setup form. Block the PWA service
    // worker so a stale cached bundle can't serve OLD css/js.
    const context = await browser.newContext({ serviceWorkers: 'block' });

    // Stub the address-stats endpoints for BOTH default providers'
    // hosts (mempool.space / blockstream.info) so the check never touches the
    // network and deterministically yields one funded + one zero-balance row.
    await context.route('**/api/address/**', async (route) => {
      const url = route.request().url();
      const cors = {
        'access-control-allow-origin': '*',
        'content-type': 'application/json',
      };
      if (url.includes(FUNDED_ADDRESS)) {
        return route.fulfill({ status: 200, headers: cors, body: statsBody(FUNDED_ADDRESS, { funded: true }) });
      }
      if (url.includes(ZERO_ADDRESS)) {
        return route.fulfill({ status: 200, headers: cors, body: statsBody(ZERO_ADDRESS, { funded: false }) });
      }
      return route.fulfill({ status: 404, headers: cors, body: '{}' });
    });

    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[funded-row-highlight-browser][page-console] ${t}`);
      }
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });

    // Wait for the app shell, then navigate to the Address Checker via the SPA
    // router (history.pushState keeps the unlocked in-memory session alive —
    // a full page.goto would reload and re-lock the vault).
    await page.getByTestId('input-search').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => {
      window.history.pushState({}, '', '/address-checker');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });
    await textarea.fill(`${FUNDED_ADDRESS}\n${ZERO_ADDRESS}`);
    await page.getByTestId('button-run-check').click();

    // Both rows resolve from the stubbed responses.
    await page.getByTestId('alert-check-complete').waitFor({ state: 'visible', timeout: 30_000 });

    const fundedRow = page.getByTestId('row-address-0');
    const zeroRow = page.getByTestId('row-address-1');

    // Sanity: the funded marker attribute is on exactly the funded row.
    const fundedAttr = await fundedRow.getAttribute('data-funded');
    const zeroAttr = await zeroRow.getAttribute('data-funded');
    steps.push({
      name: 'data-funded="true" on the funded row only',
      passed: fundedAttr === 'true' && zeroAttr === null,
      detail: `funded row attr=${JSON.stringify(fundedAttr)} zero row attr=${JSON.stringify(zeroAttr)}`,
    });

    // Toggle the theme class, wait out the row's `transition-colors`
    // animation (reading immediately returns the mid-transition OLD color),
    // then read both rows' computed backgrounds.
    const readBgs = (theme) =>
      page.evaluate(async (mode) => {
        document.documentElement.classList.toggle('dark', mode === 'dark');
        await new Promise((r) => setTimeout(r, 600));
        const get = (id) =>
          getComputedStyle(document.querySelector(`[data-testid="${id}"]`)).backgroundColor;
        return {
          funded: get('row-address-0'),
          zero: get('row-address-1'),
          htmlClass: document.documentElement.className,
        };
      }, theme);

    // ── Light theme ─────────────────────────────────────────────────────────
    const light = await readBgs('light');
    steps.push({
      name: 'LIGHT: funded row background visibly differs from zero-balance row',
      passed: visiblyDifferent(light.funded, light.zero),
      detail: `funded=${light.funded} zero=${light.zero}`,
    });

    // ── Dark theme ──────────────────────────────────────────────────────────
    const dark = await readBgs('dark');
    steps.push({
      name: 'DARK: funded row background visibly differs from zero-balance row',
      passed: visiblyDifferent(dark.funded, dark.zero),
      detail: `funded=${dark.funded} zero=${dark.zero}`,
    });

    // The dark: variants actually apply — the funded tint is not the same
    // computed color in both themes (primary token and/or opacity shifts).
    steps.push({
      name: 'funded tint responds to theme (dark computed bg != light computed bg)',
      passed: dark.funded !== light.funded,
      detail: `light=${light.funded} dark=${dark.funded}`,
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

  console.log(`[funded-row-highlight-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[funded-row-highlight-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[funded-row-highlight-browser] PASSED: the funded-row highlight is visually distinguishable in both light and dark themes in a real browser.',
  );
}

main().catch((err) => {
  console.error('[funded-row-highlight-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
