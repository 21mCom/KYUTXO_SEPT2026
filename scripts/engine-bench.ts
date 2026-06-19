/**
 * At-scale Node benchmark for the KYUTXO native read-engine.
 *
 * Runs the EXACT engine-core SQL against the EXACT better-sqlite3 driver we ship
 * in the Electron worker, on a real on-disk database file — so we de-risk the
 * native path in Replit Linux BEFORE touching Windows hardware. It mirrors the
 * full-rebuild seed lifecycle:
 *
 *   open file → connection pragmas → bulk-load pragmas → drop + createTablesOnly
 *   → bulk insert (no secondary indexes) → createIndexes (+ANALYZE)
 *   → read pragmas → mark seed complete → PRAGMA integrity_check
 *   → run every benchmark query → close + reopen + verify row counts survive.
 *
 * Scale defaults approximate the real vault (~2.85M records, ~130k txns,
 * ~13M participants). Override any dimension via env for a quick smoke run:
 *
 *   BENCH_RECORDS=20000 BENCH_TXNS=2000 BENCH_PPT=10 npx tsx scripts/engine-bench.ts
 *
 * Or use a preset:   BENCH_SCALE=small npx tsx scripts/engine-bench.ts
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEngineDb, type BetterSqlite3EngineDb } from '../client/src/lib/engine/better-sqlite3-adapter';
import {
  applyConnectionPragmas,
  applyBulkLoadPragmas,
  applyReadPragmas,
  createTablesOnly,
  createIndexes,
  dropMirrorTables,
  resetSeedMeta,
  generateSyntheticData,
  markSeedCompleteIfDone,
  isEngineReady,
  integrityCheck,
  countTable,
  countRecords,
  getRecordPage,
  countOwnedUtxos,
  getOwnedUtxos,
  getAddressAggregates,
  getParticipantsByAddresses,
  getParticipantsByTxids,
  getDbFileStats,
  MIRROR_TABLES,
  type SyntheticSpec,
} from '../client/src/lib/engine/engine-core';

// ---------------------------------------------------------------------------
// Scale configuration
// ---------------------------------------------------------------------------

const PRESETS: Record<string, SyntheticSpec> = {
  // ~2.85M records, ~130k txns, ~13M participants (≈100 participants/tx).
  real: { addresses: 2_850_000, transactions: 130_000, participantsPerTx: 100, spentFraction: 0.5, batchSize: 50_000 },
  // ~250k participants — fits comfortably under a single CLI timeout for validation.
  small: { addresses: 60_000, transactions: 2_500, participantsPerTx: 100, spentFraction: 0.5, batchSize: 25_000 },
};

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const preset = PRESETS[process.env.BENCH_SCALE ?? 'real'] ?? PRESETS.real;
const spec: SyntheticSpec = {
  addresses: num(process.env.BENCH_RECORDS, preset.addresses),
  transactions: num(process.env.BENCH_TXNS, preset.transactions),
  participantsPerTx: num(process.env.BENCH_PPT, preset.participantsPerTx ?? 100),
  spentFraction: preset.spentFraction,
  batchSize: num(process.env.BENCH_BATCH, preset.batchSize ?? 50_000),
};

const DB_PATH = process.env.BENCH_DB ?? join(tmpdir(), 'kyutxo-engine-bench.sqlite');

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

interface Phase {
  label: string;
  ms: number;
  detail?: string;
}
const phases: Phase[] = [];

// Stream every line immediately (stdout to a file is synchronous in Node, so a
// SIGKILL/OOM mid-run still leaves a complete trail of where we got to).
const log = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};
const stamp = (): string => new Date().toISOString().slice(11, 19);

function time<T>(label: string, fn: () => T, detail?: (r: T) => string): T {
  log(`[${stamp()}] ▶ ${label} ...`);
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  phases.push({ label, ms, detail: detail?.(r) });
  log(`[${stamp()}]   ✓ ${label.padEnd(40)} ${fmtMs(ms).padStart(10)}${detail ? '   ' + detail(r) : ''}`);
  return r;
}

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`);
const fmtBytes = (b: number): string => {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${b} B`;
};
const fileSize = (p: string): number => (existsSync(p) ? statSync(p).size : 0);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main(): void {
  log('=== KYUTXO native read-engine benchmark ===');
  log(`driver:  better-sqlite3 (native)`);
  log(`db file: ${DB_PATH}`);
  log(
    `scale:   records=${spec.addresses.toLocaleString()} txns=${spec.transactions.toLocaleString()} ` +
      `participants≈${(spec.transactions * (spec.participantsPerTx ?? 100)).toLocaleString()} ` +
      `(${spec.participantsPerTx}/tx)`,
  );
  log(`heap:    rss=${fmtBytes(process.memoryUsage().rss)} (node max-old-space=${process.env.NODE_OPTIONS ?? 'default'})`);
  log('');

  // Clean any prior file (full rebuild always starts from scratch).
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const f = `${DB_PATH}${suffix}`;
    if (existsSync(f)) rmSync(f);
  }

  let db: BetterSqlite3EngineDb = openEngineDb(DB_PATH);

  // EMPTY → connection + bulk-load pragmas.
  time('open + connection pragmas', () => {
    applyConnectionPragmas(db);
    applyBulkLoadPragmas(db);
  });

  // LOADING: drop, create tables-only (NO secondary indexes), reset progress.
  time('drop + createTablesOnly + resetSeedMeta', () => {
    dropMirrorTables(db);
    createTablesOnly(db);
    resetSeedMeta(db);
  });

  // Throttled progress so the long bulk-load phase streams a heartbeat (rows,
  // rate, RSS) — both for ETA visibility and to catch a runaway memory climb.
  const genStart = performance.now();
  let lastTick = 0;
  const onProgress = (p: { phase: string; done: number; total: number }): void => {
    const now = performance.now();
    if (now - lastTick < 3000 && p.done < p.total) return;
    lastTick = now;
    const elapsed = (now - genStart) / 1000;
    const rate = Math.round(p.done / Math.max(elapsed, 0.001));
    const pct = p.total > 0 ? ((100 * p.done) / p.total).toFixed(1) : '?';
    log(
      `[${stamp()}]     · ${p.phase.padEnd(13)} ${p.done.toLocaleString()}/${p.total.toLocaleString()} ` +
        `(${pct}%)  ${rate.toLocaleString()}/s  rss=${fmtBytes(process.memoryUsage().rss)}`,
    );
  };

  const counts = time(
    'bulk load (synthetic generate + insert)',
    () => generateSyntheticData(db, spec, onProgress),
    (c) => `${c.records.toLocaleString()} rec / ${c.transactions.toLocaleString()} tx / ${c.participants.toLocaleString()} part`,
  );

  // INDEXING: build secondary indexes + ANALYZE.
  time('createIndexes (+ANALYZE)', () => createIndexes(db));

  // Steady-state read durability.
  time('read pragmas', () => applyReadPragmas(db));

  // Mark seed complete (state machine → READY) once row counts are verified.
  time('mark seed complete', () => {
    for (const t of MIRROR_TABLES) markSeedCompleteIfDone(db, t, countTable(db, t));
  });
  const ready = isEngineReady(db);

  const integrity = time('PRAGMA integrity_check', () => integrityCheck(db));

  // ---- Benchmark queries (the worker's runQueryBenchmark + lookups) ----
  log(`[${stamp()}] ▶ benchmark queries ...`);
  const queries: Phase[] = [];
  const q = <T>(label: string, fn: () => T, rows: (r: T) => number): void => {
    const t0 = performance.now();
    const r = fn();
    const ms = performance.now() - t0;
    const detail = `${rows(r).toLocaleString()} rows`;
    queries.push({ label, ms, detail });
    log(`[${stamp()}]   · ${label.padEnd(40)} ${fmtMs(ms).padStart(10)}   ${detail}`);
  };

  q('countRecords (all tiers)', () => countRecords(db, { includeBlockchainDiscovered: true }), (n) => n);
  q('countRecords (owned only)', () => countRecords(db, { includeBlockchainDiscovered: false }), (n) => n);
  q('record page (first 100)', () => getRecordPage(db, { limit: 100, includeBlockchainDiscovered: true }), (a) => a.length);
  q('record page (deep keyset)', () => getRecordPage(db, { limit: 100, beforeId: Math.floor(spec.addresses / 2), includeBlockchainDiscovered: true }), (a) => a.length);
  q('record search "synth"', () => getRecordPage(db, { limit: 100, search: 'synth', includeBlockchainDiscovered: true }), (a) => a.length);
  q('record search "Owner7"', () => getRecordPage(db, { limit: 100, search: 'Owner7', includeBlockchainDiscovered: true }), (a) => a.length);
  q('count owned UTXOs (anti-join)', () => countOwnedUtxos(db), (n) => n);
  q('owned UTXO page (first 500)', () => getOwnedUtxos(db, { limit: 500 }), (a) => a.length);
  q('address aggregates (200 addrs)', () => {
    const addrs: string[] = [];
    for (let i = 1; i <= 200; i++) addrs.push(`bc1qsynth${i}`);
    return getAddressAggregates(db, addrs);
  }, (m) => m.size);
  q('participants by 50 addresses', () => {
    const addrs: string[] = [];
    for (let i = 1; i <= 50; i++) addrs.push(`bc1qsynth${i}`);
    return getParticipantsByAddresses(db, addrs);
  }, (a) => a.length);
  q('participants by 50 txids', () => {
    const txids: string[] = [];
    for (let i = 1; i <= 50; i++) txids.push(`tx${i}`);
    return getParticipantsByTxids(db, txids);
  }, (a) => a.length);

  const fileStats = getDbFileStats(db);
  const sizeOnDisk = fileSize(DB_PATH);

  // ---- Reopen check: prove data survives a fresh open ----
  const before = countTable(db, 'transactionParticipants');
  db.close();
  const reopen = time('close + reopen + verify', () => {
    const db2 = openEngineDb(DB_PATH, { readonly: true });
    const after = countTable(db2, 'transactionParticipants');
    const ready2 = isEngineReady(db2);
    db2.close();
    return { after, ready2 };
  }, (r) => `before=${before.toLocaleString()} after=${r.after.toLocaleString()} ready=${r.ready2}`);

  // ---- Report ----
  console.log('--- Lifecycle phases ---');
  for (const p of phases) console.log(`  ${p.label.padEnd(40)} ${fmtMs(p.ms).padStart(10)}${p.detail ? '   ' + p.detail : ''}`);
  console.log('');
  console.log('--- Query latencies ---');
  for (const p of queries) console.log(`  ${p.label.padEnd(40)} ${fmtMs(p.ms).padStart(10)}   ${p.detail}`);
  console.log('');
  console.log('--- Results ---');
  console.log(`  rows mirrored:     ${counts.records.toLocaleString()} rec / ${counts.transactions.toLocaleString()} tx / ${counts.participants.toLocaleString()} part`);
  console.log(`  engine ready:      ${ready}`);
  console.log(`  integrity_check:   ${integrity}`);
  console.log(`  reopen survived:   ${before === reopen.after ? 'YES' : 'NO'} (${before.toLocaleString()} == ${reopen.after.toLocaleString()})`);
  console.log(`  sqlite page count: ${fileStats.pageCount.toLocaleString()} @ ${fileStats.pageSize} B`);
  console.log(`  file size on disk: ${fmtBytes(sizeOnDisk)} (${sizeOnDisk.toLocaleString()} B)`);

  const totalMs = phases.reduce((a, p) => a + p.ms, 0);
  console.log('');
  console.log(`  TOTAL lifecycle:   ${fmtMs(totalMs)}`);

  const ok = integrity === 'ok' && ready && before === reopen.after;
  console.log('');
  console.log(ok ? 'BENCH OK' : 'BENCH FAILED');
  if (!ok) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  log('');
  log(`[${stamp()}] BENCH CRASHED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  log(`rss at crash: ${fmtBytes(process.memoryUsage().rss)}`);
  process.exitCode = 1;
}
