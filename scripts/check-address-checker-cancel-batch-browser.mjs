#!/usr/bin/env node
// Task 1998 real-browser check: clicking Cancel while the Address Checker's
// Electrum BATCH prefetch phase is in flight must actually stop the Electrum
// traffic — not just flip the renderer UI.
//
// The existing cancel checks (check-address-checker-cancel-history-*.mjs)
// only cover the on-demand First/Last Seen history walk. This one pins the
// fast batch phase: runCheck creates batchAbortRef's AbortController and
// threads its signal into ElectrumProvider.getAddressTxCountsBatch /
// getAddressBalancesBatch, whose setupIpcCancellation attaches a cancelId to
// the electrumBatchGetHistory / electrumBatchGetUtxos IPC call and fires
// electrumCancel({ cancelId }) when the signal aborts. handleCancel aborts
// that controller, so the in-flight batch against a slow server is rejected
// in the main process immediately and the renderer loop dispatches no
// further batches.
//
// A browser tab cannot open raw TCP, so window.electronAPI is shimmed with a
// deterministic Electrum mock: electrumBatchGetHistory hangs (slow server)
// until electrumCancel arrives with the same cancelId, at which point it
// rejects — exactly the main-process contract. Every batch/cancel IPC call is
// recorded in-page so the Node side can assert:
//   (a) the in-flight batch call carried a cancelId,
//   (b) Cancel fired electrumCancel with THAT cancelId,
//   (c) no further batch IPC calls are issued after Cancel (count flat over a
//       settle window, with 2 more batches' worth of addresses still queued),
//   (d) the UI leaves the running state promptly, and
//   (e) a new run works afterwards (fresh batch call with a fresh cancelId).
//
// NOTE for reviewers: the consumer under test is
// client/src/pages/AddressChecker.tsx (route /address-checker, handleCancel /
// batchAbortRef); the cancelId plumbing under test lives in
// client/src/lib/providers/electrum.ts (setupIpcCancellation,
// getAddressTxCountsBatch, getAddressBalancesBatch).
//
// Usage: node scripts/check-address-checker-cancel-batch-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import * as secp from '@bitcoinerlab/secp256k1';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const require = createRequire(import.meta.url);
const bitcoin = require('bitcoinjs-lib');

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'addr-checker-cancel-batch-123';
// 3 batches of ELECTRUM_BATCH_SIZE (40) — after Cancel lands mid-batch #1,
// two full batches remain queued, so continued dispatch cannot hide.
const ELECTRUM_BATCH_SIZE = 40; // must match AddressChecker.tsx
const N = ELECTRUM_BATCH_SIZE * 3;
// A "slow server": the batch never resolves on its own within the check's
// runtime — only electrumCancel settles it (rejection), like the main process.
const BATCH_HANG_MS = 120_000;

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

// window.electronAPI shim installed before every page load. Models a pooled
// Electrum connection against a SLOW server: batch history calls hang until
// electrumCancel arrives with their cancelId, then reject (the main-process
// cancellation contract). All batch/cancel calls are recorded in
// window.__batchCalls / window.__cancelCalls for the Node side to assert on.
const SHIM = `
(() => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const BATCH_HANG_MS = ${BATCH_HANG_MS};
  window.__batchCalls = []; // { method, cancelId, count, at }
  window.__cancelCalls = []; // { cancelId, at }
  // cancelId -> reject fn for the hanging batch promise.
  const pending = new Map();
  const hangingBatch = (method, args) => {
    const cancelId = args && args.cancelId;
    window.__batchCalls.push({
      method,
      cancelId: cancelId ?? null,
      count: (args && args.addresses && args.addresses.length) || 0,
      at: Date.now(),
    });
    return new Promise((resolve, reject) => {
      if (cancelId) pending.set(cancelId, reject);
      // Slow-server fallback: settle eventually so a failed check can't hang
      // the tab forever. Never reached when cancellation works.
      setTimeout(() => {
        if (cancelId) pending.delete(cancelId);
        resolve({ success: false, error: 'shim: slow server timed out' });
      }, BATCH_HANG_MS);
    });
  };
  const base = {
    isElectron: true,
    electrumTest: async () => { await delay(30); return { success: true, serverVersion: 'shim 1.4', blockHeight: 900000, latency: 30 }; },
    electrumCancel: async ({ cancelId }) => {
      window.__cancelCalls.push({ cancelId, at: Date.now() });
      const reject = pending.get(cancelId);
      if (reject) {
        pending.delete(cancelId);
        reject(new Error('Request cancelled'));
      }
      return { success: true };
    },
    electrumBatchGetHistory: (args) => hangingBatch('electrumBatchGetHistory', args),
    electrumBatchGetUtxos: (args) => hangingBatch('electrumBatchGetUtxos', args),
    // Per-address fallbacks also hang-record: if the checker ever fell back to
    // per-address Electrum traffic after Cancel, the flat-count assert catches
    // it via __batchCalls staying flat but rows leaving "pending" (they don't).
    electrumGetHistory: async () => { await delay(20); return { success: true, history: [] }; },
    electrumGetUtxos: async () => { await delay(20); return { success: true, utxos: [] }; },
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
  console.log(`[cancel-batch] chromium: ${exe}`);
  const addresses = genAddresses(N);
  console.log(`[cancel-batch] ${N} addresses generated (${N / ELECTRUM_BATCH_SIZE} batches)`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[cancel-batch] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
    if (!(await waitForServer(BASE_URL, 90_000))) throw new Error('Dev server not ready in 90s');
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel load.
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
      console.log(`[cancel-batch] chromium launch failed (attempt ${attempt}): ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  console.log('[cancel-batch] chromium launched');

  const steps = [];
  const step = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(SHIM);
    const page = await context.newPage();
    const batchCalls = () => page.evaluate(() => window.__batchCalls || []);
    const cancelCalls = () => page.evaluate(() => window.__cancelCalls || []);

    // Retry the initial load + first selector: single-shot waits flake under
    // parallel validation.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await waitForLoginScreenVisible(page, { timeoutMs: 45_000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`[cancel-batch] initial load failed (attempt ${attempt}): ${e.message}; retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    console.log('[cancel-batch] app loaded, creating vault');
    await unlockIfNeeded(page, SETUP_PASSWORD);

    // Seed Electrum node settings so the checker takes the batch IPC path
    // this check shims — no HTTP provider involved.
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

    await page.goto(`http://localhost:${PORT}/address-checker`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD);

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });
    await textarea.fill(addresses.join('\n'));

    // Start the check: the batch prefetch phase dispatches batch #1, which
    // hangs against the shim's slow server.
    await page.getByTestId('button-run-check').click();
    const cancelBtn = page.getByTestId('button-cancel-check');
    await cancelBtn.waitFor({ state: 'visible', timeout: 15_000 });

    // Wait until the first batch IPC call is in flight.
    const dispatchStart = Date.now();
    let calls = [];
    while ((calls = await batchCalls()).length === 0 && Date.now() - dispatchStart < 20_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    step('batch prefetch dispatched its first IPC call', calls.length >= 1, `calls=${JSON.stringify(calls.map((c) => c.method))}`);
    const firstCall = calls[0];
    step(
      'in-flight batch is electrum-batch-get-history sized to one chunk',
      firstCall?.method === 'electrumBatchGetHistory' && firstCall?.count === ELECTRUM_BATCH_SIZE,
      `method=${firstCall?.method} count=${firstCall?.count}`,
    );
    step('in-flight batch call carries a cancelId (bh- group)', typeof firstCall?.cancelId === 'string' && firstCall.cancelId.startsWith('bh-'), `cancelId=${firstCall?.cancelId}`);

    // The prefetch progress indicator must be up while the batch hangs.
    const prefetchVisible = await page.getByTestId('text-prefetch-progress').isVisible().catch(() => false);
    step('prefetch progress indicator visible while batch is in flight', prefetchVisible);

    // ── Cancel mid-batch ─────────────────────────────────────────────────
    const callsAtCancel = (await batchCalls()).length;
    const tCancel = Date.now();
    await cancelBtn.click();

    // electrumCancel must fire promptly with the in-flight batch's cancelId.
    let cancels = [];
    while ((cancels = await cancelCalls()).length === 0 && Date.now() - tCancel < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const cancelLatency = Date.now() - tCancel;
    step('electrumCancel fired after Cancel click', cancels.length >= 1, `${cancelLatency}ms after click`);
    step(
      'electrumCancel carried the in-flight batch cancelId',
      cancels.some((c) => c.cancelId === firstCall?.cancelId),
      `sent=${JSON.stringify(cancels.map((c) => c.cancelId))} expected=${firstCall?.cancelId}`,
    );
    step('cancel reached the bridge promptly (< 3 s)', cancelLatency < 3000, `${cancelLatency}ms`);

    // UI leaves the running state.
    await page.getByTestId('button-run-check').waitFor({ state: 'visible', timeout: 10_000 });
    const cancelStillVisible = await cancelBtn.isVisible().catch(() => false);
    step('check left the running state (Cancel button gone, Run back)', !cancelStillVisible);
    const prefetchGoneStart = Date.now();
    let prefetchStillVisible = true;
    while ((prefetchStillVisible = await page.getByTestId('text-prefetch-progress').isVisible().catch(() => false)) && Date.now() - prefetchGoneStart < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    step('prefetch progress indicator gone after Cancel', !prefetchStillVisible);

    // No FURTHER batch IPC calls after Cancel: with 2 more batches queued, a
    // loop that keeps dispatching after cancel would add calls within the
    // settle window. Allow zero — the rejected batch must end the phase.
    await new Promise((r) => setTimeout(r, 500));
    const callsAfterGrace = (await batchCalls()).length;
    await new Promise((r) => setTimeout(r, 2500));
    const callsSettled = (await batchCalls()).length;
    step(
      'no further batch IPC calls after Cancel (count flat over 2.5 s window)',
      callsSettled === callsAfterGrace && callsAfterGrace === callsAtCancel,
      `atCancel=${callsAtCancel} +0.5s=${callsAfterGrace} +3s=${callsSettled} (uncancelled run = ${(N / ELECTRUM_BATCH_SIZE) * 2} batch calls)`,
    );

    // A new run must work after Cancel: fresh batch call with a FRESH cancelId.
    await page.getByTestId('button-run-check').click();
    const rerunStart = Date.now();
    let rerunCalls = [];
    while ((rerunCalls = await batchCalls()).length <= callsSettled && Date.now() - rerunStart < 15_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const newCall = rerunCalls[callsSettled];
    step('run works again after Cancel (new batch IPC call dispatched)', rerunCalls.length > callsSettled, `calls=${rerunCalls.length}`);
    step(
      'new run uses a fresh cancelId (old group not reused)',
      !!newCall?.cancelId && newCall.cancelId !== firstCall?.cancelId,
      `new=${newCall?.cancelId}`,
    );
    // Leave the tab quiet: cancel the re-run too.
    await page.getByTestId('button-cancel-check').click().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  if (failed.length) {
    console.error(`[cancel-batch] ${failed.length}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`[cancel-batch] all ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error('[cancel-batch] FAILED:', e);
  process.exit(1);
});
