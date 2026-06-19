/**
 * Plain-Node self-test for the native engine worker.
 *
 * Invoked via `node electron/engine/engine-worker.bundle.cjs --self-test`. It
 * spawns the SAME bundle as a real worker_thread and drives the full request/
 * response protocol with a tiny hand-built dataset — proving the seed state
 * machine, query dispatch, integrity check, and reopen all work end-to-end
 * WITHOUT Electron or a renderer. This is the T004 acceptance gate.
 */
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  EngineRequest,
  EngineResponse,
  EngineSnapshot,
  BenchmarkRow,
} from './engine-node-worker';
import type { RecordRow, TransactionRow, ParticipantRow } from '../lib/engine/engine-core';

// ---- Row fixtures (mirror the unit-test helpers) --------------------------

function rec(over: Partial<RecordRow> & { id: number }): RecordRow {
  const inputString = over.inputString ?? `bc1qsynth${over.id}`;
  return {
    id: over.id,
    type: over.type ?? 'address',
    inputString,
    inputStringLower: (over.inputStringLower ?? inputString).toLowerCase(),
    label: over.label ?? null,
    notes: null,
    owner: over.owner ?? null,
    walletName: null,
    seedName: null,
    walletSoftware: null,
    addressImportance: over.addressImportance ?? 'manual',
    chainType: null,
    syncDepth: null,
    firstSeenBlockTime: null,
    cachedBalanceSats: null,
    cachedTxCount: null,
    cachedUtxoCount: null,
    statsComputedAt: null,
    createdAt: over.id,
    updatedAt: over.id,
    tags: '[]',
    categories: '[]',
  };
}
function tx(id: number, txid: string): TransactionRow {
  return { id, txid, blockHeight: 700000 + id, blockTime: 1600000000 + id * 60, fee: 100, feeRate: 1, vsize: 200, hasOpReturn: 0 };
}
let pid = 1;
function out(txid: string, address: string, vout: number, amount: number): ParticipantRow {
  return { id: pid++, txid, role: 'output', address, amount, vout, prevTxid: null, prevVout: null, recordId: null, scriptType: 'v0_p2wpkh' };
}
function inp(txid: string, address: string, amount: number, prevTxid: string, prevVout: number): ParticipantRow {
  return { id: pid++, txid, role: 'input', address, amount, vout: null, prevTxid, prevVout, recordId: null, scriptType: 'v0_p2wpkh' };
}

// ---- Assertion helpers ----------------------------------------------------

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

export async function runSelfTest(workerPath = process.argv[1]): Promise<void> {
  console.log('=== engine-node-worker self-test (worker_threads) ===');
  const dir = mkdtempSync(join(tmpdir(), 'kyutxo-engine-selftest-'));
  const dbPath = join(dir, 'engine.sqlite');
  const worker = new Worker(workerPath, { workerData: { dbPath } });

  let nextId = 1;
  const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  worker.on('message', (res: EngineResponse) => {
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  });
  worker.on('error', (err) => {
    console.error('  worker crashed:', err);
    failures++;
  });

  // Distributive omit so each union member keeps its own shape (a plain
  // Omit<union,'id'> trips the excess-property check on discriminated unions).
  type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;
  const send = <T = unknown>(req: Unsent<EngineRequest>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      worker.postMessage({ ...req, id } as EngineRequest);
    });

  try {
    // 1) init → fresh DB is EMPTY.
    const init = await send<EngineSnapshot>({ type: 'init' });
    check('init returns EMPTY on a fresh db', init.state === 'EMPTY', init.state);
    check('init reports not ready', init.ready === false);

    // 2) seed lifecycle.
    const begin = await send<EngineSnapshot>({ type: 'seedBegin' });
    check('seedBegin → LOADING', begin.state === 'LOADING', begin.state);

    const records: RecordRow[] = [
      rec({ id: 1, owner: 'Alice' }),
      rec({ id: 2, owner: 'Bob' }),
      rec({ id: 3, owner: 'Alice', label: 'cold storage' }),
    ];
    const txns: TransactionRow[] = [tx(1, 'txA'), tx(2, 'txB')];
    // txA funds bc1qsynth1 (vout0) + bc1qsynth2 (vout1). txB spends txA:0.
    const parts: ParticipantRow[] = [
      out('txA', 'bc1qsynth1', 0, 100000),
      out('txA', 'bc1qsynth2', 1, 50000),
      out('txB', 'bc1qsynth3', 0, 90000),
      inp('txB', 'bc1qsynth1', 100000, 'txA', 0),
    ];

    const r1 = await send<{ copied: number }>({ type: 'seedBatch', table: 'records', rows: records });
    check('seedBatch records copied=3', r1.copied === 3, String(r1.copied));
    await send({ type: 'seedBatch', table: 'blockchainTransactions', rows: txns });
    await send({ type: 'seedBatch', table: 'transactionParticipants', rows: parts });

    const finish = await send<EngineSnapshot>({
      type: 'seedFinish',
      sourceCounts: { records: 3, blockchainTransactions: 2, transactionParticipants: 4 },
    });
    check('seedFinish → READY', finish.state === 'READY', finish.state);
    check('seedFinish reports ready', finish.ready === true);
    check('counts mirrored', finish.counts.records === 3 && finish.counts.transactionParticipants === 4,
      JSON.stringify(finish.counts));

    // 3) integrity.
    const integrity = await send<string>({ type: 'integrityCheck' });
    check('integrity_check ok', integrity === 'ok', integrity);

    // 4) queries.
    const page = await send<RecordRow[]>({ type: 'query', name: 'getRecordPage', args: { limit: 10, includeBlockchainDiscovered: true } });
    check('getRecordPage returns 3', page.length === 3, String(page.length));
    const total = await send<number>({ type: 'query', name: 'countRecords', args: { includeBlockchainDiscovered: true } });
    check('countRecords = 3', total === 3, String(total));
    // Owned UTXOs: txA:0 spent by txB → unspent outputs are txA:1 (bc1qsynth2) and txB:0 (bc1qsynth3) = 2.
    const utxoCount = await send<number>({ type: 'query', name: 'countOwnedUtxos', args: undefined });
    check('countOwnedUtxos = 2 (anti-join)', utxoCount === 2, String(utxoCount));

    // 5) benchmark sanity.
    const bench = await send<BenchmarkRow[]>({ type: 'benchmark' });
    check('benchmark returns rows', bench.length > 0, `${bench.length} measurements`);

    // 6) reopen survives.
    const reopen = await send<{ before: number; after: number; ready: boolean }>({ type: 'reopen' });
    check('reopen row counts survive', reopen.before === reopen.after && reopen.after === 4,
      `${reopen.before} == ${reopen.after}`);
    check('reopen ready', reopen.ready === true);

    // 7) clear → EMPTY.
    const cleared = await send<EngineSnapshot>({ type: 'clear' });
    check('clear → EMPTY', cleared.state === 'EMPTY', cleared.state);
    check('clear empties tables', cleared.counts.records === 0 && cleared.counts.transactionParticipants === 0);
  } catch (err) {
    failures++;
    console.error('  self-test threw:', err);
  } finally {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('');
  if (failures === 0) {
    console.log('SELF-TEST OK');
  } else {
    console.error(`SELF-TEST FAILED (${failures} failure${failures === 1 ? '' : 's'})`);
    process.exitCode = 1;
  }
}
