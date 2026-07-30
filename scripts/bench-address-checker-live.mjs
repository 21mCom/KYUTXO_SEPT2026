#!/usr/bin/env node
// Task 1636 live benchmark: drives the REAL electron/electrum-client.cjs IPC
// handlers (pooled multiplexed socket) against a live Electrum server, and
// compares:
//   NEW path — batch-history in 40-address chunks (sequential batches, as the
//              Address Checker does; each batch is internally pipelined by the
//              IPC handler with a bounded in-flight window of 8) + balance
//              lookups at concurrency 8;
//   OLD path — the previous sequential behavior: per-address history + utxo
//              lookups one at a time (measured on a sample, extrapolated).
// Also verifies mid-run cancellation semantics of runWithConcurrency.
import { createRequire } from 'node:module';
import * as secp from '@bitcoinerlab/secp256k1';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { registerElectrumHandlers, stopKeepalive } = require('../electron/electrum-client.cjs');
const bitcoin = require('bitcoinjs-lib');

// ---- capture the real IPC handlers via a fake ipcMain -----------------
const handlers = new Map();
registerElectrumHandlers({ handle: (ch, fn) => handlers.set(ch, fn) });
const ipc = (ch, args) => handlers.get(ch)(null, args);

// ---- ported run helpers (mirror client/src/lib/address-checker-run.ts) ----
async function runWithConcurrency(items, worker, { concurrency, isCancelled = () => false }) {
  const failures = [];
  let next = 0;
  async function slot() {
    while (true) {
      if (isCancelled()) return;
      const i = next++;
      if (i >= items.length) return;
      try { await worker(items[i], i); } catch (error) { failures.push({ index: i, error }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, slot));
  return { failures };
}
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// ---- generate N valid, unique mainnet P2WPKH addresses ----------------
// Deterministic (sha256 of a counter as the private key) so the benchmark can
// be run in resumable phases that all see the same address list.
function genAddresses(n) {
  bitcoin.initEccLib(secp);
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const priv = crypto.createHash('sha256').update(`kyutxo-bench-1636-${i}`).digest();
    if (!secp.isPrivate(priv)) continue;
    const pub = Buffer.from(secp.pointFromScalar(priv, true));
    out.push(bitcoin.payments.p2wpkh({ pubkey: pub, network: bitcoin.networks.bitcoin }).address);
  }
  return out;
}

const HOST = process.env.ELECTRUM_HOST || 'electrum.blockstream.info';
const PORT = Number(process.env.ELECTRUM_PORT || 50002);
const SSL = (process.env.ELECTRUM_SSL || '1') === '1';
const N = Number(process.env.N || 5000);
const BATCH = 40, ELECTRUM_CONCURRENCY = 8;
const conn = { host: HOST, port: PORT, useSSL: SSL, timeout: 30000 };

function fmt(ms) { return (ms / 1000).toFixed(1) + 's'; }

// PHASE controls which part runs (so the full 5,000-address measurement can
// be split into resumable sub-5-minute chunks whose network times are
// additive): "batch" (with SLICE=start:end), "balances", "old", "cancel",
// or unset = everything in one process.
const PHASE = process.env.PHASE || '';
const SLICE = process.env.SLICE || '';

async function connect() {
  const test = await ipc('electrum-test', { ...conn, timeout: 15000 });
  if (!test.success) throw new Error('Cannot connect: ' + test.error);
  console.log(`Connected: ${test.serverVersion}, tip=${test.blockHeight}, handshake latency=${test.latency}ms`);
}

async function phaseBatch(addrs) {
  let [s, e] = SLICE ? SLICE.split(':').map(Number) : [0, addrs.length];
  const slice = addrs.slice(s, e);
  const t = Date.now();
  let counts = 0, failures = 0;
  for (const b of chunk(slice, BATCH)) {
    const r = await ipc('electrum-batch-get-history', { ...conn, addresses: b, timeout: 60000 });
    if (!r.success) { failures += b.length; continue; }
    for (const en of r.results) { if (en.success) counts++; else failures++; }
  }
  console.log(`PHASE batch [${s}:${e}] (${Math.ceil(slice.length / BATCH)} batches): elapsed_ms=${Date.now() - t} counts=${counts} failures=${failures}`);
}

async function phaseBalances(addrs) {
  let [s, e] = SLICE ? SLICE.split(':').map(Number) : [0, addrs.length];
  const slice = addrs.slice(s, e);
  const t = Date.now();
  let done = 0, errs = 0;
  await runWithConcurrency(slice, async (a) => {
    const r = await ipc('electrum-get-utxos', { ...conn, address: a });
    if (r.success) done++; else errs++;
  }, { concurrency: ELECTRUM_CONCURRENCY });
  console.log(`PHASE balances [${s}:${e}] @${ELECTRUM_CONCURRENCY}: elapsed_ms=${Date.now() - t} done=${done} errors=${errs}`);
}

async function phaseOld(addrs) {
  const SAMPLE = Number(process.env.OLD_SAMPLE || 200);
  const sample = addrs.slice(0, SAMPLE);
  const t = Date.now();
  for (const a of sample) {
    const h = await ipc('electrum-get-history', { ...conn, address: a });
    if (!h.success) throw new Error('old-path history failed: ' + h.error);
    const u = await ipc('electrum-get-utxos', { ...conn, address: a });
    if (!u.success) throw new Error('old-path utxos failed: ' + u.error);
  }
  const ms = Date.now() - t;
  console.log(`PHASE old sequential sample (${SAMPLE} addrs, history+utxo each): elapsed_ms=${ms} per_addr_ms=${(ms / SAMPLE).toFixed(1)}`);
}

async function phaseCancel(addrs) {
  let cancelled = false, completed = 0, started = 0;
  const cancelAt = 100;
  const t = Date.now();
  await runWithConcurrency(addrs.slice(0, 1000), async (a) => {
    started++;
    const r = await ipc('electrum-get-utxos', { ...conn, address: a });
    if (r.success) completed++;
    if (completed >= cancelAt) cancelled = true;
  }, { concurrency: ELECTRUM_CONCURRENCY, isCancelled: () => cancelled });
  console.log(`PHASE cancel: requested at ${cancelAt} completions; started=${started}, completed=${completed}, drained ${fmt(Date.now() - t)}; overshoot=${started - completed}`);
  if (started - completed > ELECTRUM_CONCURRENCY) throw new Error('cancel overshoot exceeds pool size');
}

async function main() {
  if (PHASE) {
    console.log(`Server: ${HOST}:${PORT} ssl=${SSL}, N=${N}, PHASE=${PHASE} SLICE=${SLICE}`);
    await connect();
    const addrs = genAddresses(N);
    if (PHASE === 'batch') await phaseBatch(addrs);
    else if (PHASE === 'balances') await phaseBalances(addrs);
    else if (PHASE === 'old') await phaseOld(addrs);
    else if (PHASE === 'cancel') await phaseCancel(addrs);
    else throw new Error('Unknown PHASE: ' + PHASE);
    stopKeepalive();
    console.log('PHASE OK');
    return;
  }
  console.log(`Server: ${HOST}:${PORT} ssl=${SSL}, N=${N}`);
  const t0 = Date.now();
  const test = await ipc('electrum-test', { ...conn, timeout: 15000 });
  if (!test.success) throw new Error('Cannot connect: ' + test.error);
  console.log(`Connected: ${test.serverVersion}, tip=${test.blockHeight}, handshake latency=${test.latency}ms`);

  const addrs = genAddresses(N);
  console.log(`Generated ${addrs.length} addresses in ${fmt(Date.now() - t0)}`);

  // ---------- NEW path ----------
  const tNew = Date.now();
  // Phase 1: batch history (tx counts), sequential 40-address batches — exactly as AddressChecker.tsx does.
  const txCounts = new Map();
  let batchFailures = 0;
  for (const b of chunk(addrs, BATCH)) {
    const r = await ipc('electrum-batch-get-history', { ...conn, addresses: b, timeout: 60000 });
    if (!r.success) { batchFailures += b.length; continue; }
    for (const e of r.results) {
      if (e.success) txCounts.set(e.address, (e.history || []).length); else batchFailures++;
    }
  }
  const tBatchDone = Date.now();
  console.log(`NEW phase1 (batch history, ${Math.ceil(N / BATCH)} batches): ${fmt(tBatchDone - tNew)}, counts=${txCounts.size}, failures=${batchFailures}`);

  // Phase 2: balance lookups at concurrency 8 (per-address listunspent).
  let done = 0, errs = 0;
  await runWithConcurrency(addrs, async (a) => {
    const r = await ipc('electrum-get-utxos', { ...conn, address: a });
    if (!r.success) { errs++; return; }
    done++;
  }, { concurrency: ELECTRUM_CONCURRENCY });
  const newTotal = Date.now() - tNew;
  console.log(`NEW phase2 (balances @${ELECTRUM_CONCURRENCY}): ${fmt(Date.now() - tBatchDone)}, done=${done}, errors=${errs}`);
  console.log(`NEW TOTAL for ${N} addresses: ${fmt(newTotal)} (${(newTotal / N).toFixed(1)} ms/addr)`);

  // ---------- OLD sequential baseline (sample, extrapolated) ----------
  const SAMPLE = Number(process.env.OLD_SAMPLE || 200);
  const sample = addrs.slice(0, SAMPLE);
  const tOld = Date.now();
  for (const a of sample) {
    const h = await ipc('electrum-get-history', { ...conn, address: a });
    if (!h.success) throw new Error('old-path history failed: ' + h.error);
    const u = await ipc('electrum-get-utxos', { ...conn, address: a });
    if (!u.success) throw new Error('old-path utxos failed: ' + u.error);
  }
  const oldSampleMs = Date.now() - tOld;
  const oldProjected = (oldSampleMs / SAMPLE) * N;
  console.log(`OLD sequential sample (${SAMPLE} addrs, history+utxo each): ${fmt(oldSampleMs)} → projected ${N}: ${fmt(oldProjected)} (${(oldSampleMs / SAMPLE).toFixed(1)} ms/addr)`);
  console.log(`SPEEDUP: ${(oldProjected / newTotal).toFixed(2)}x`);

  // ---------- Cancellation: stop mid-run, completed results retained ----------
  let cancelled = false, completed = 0, started = 0;
  const cancelAt = 100;
  const tC = Date.now();
  await runWithConcurrency(addrs.slice(0, 1000), async (a) => {
    started++;
    const r = await ipc('electrum-get-utxos', { ...conn, address: a });
    if (r.success) completed++;
    if (completed >= cancelAt) cancelled = true;
  }, { concurrency: ELECTRUM_CONCURRENCY, isCancelled: () => cancelled });
  const stopLagMs = Date.now() - tC;
  console.log(`CANCEL: requested at ${cancelAt} completions; started=${started}, completed=${completed}, pool drained ${fmt(stopLagMs)} after start; in-flight overshoot=${started - completed}`);
  if (started - completed > ELECTRUM_CONCURRENCY) throw new Error('cancel overshoot exceeds pool size');

  stopKeepalive();
  console.log('BENCH OK');
}

main().catch(e => { console.error('BENCH FAILED:', e); stopKeepalive(); process.exit(1); });
