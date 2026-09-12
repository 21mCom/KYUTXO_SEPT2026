#!/usr/bin/env node
// Real-browser regression guard for Trusted Types enforcement.
//
// The packaged desktop app sends a production CSP with
// `require-trusted-types-for 'script'` (electron/main.cjs), which makes the
// browser reject raw-string assignments to HTML-parsing sinks (innerHTML,
// dangerouslySetInnerHTML, document.write, ...). All app-owned sinks are
// routed through the named Trusted Types policy in
// client/src/lib/trusted-types.ts. The dev server does NOT send that CSP, so
// this script injects an equivalent header into every document response and
// then drives the chart showcase page in headless Chromium:
//   1. Proves enforcement is actually active (a raw innerHTML assignment
//      throws a TypeError in the page).
//   2. Asserts ChartStyle's <style> element still renders its CSS variables
//      (the policy-routed dangerouslySetInnerHTML path).
//   3. Asserts the recharts SVG charts still render.
//   4. Fails if any Trusted Types violation appears in the page console.
//
// Usage: node scripts/check-trusted-types-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const UI_ASSETS_URL = `${BASE_URL}dev/ui-assets`;
const SETUP_PASSWORD = 'trusted-types-check-123';

// Production-equivalent CSP for the parts under test. script/style/connect
// are relaxed for the Vite dev server (inline react-refresh preamble, HMR
// websocket); the directive under test — require-trusted-types-for — matches
// electron/main.cjs exactly.
const ENFORCING_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss: http://localhost:* https://mempool.space https://blockstream.info",
  "require-trusted-types-for 'script'",
  "trusted-types kyutxo-app default",
].join('; ');

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

async function launchWithRetry(exe, attempts = 4) {
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
      console.log(`[trusted-types-browser] launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[trusted-types-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[trusted-types-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[trusted-types-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[trusted-types-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => the "Create Vault" setup form.
    // Block the PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });

    // Inject the enforcing CSP into every document response so Trusted Types
    // are actually enforced in this dev-server session.
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (request.resourceType() !== 'document') {
        return route.continue();
      }
      try {
        const response = await route.fetch();
        const headers = {
          ...response.headers(),
          'content-security-policy': ENFORCING_CSP,
        };
        await route.fulfill({ response, headers });
      } catch {
        await route.continue();
      }
    });

    const page = await context.newPage();
    const ttViolations = [];
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[trusted-types-browser][page-console] ${t}`);
      }
      if (/trusted ?type/i.test(t) && /(violation|requires|refused|blocked)/i.test(t)) {
        ttViolations.push(t);
      }
    });
    page.on('pageerror', (err) => {
      if (/trusted ?type/i.test(err.message)) ttViolations.push(err.message);
    });

    // Retry the initial load once: a cold dev server can be slow to transform.
    let loaded = false;
    for (let i = 0; i < 2 && !loaded; i++) {
      try {
        await page.goto(UI_ASSETS_URL, { waitUntil: 'load', timeout: 60_000 });
        await waitForLoginScreenVisible(page, { timeoutMs: 45_000 });
        loaded = true;
      } catch (err) {
        console.log(`[trusted-types-browser] initial load attempt ${i + 1} failed: ${err.message}`);
      }
    }
    if (!loaded) throw new Error('Could not load the app setup page.');

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD);

    // ── Step 1: enforcement is really on ───────────────────────────────────
    const enforcement = await page.evaluate(() => {
      if (!('trustedTypes' in window)) return { state: 'api-missing' };
      const probe = document.createElement('div');
      try {
        probe.innerHTML = '<span>raw</span>';
        // A default policy that passes everything through would land here.
        return probe.querySelector('span')
          ? { state: 'raw-allowed' }
          : { state: 'blocked-silently' };
      } catch (err) {
        // Either the browser's own TypeError (no default policy) or our
        // default policy's explicit rejection — both mean enforcement works.
        return { state: 'blocked', message: String(err && err.message || err) };
      }
    });
    steps.push({
      name: 'CSP delivered: raw innerHTML assignment is rejected by the browser',
      passed: enforcement.state === 'blocked' || enforcement.state === 'blocked-silently',
      detail: `probe = ${enforcement.state}${enforcement.message ? ` (${enforcement.message})` : ''}`,
    });

    // ── Step 2: the SPA is already on /dev/ui-assets after vault creation ──
    // (a second page.goto would reload into the vault-lock screen).
    await page.getByTestId('chart-line').waitFor({ state: 'visible', timeout: 45_000 });

    // ── Step 3: ChartStyle <style> (dangerouslySetInnerHTML) still renders ─
    const styleInfo = await page.evaluate(() => {
      const holder = document.querySelector('[data-chart]');
      if (!holder) return { holder: false, styles: 0, sample: '' };
      const styles = [...holder.querySelectorAll('style')];
      return {
        holder: true,
        styles: styles.length,
        sample: styles.map((s) => s.textContent || '').join('\n').slice(0, 200),
      };
    });
    steps.push({
      name: 'ChartStyle <style> element renders via the Trusted Types policy',
      passed: styleInfo.holder && styleInfo.styles > 0 && styleInfo.sample.includes('--color-'),
      detail: `data-chart holder=${styleInfo.holder}, style tags=${styleInfo.styles}, sample=${JSON.stringify(styleInfo.sample)}`,
    });

    // ── Step 4: the recharts SVGs still render ─────────────────────────────
    for (const testid of ['chart-line', 'chart-area', 'chart-bar', 'chart-pie']) {
      const svgCount = await page
        .getByTestId(testid)
        .locator('svg.recharts-surface')
        .count();
      steps.push({
        name: `recharts SVG renders inside ${testid} under Trusted Types`,
        passed: svgCount > 0,
        detail: `svg.recharts-surface count = ${svgCount}`,
      });
    }

    // ── Step 5: no Trusted Types violations from app code ──────────────────
    steps.push({
      name: 'no Trusted Types violations logged by app code',
      passed: ttViolations.length === 0,
      detail: ttViolations.length === 0 ? 'console clean' : ttViolations.join(' || '),
    });
  } finally {
    await browser.close().catch(() => {});
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        devProc.kill('SIGTERM');
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log('\n[trusted-types-browser] Results:');
  for (const s of steps) {
    console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
  }
  const failed = steps.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\n[trusted-types-browser] ${failed.length}/${steps.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n[trusted-types-browser] all ${steps.length} checks passed`);
}

main().catch((err) => {
  console.error('[trusted-types-browser] fatal:', err);
  process.exit(1);
});
