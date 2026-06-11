/**
 * Participant repository (Task #229).
 *
 * Single switch point between the existing Dexie/IndexedDB data path and the
 * SQLite-WASM prototype. When the SQLite backend is active, both backends are
 * run for the same operation and a side-by-side benchmark (query time + row
 * count) is logged to the console. The SQLite result is returned.
 *
 * Pages should import these functions instead of the raw dataFacade ones so the
 * feature flag can route transparently.
 */
import {
  getParticipantsByTxids as dexieGetParticipantsByTxids,
  getParticipantsByAddresses as dexieGetParticipantsByAddresses,
} from './dataFacade';
import {
  getActiveBackend,
  sqliteGetParticipantsByTxids,
  sqliteGetParticipantsByAddresses,
} from './sqlite-client';
import type { TransactionParticipant } from './database';

function logBenchmark(
  op: string,
  inputSize: number,
  dexieMs: number,
  dexieRows: number,
  sqliteMs: number,
  sqliteRows: number
): void {
  const faster = sqliteMs < dexieMs ? 'SQLite' : 'Dexie';
  const ratio = sqliteMs > 0 ? (dexieMs / sqliteMs).toFixed(2) : '∞';
  const rowMismatch = dexieRows !== sqliteRows ? '  ⚠ ROW COUNT MISMATCH' : '';
  console.log(
    `[bench] ${op}(n=${inputSize})  Dexie ${dexieMs.toFixed(1)}ms (${dexieRows} rows)  |  ` +
      `SQLite ${sqliteMs.toFixed(1)}ms (${sqliteRows} rows)  →  ${faster} faster (${ratio}x)${rowMismatch}`
  );
}

export async function getParticipantsByTxids(
  txids: string[]
): Promise<TransactionParticipant[]> {
  if (getActiveBackend() !== 'sqlite') {
    return dexieGetParticipantsByTxids(txids);
  }

  const d0 = performance.now();
  const dexieRes = await dexieGetParticipantsByTxids(txids);
  const d1 = performance.now();

  const s0 = performance.now();
  const sqliteRes = await sqliteGetParticipantsByTxids(txids);
  const s1 = performance.now();

  logBenchmark('getParticipantsByTxids', txids.length, d1 - d0, dexieRes.length, s1 - s0, sqliteRes.length);
  return sqliteRes;
}

export async function getParticipantsByAddresses(
  addresses: string[],
  signal?: AbortSignal
): Promise<TransactionParticipant[]> {
  if (getActiveBackend() !== 'sqlite') {
    return dexieGetParticipantsByAddresses(addresses, signal);
  }

  const d0 = performance.now();
  const dexieRes = await dexieGetParticipantsByAddresses(addresses, signal);
  const d1 = performance.now();

  const s0 = performance.now();
  const sqliteRes = await sqliteGetParticipantsByAddresses(addresses);
  const s1 = performance.now();

  logBenchmark('getParticipantsByAddresses', addresses.length, d1 - d0, dexieRes.length, s1 - s0, sqliteRes.length);
  return sqliteRes;
}
