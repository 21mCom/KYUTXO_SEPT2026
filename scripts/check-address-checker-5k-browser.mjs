#!/usr/bin/env node
// Task 1636 real-browser check: with a 5,000-address list in the Address
// Checker, the table must stay scrollable/responsive during the run (no
// multi-second main-thread freezes), and Stop must halt promptly while
// completed rows keep their results.
//
// Network truth (wall-clock speedup vs the old sequential path) is measured
// separately against a live Electrum server by
// scripts/bench-address-checker-live.mjs, which drives the real
// electron/electrum-client.cjs pool. A browser tab cannot open raw TCP, so
// here window.electronAPI is shimmed with deterministic per-call latencies —
// what this check pins down is the RENDERING path: 250 ms patch flushes,
// batch fan-out, cancel semantics, and scroll responsiveness with 5,000 rows.
//
// Usage: node scripts/check-address-checker-5k-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import * as secp from '@bitcoinerlab/secp256k1';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const require = createRequire(import.meta.url);
const bitcoin = require('bitcoinjs-lib');

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'addr-checker-5k-check-123';
const N = Number(process.env.N || 5000);

function genAddresses(n) {
  bitcoin.initEccLib(secp);
  const out = [];
  for (let i = 0; i < n; i++) {
    let pub;
    do {
      const priv = crypto.randomBytes(32);
      pub = secp.isPrivate(priv) ? Buffer.from(secp.pointFromScalar(priv, true)) : null;
    } while (!pub);
    out.push(bitcoin.payments.p2wpkh({ pubkey: pub, network: bitcoin.networks.bitcoin }).address);
  }
  return out;
}

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

// window.electronAPI shim installed before every page load. Deterministic
// latencies model a fast pooled Electrum socket: batch history ≈ 2 ms per
// address inside the batch, listunspent ≈ 12 ms per call. Unknown methods
// resolve to a generic failure so unrelated Electron-only probes stay
// non-fatal.
const SHIM = `
(() => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = {
    isElectron: true,
    electrumTest: async () => { await delay(30); return { success: true, serverVersion: 'shim 1.4', blockHeight: 900000, latency: 30 }; },
    electrumGetHistory: async ({ address }) => {
      await delay(25);
      const n = address.charCodeAt(address.length - 1) % 3;
      return { success: true, history: Array.from({ length: n }, (_, k) => ({ tx_hash: 'f'.repeat(63) + k, height: 800000 + k })) };
    },
    electrumBatchGetHistory: async ({ addresses }) => {
      await delay(2 * addresses.length);
      return {
        success: true,
        results: addresses.map((address) => ({
          address,
          success: true,
          history: Array.from({ length: address.charCodeAt(address.length - 1) % 3 }, (_, k) => ({ tx_hash: 'e'.repeat(63) + k, height: 800000 + k })),
        })),
      };
    },
    electrumGetUtxos: async ({ address }) => {
      await delay(12);
      const funded = address.charCodeAt(address.length - 2) % 4 === 0;
      return { success: true, utxos: funded ? [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 12345, height: 800000 }] : [] };
    },
  };
  window.electronAPI = new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== 'string') return undefined;
      return async () => ({ success: false, error: 'not implemented in shim' });
    },
  });
})();
`;

async function main() {
  const exe = resolveChromium();
  console.log(`[addr-checker-5k] chromium: ${exe}, N=${N}`);
  const addresses = genAddresses(N);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[addr-checker-5k] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
    if (!(await waitForServer(BASE_URL, 90_000))) throw new Error('Dev server not ready in 90s');
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel
  // validation load.
  let browser = null;
  for (let attempt = 1; attempt <= 3 && !browser; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`[addr-checker-5k] chromium launch failed (attempt ${attempt}): ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }

  const steps = [];
  const step = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(SHIM);
    const page = await context.newPage();

    // Retry the initial load + first selector: single-shot waits flake under
    // parallel validation.
    const pwInput = page.getByTestId('input-password');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await pwInput.waitFor({ state: 'visible', timeout: 45_000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`[addr-checker-5k] initial load failed (attempt ${attempt}): ${e.message}; retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // Create the vault.
    await pwInput.fill(SETUP_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page.getByTestId('button-dismiss-migration').click({ timeout: 5_000 }).catch(() => {});

    // Seed Electrum node settings via the Vite-singleton CRUD module.
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const nodeCrud = await import('/src/lib/data/node-settings-crud.ts');
      await nodeCrud.putNodeSettings({
        id: 'default',
        providerType: 'mempool-space',
        useTor: false,
        requestTimeout: 30000,
        network: 'mainnet',
        allowLocalNetwork: false,
        trustedLocalHosts: [],
        useElectrum: true,
        electrumHost: 'shim.local',
        electrumPort: 50001,
        electrumSSL: false,
      });
    });

    await page.goto(BASE_URL + '#/address-checker', { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
    // The app may use path routing instead of hash routing; navigate in-app if needed.
    if (!(await page.getByTestId('textarea-address-input').isVisible().catch(() => false))) {
      await page.goto(`http://localhost:${PORT}/address-checker`, { waitUntil: 'load', timeout: 60_000 });
      await page.getByTestId('button-dismiss-migration').click({ timeout: 3_000 }).catch(() => {});
      // May need to unlock after reload.
      const unlockPw = page.getByTestId('input-password');
      if (await unlockPw.isVisible().catch(() => false)) {
        await unlockPw.fill(SETUP_PASSWORD);
        await page.getByTestId('button-submit').click();
        await page.getByTestId('button-dismiss-migration').click({ timeout: 5_000 }).catch(() => {});
      }
    }

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });

    // Long-task observer: any main-thread block > 50 ms is recorded.
    await page.evaluate(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    });

    // Paste 5,000 addresses (set value directly — typing 220 KB is too slow).
    await textarea.evaluate((el, text) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, addresses.join('\n'));

    const t0 = Date.now();
    await page.evaluate(() => { window.__clickAt = performance.now(); });
    await page.getByTestId('button-run-check').click();
    await page.getByTestId('button-cancel-check').waitFor({ state: 'visible', timeout: 15_000 });

    step('run started: 5,000 rows rendered', (await page.getByTestId('row-address-0').count()) === 1);

    // ── Responsiveness probes while the run is under way ────────────────
    // Every ~400 ms: measure event-loop latency in-page and scroll the page
    // scroller, asserting scrollTop actually moves.
    const probes = [];
    let scrollFailures = 0;
    const doneCount = async () =>
      Number((await page.getByTestId('text-progress').textContent().catch(() => '0 /'))?.split('/')[0]?.trim() || 0);

    // Probe until at least ~15% of rows are done (well into phase 2), max 60 s.
    const probeDeadline = Date.now() + 60_000;
    while (Date.now() < probeDeadline) {
      const p = await page.evaluate(async () => {
        const t = performance.now();
        await new Promise((r) => setTimeout(r, 0));
        const loopLag = performance.now() - t;
        const scroller = document.querySelector('.flex-1.overflow-y-auto');
        let scrolled = null;
        if (scroller && scroller.scrollHeight > scroller.clientHeight) {
          const before = scroller.scrollTop;
          scroller.scrollTop = before + 400 > scroller.scrollHeight - scroller.clientHeight ? 0 : before + 400;
          scrolled = scroller.scrollTop !== before;
        }
        return { loopLag, scrolled };
      });
      probes.push(p.loopLag);
      if (p.scrolled === false) scrollFailures++;
      const done = await doneCount();
      if (done >= Math.max(400, N * 0.08)) break;
      await page.waitForTimeout(400);
    }
    const doneAtCancel = await doneCount();
    step(
      'run makes progress (rows completing while probing)',
      doneAtCancel > 0,
      `done=${doneAtCancel} after ${(Date.now() - t0) / 1000}s, probes=${probes.length}`,
    );
    const maxLag = Math.max(...probes);
    step('event loop stays responsive during run (max setTimeout(0) lag < 2000 ms)', maxLag < 2000, `max lag=${maxLag.toFixed(0)}ms over ${probes.length} probes`);
    step('page scroller scrolls during the run', scrollFailures === 0, `scroll failures=${scrollFailures}`);

    // ── Stop mid-run ─────────────────────────────────────────────────────
    const tCancel = Date.now();
    await page.getByTestId('button-cancel-check').click();
    // isRunning=false ⇒ Cancel button unmounts and Reset appears.
    await page.getByTestId('button-reset-check').waitFor({ state: 'visible', timeout: 10_000 });
    const cancelLatency = Date.now() - tCancel;
    step('Stop halts promptly (< 3 s to leave running state)', cancelLatency < 3000, `${cancelLatency}ms`);

    // Give the final buffer flush + safety net a beat, then inspect rows.
    await page.waitForTimeout(700);
    const rowStats = await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-testid^="row-address-"]');
      let done = 0, checking = 0, withTx = 0, withBalance = 0;
      for (const r of rows) {
        const badge = r.cells?.[1]?.textContent || r.children[1]?.textContent || '';
        if (badge.includes('Done')) {
          done++;
          const tx = r.children[2]?.textContent?.trim();
          if (tx && tx !== '—') withTx++;
          const bal = r.children[5]?.textContent?.trim();
          if (bal && bal !== '—') withBalance++;
        }
        if (badge.includes('Checking')) checking++;
      }
      return { total: rows.length, done, checking, withTx, withBalance };
    });
    step('completed rows keep their results after Stop', rowStats.done > 0 && rowStats.withTx > 0 && rowStats.withBalance > 0,
      `done=${rowStats.done} withTxCount=${rowStats.withTx} withBalance=${rowStats.withBalance}`);
    step('no row left stuck on "Checking" after Stop', rowStats.checking === 0, `checking=${rowStats.checking}`);
    // No new completions should land after cancel settles.
    const doneAfter = rowStats.done;
    await page.waitForTimeout(1500);
    const doneLater = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="row-address-"]')).filter((r) => (r.children[1]?.textContent || '').includes('Done')).length,
    );
    step('run actually stopped (done count stable after Stop)', doneLater === doneAfter, `done ${doneAfter} → ${doneLater}`);

    const longTasks = await page.evaluate(() => window.__longTasks || []);
    const clickAt = await page.evaluate(() => window.__clickAt || 0);
    const worstEntry = longTasks.reduce((a, b) => (b.dur > (a?.dur ?? 0) ? b : a), null);
    const worst = worstEntry?.dur ?? 0;
    step('no multi-second main-thread freeze (worst long task < 2000 ms)', worst < 2000,
      `longtasks=${longTasks.length}, worst=${worst.toFixed(0)}ms at +${worstEntry ? (worstEntry.start - clickAt).toFixed(0) : '?'}ms after Check click; top5=${longTasks.sort((a, b) => b.dur - a.dur).slice(0, 5).map((e) => `${e.dur.toFixed(0)}@+${(e.start - clickAt).toFixed(0)}`).join(',')}`);
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  if (failed.length) {
    console.error(`[addr-checker-5k] ${failed.length}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`[addr-checker-5k] all ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error('[addr-checker-5k] FAILED:', e);
  process.exit(1);
});
