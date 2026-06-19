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
  buildOwnedUtxos,
  buildHeuristicOwnedUtxos,
  heuristicOwnedUtxosReady,
  countHeuristicOwnedUtxos,
  getHeuristicOwnedUtxos,
  dropMirrorTables,
  resetSeedMeta,
  generateSyntheticData,
  insertRecords,
  insertTransactions,
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
  getRecordsFingerprint,
  getTransactionsFingerprint,
  getParticipantsFingerprint,
  getDbFileStats,
  MIRROR_TABLES,
  type SyntheticSpec,
  type OwnedUtxo,
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

  // ---- Heuristic owned-UTXO LIVE baseline (full window-function pass) ----
  // Measure the heuristic count + first page BEFORE materializing, so the fast
  // path is NOT yet ready and these run the full window-function computation.
  // This is the read the page used to do on every load; it doubles as the parity
  // reference for the materialized fast path below.
  if (heuristicOwnedUtxosReady(db)) throw new Error('heuristic table unexpectedly ready before build');
  const HEUR_PAGE = 500;
  const liveHeurCount = time(
    'LIVE heuristic count (window fn)',
    () => countHeuristicOwnedUtxos(db),
    (n) => `${n.toLocaleString()} heuristic utxos`,
  );
  const liveHeurFirstMs0 = performance.now();
  const liveHeurFirstPage = getHeuristicOwnedUtxos(db, { limit: HEUR_PAGE });
  const liveHeurFirstMs = performance.now() - liveHeurFirstMs0;
  phases.push({ label: 'LIVE heuristic first page (window fn)', ms: liveHeurFirstMs, detail: `${liveHeurFirstPage.length} rows` });
  log(`[${stamp()}]   ✓ ${'LIVE heuristic first page (window fn)'.padEnd(40)} ${fmtMs(liveHeurFirstMs).padStart(10)}   ${liveHeurFirstPage.length} rows`);

  // Materialize the owned-UTXO set once (the expensive anti-join happens here so
  // countOwnedUtxos / first-page reads are sub-second below).
  time('buildOwnedUtxos (materialize)', () => buildOwnedUtxos(db), (n) => `${n.toLocaleString()} owned utxos`);

  // Same for the heuristic (no-prevout) owned-UTXO set: the worker builds this at
  // seed-finish / synthetic-generate time so its count + first page become a
  // cached scalar + b-tree keyset walk instead of the window-function pass above.
  const builtHeur = time(
    'buildHeuristicOwnedUtxos (materialize)',
    () => buildHeuristicOwnedUtxos(db),
    (n) => `${n.toLocaleString()} heuristic utxos`,
  );

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

  // ---- Heuristic owned-UTXO FAST path (materialized table) + parity ----
  // After buildHeuristicOwnedUtxos the fast path is ready: count is a cached
  // scalar and the first page is a primary-key keyset walk. Assert they agree
  // with the live window-function baseline byte-for-byte (same count, and the
  // first page identical row-for-row: id/txid/vout/amount and order).
  if (!heuristicOwnedUtxosReady(db)) throw new Error('heuristic table not ready after build');
  let fastHeurCount = 0;
  q('FAST heuristic count (materialized)', () => {
    fastHeurCount = countHeuristicOwnedUtxos(db);
    return fastHeurCount;
  }, () => fastHeurCount);
  let fastHeurFirstPage: OwnedUtxo[] = [];
  q('FAST heuristic first page (materialized)', () => {
    fastHeurFirstPage = getHeuristicOwnedUtxos(db, { limit: HEUR_PAGE });
    return fastHeurFirstPage;
  }, (a) => a.length);

  const rowKey = (u: OwnedUtxo): string => `${u.id}|${u.txid}|${u.vout ?? 'null'}|${u.amount}`;
  const countParity = liveHeurCount === fastHeurCount && fastHeurCount === builtHeur;
  const firstPageParity =
    liveHeurFirstPage.length === fastHeurFirstPage.length &&
    liveHeurFirstPage.every((u, i) => rowKey(u) === rowKey(fastHeurFirstPage[i]));

  // Deep-page parity: a keyset page from the MIDDLE of the set (fast path b-tree)
  // vs the same window on the live path. The live path re-runs the full window
  // function ONCE here (afterId + LIMIT is applied after the CTE), so this is a
  // single extra pass, not per-batch. Proves paging agreement past the first page.
  const deepAfterId = fastHeurFirstPage.length > 0 ? fastHeurFirstPage[Math.floor(fastHeurFirstPage.length / 2)].id : undefined;
  let deepPageParity = true;
  if (deepAfterId != null) {
    const fastDeep = getHeuristicOwnedUtxos(db, { afterId: deepAfterId, limit: HEUR_PAGE });
    db.exec('DROP TABLE IF EXISTS heuristicOwnedUtxos;');
    const liveDeep = getHeuristicOwnedUtxos(db, { afterId: deepAfterId, limit: HEUR_PAGE });
    buildHeuristicOwnedUtxos(db);
    deepPageParity =
      fastDeep.length === liveDeep.length && fastDeep.every((u, i) => rowKey(u) === rowKey(liveDeep[i]));
  }

  // Full-set parity: cross-check EVERY row, not just sample pages. The fast side
  // is a cheap b-tree keyset walk; the live side is a SINGLE window-function pass
  // (one call, large LIMIT) so we never re-run the window function per batch. The
  // live materialization holds the whole set in JS, so it is bounded by FULLSET_CAP
  // (override via BENCH_FULLSET_CAP) to stay memory-safe at the very largest scale.
  const FULLSET_CAP = num(process.env.BENCH_FULLSET_CAP, 4_000_000);
  let fastFullCount = 0;
  let liveFullCount = 0;
  let fullSetParity = true;
  let fullSetChecked = false;
  if (fastHeurCount <= FULLSET_CAP) {
    fullSetChecked = true;
    const fast = new Set<string>();
    q('FAST heuristic full keyset walk', () => {
      let afterId: number | undefined;
      while (true) {
        const batch = getHeuristicOwnedUtxos(db, { afterId, limit: 50_000 });
        for (const u of batch) fast.add(rowKey(u));
        if (batch.length < 50_000) break;
        afterId = batch[batch.length - 1].id;
      }
      fastFullCount = fast.size;
      return fast;
    }, (s) => s.size);

    db.exec('DROP TABLE IF EXISTS heuristicOwnedUtxos;');
    const liveT0 = performance.now();
    const liveAll = getHeuristicOwnedUtxos(db, { limit: fastHeurCount + 1 });
    phases.push({ label: 'LIVE heuristic full set (window fn, 1 pass)', ms: performance.now() - liveT0, detail: `${liveAll.length} rows` });
    log(`[${stamp()}]   · ${'LIVE heuristic full set (window fn)'.padEnd(40)} ${fmtMs(performance.now() - liveT0).padStart(10)}   ${liveAll.length} rows`);
    liveFullCount = liveAll.length;
    fullSetParity = liveAll.length === fast.size && liveAll.every((u) => fast.has(rowKey(u)));
    buildHeuristicOwnedUtxos(db);
  } else {
    log(`[${stamp()}]   · full-set parity SKIPPED (${fastHeurCount.toLocaleString()} > cap ${FULLSET_CAP.toLocaleString()}); relying on count + first-page + deep-page parity`);
  }
  if (!heuristicOwnedUtxosReady(db)) throw new Error('heuristic table not ready after full-set parity check');
  const heuristicParity = countParity && firstPageParity && deepPageParity && fullSetParity;

  // ---- Freshness gate: prove a stale mirror is DETECTED (→ Dexie fallback) ----
  // The UTXOs page only trusts the engine when the records/transactions/
  // participants fingerprints match the live Dexie source. Mutate each table the
  // way live writes do and confirm every fingerprint moves — so a stale mirror
  // never silently serves wrong UTXOs.
  const recFp0 = getRecordsFingerprint(db);
  const txFp0 = getTransactionsFingerprint(db);
  const partFp0 = getParticipantsFingerprint(db);

  // (a) create a record → count + maxId + maxUpdatedAt all move.
  const newRecId = recFp0.maxId + 1;
  insertRecords(db, [{
    id: newRecId, type: 'address', inputString: `bc1qfresh${newRecId}`,
    inputStringLower: `bc1qfresh${newRecId}`, label: 'freshness probe', notes: null,
    owner: null, walletName: null, seedName: null, walletSoftware: null,
    addressImportance: 'manual', chainType: null, syncDepth: 0, firstSeenBlockTime: null,
    cachedBalanceSats: null, cachedTxCount: null, cachedUtxoCount: null, statsComputedAt: null,
    createdAt: newRecId, updatedAt: recFp0.maxUpdatedAt + 1000, tags: '[]', categories: '[]',
  }]);
  // (b) confirm a transaction → count + maxId + maxBlockTime all move.
  const newTxId = txFp0.maxId + 1;
  insertTransactions(db, [{
    id: newTxId, txid: `txfresh${newTxId}`, blockHeight: 800000,
    blockTime: txFp0.maxBlockTime + 600, fee: 1000, feeRate: 10, vsize: 200, hasOpReturn: 0,
  }]);
  // (c) resolve a prevout IN PLACE on an existing input (no insert/delete) →
  //     only resolvedPrevoutCount moves. This is the subtle drift count+maxId miss.
  db.run(
    `UPDATE transactionParticipants SET prevTxid = 'txfresh-probe', prevVout = 0
       WHERE id = (SELECT id FROM transactionParticipants
                    WHERE role = 'input' AND prevTxid IS NULL LIMIT 1)`,
  );

  const recFp1 = getRecordsFingerprint(db);
  const txFp1 = getTransactionsFingerprint(db);
  const partFp1 = getParticipantsFingerprint(db);
  const recDrift = recFp1.count === recFp0.count + 1 && recFp1.maxId > recFp0.maxId && recFp1.maxUpdatedAt > recFp0.maxUpdatedAt;
  const txDrift = txFp1.count === txFp0.count + 1 && txFp1.maxId > txFp0.maxId && txFp1.maxBlockTime > txFp0.maxBlockTime;
  const partInPlaceDrift =
    partFp1.resolvedPrevoutCount === partFp0.resolvedPrevoutCount + 1 &&
    partFp1.count === partFp0.count && partFp1.maxId === partFp0.maxId;
  const freshnessGateOk = recDrift && txDrift && partInPlaceDrift;
  log(`[${stamp()}]   · ${'freshness gate (stale-mirror detect)'.padEnd(40)} ${freshnessGateOk ? 'DETECTED' : 'MISSED'}`);

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

  console.log('');
  console.log('--- Heuristic owned-UTXO fast view (Task: verify fast UTXO view) ---');
  console.log(`  materialized rows:   ${builtHeur.toLocaleString()}`);
  console.log(`  count parity:        ${countParity ? 'OK' : 'FAIL'} (live=${liveHeurCount.toLocaleString()} fast=${fastHeurCount.toLocaleString()} built=${builtHeur.toLocaleString()})`);
  console.log(`  first-page parity:   ${firstPageParity ? 'OK' : 'FAIL'} (${liveHeurFirstPage.length} rows, row-for-row id/txid/vout/amount)`);
  console.log(`  deep-page parity:    ${deepPageParity ? 'OK' : 'FAIL'} (mid-set keyset page, row-for-row)`);
  console.log(`  full-set parity:     ${fullSetChecked ? (fullSetParity ? 'OK' : 'FAIL') + ` (live=${liveFullCount.toLocaleString()} fast=${fastFullCount.toLocaleString()} distinct outpoints)` : `SKIPPED (count ${fastHeurCount.toLocaleString()} > cap ${FULLSET_CAP.toLocaleString()})`}`);
  const liveReadMs = liveHeurCount >= 0 ? (phases.find((p) => p.label === 'LIVE heuristic count (window fn)')?.ms ?? 0) + liveHeurFirstMs : 0;
  const fastReadMs =
    (queries.find((p) => p.label === 'FAST heuristic count (materialized)')?.ms ?? 0) +
    (queries.find((p) => p.label === 'FAST heuristic first page (materialized)')?.ms ?? 0);
  const speedup = fastReadMs > 0 ? liveReadMs / fastReadMs : 0;
  console.log(`  perf win:            live (count+page) ${fmtMs(liveReadMs)}  →  fast ${fmtMs(fastReadMs)}  (${speedup.toFixed(1)}x faster)`);
  console.log(`  freshness gate:      ${freshnessGateOk ? 'OK' : 'FAIL'} (stale mirror detected → Dexie fallback)`);
  console.log(`    record drift:      ${recDrift ? 'detected' : 'MISSED'} (count/maxId/maxUpdatedAt)`);
  console.log(`    transaction drift: ${txDrift ? 'detected' : 'MISSED'} (count/maxId/maxBlockTime)`);
  console.log(`    in-place prevout:  ${partInPlaceDrift ? 'detected' : 'MISSED'} (resolvedPrevoutCount only)`);

  const totalMs = phases.reduce((a, p) => a + p.ms, 0);
  console.log('');
  console.log(`  TOTAL lifecycle:   ${fmtMs(totalMs)}`);

  const heuristicOk = heuristicParity && fullSetParity && freshnessGateOk;
  const ok = integrity === 'ok' && ready && before === reopen.after && heuristicOk;
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
