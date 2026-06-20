/**
 * Centralized engine read gate (Task #300).
 *
 * Every live screen that can read from the native engine must answer the same
 * question first: "is the engine ready AND is its mirror still an exact copy of
 * the live Dexie vault for the tables I'm about to read?" Before this module each
 * page duplicated that readiness + fingerprint compare, which risked the two
 * drifting apart. This is the single source of truth: same readiness probe, same
 * fingerprint fields, same "any doubt → Dexie" rule.
 *
 * The fingerprint is a cheap structural digest (count + maxId + a freshness
 * column) per table. A mismatch means the mirror is stale (a sync/import wrote
 * Dexie without re-seeding), so the caller must fall back to Dexie. ANY failure —
 * no engine (browser preview), not ready, fingerprint read error — returns
 * useEngine:false so a screen can never serve stale rows by accident.
 */
import {
  isEngineAvailable,
  getEngineStatus,
  engineGetRecordsFingerprint,
  engineGetTransactionsFingerprint,
  engineGetParticipantsFingerprint,
} from './engine-client';
import { getRecordsFingerprint } from '@/lib/data/record-crud';
import { getTransactionsFingerprint, getParticipantsFingerprint } from '@/lib/data/transaction-crud';

/**
 * Which mirror tables a read depends on:
 * - `records`     — Records list (the records table only).
 * - `allMirrors`  — owned-UTXO reads + the launch bootstrap freshness check; needs
 *                   records + blockchainTransactions + transactionParticipants all
 *                   current, since a sync/prevout backfill can change tx/participants
 *                   without touching records.
 */
export type EngineFreshnessScope = 'records' | 'allMirrors';

export type EngineGateReason =
  | 'ready-fresh'
  | 'unavailable'
  | 'not-ready'
  | 'stale'
  | 'error';

export interface EngineGateDecision {
  /** True only when the engine is ready and the mirror is an exact match. */
  useEngine: boolean;
  reason: EngineGateReason;
}

/**
 * Decide whether the caller may read from the engine for the given scope. Never
 * throws: callers treat a false result as "use Dexie". Keep your own version /
 * cancellation guards AFTER awaiting this, since it performs async IPC + IndexedDB
 * reads that can finish out of order with a superseded load.
 */
export async function evaluateEngineFreshness(
  scope: EngineFreshnessScope,
): Promise<EngineGateDecision> {
  if (!isEngineAvailable()) return { useEngine: false, reason: 'unavailable' };
  try {
    const snap = await getEngineStatus();
    if (!snap.ready) return { useEngine: false, reason: 'not-ready' };

    if (scope === 'records') {
      const [eng, dex] = await Promise.all([
        engineGetRecordsFingerprint(),
        getRecordsFingerprint(),
      ]);
      const fresh =
        eng.count === dex.count &&
        eng.maxId === dex.maxId &&
        eng.maxUpdatedAt === dex.maxUpdatedAt;
      return fresh
        ? { useEngine: true, reason: 'ready-fresh' }
        : { useEngine: false, reason: 'stale' };
    }

    // allMirrors: every mirror table must be proven fresh. Fetched in one batch
    // to match the single round trip the UTXOs page used before this module.
    const [
      engRec, dexRec,
      engTx, dexTx,
      engPart, dexPart,
    ] = await Promise.all([
      engineGetRecordsFingerprint(),
      getRecordsFingerprint(),
      engineGetTransactionsFingerprint(),
      getTransactionsFingerprint(),
      engineGetParticipantsFingerprint(),
      getParticipantsFingerprint(),
    ]);
    const fresh =
      engRec.count === dexRec.count &&
      engRec.maxId === dexRec.maxId &&
      engRec.maxUpdatedAt === dexRec.maxUpdatedAt &&
      engTx.count === dexTx.count &&
      engTx.maxId === dexTx.maxId &&
      engTx.maxBlockTime === dexTx.maxBlockTime &&
      engPart.count === dexPart.count &&
      engPart.maxId === dexPart.maxId &&
      engPart.resolvedPrevoutCount === dexPart.resolvedPrevoutCount;
    return fresh
      ? { useEngine: true, reason: 'ready-fresh' }
      : { useEngine: false, reason: 'stale' };
  } catch {
    return { useEngine: false, reason: 'error' };
  }
}
