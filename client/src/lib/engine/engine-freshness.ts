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
  engineGetSchemaVersion,
} from './engine-client';
import { ENGINE_SCHEMA_VERSION } from './engine-core';
import { getRecordsFingerprint } from '@/lib/data/record-crud';
import { getTransactionsFingerprint, getParticipantsFingerprint } from '@/lib/data/transaction-crud';

/**
 * Which mirror tables a read depends on:
 * - `records`      — Records list (the records table only).
 * - `transactions` — Transactions list: blockchainTransactions + transactionParticipants
 *                    ONLY. Deliberately ignores records so a records-table drift during a
 *                    sync/import never disables the tx list.
 * - `allMirrors`   — owned-UTXO reads + the launch bootstrap freshness check; needs
 *                    records + blockchainTransactions + transactionParticipants all
 *                    current, since a sync/prevout backfill can change tx/participants
 *                    without touching records.
 */
export type EngineFreshnessScope = 'records' | 'transactions' | 'allMirrors';

export type EngineGateReason =
  | 'ready-fresh'
  | 'unavailable'
  | 'not-ready'
  | 'schema-mismatch'
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

    // Schema-shape gate (ALL scopes): the fingerprints below compare row counts +
    // a freshness column but say NOTHING about the mirror's COLUMNS. A mirror
    // seeded by an older build reads back NULL for any newly-added column yet still
    // matches those fingerprints. Refuse the engine on a version mismatch so the
    // launch bootstrap reseeds with the current shape.
    if ((await engineGetSchemaVersion()) !== ENGINE_SCHEMA_VERSION) {
      return { useEngine: false, reason: 'schema-mismatch' };
    }

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

    if (scope === 'transactions') {
      // tx + participants only (NOT records). Same fields the allMirrors compare
      // uses for these two tables, so a records drift can't disable the tx list.
      const [engTx, dexTx, engPart, dexPart] = await Promise.all([
        engineGetTransactionsFingerprint(),
        getTransactionsFingerprint(),
        engineGetParticipantsFingerprint(),
        getParticipantsFingerprint(),
      ]);
      const fresh =
        engTx.count === dexTx.count &&
        engTx.maxId === dexTx.maxId &&
        engTx.maxBlockTime === dexTx.maxBlockTime &&
        engPart.count === dexPart.count &&
        engPart.maxId === dexPart.maxId &&
        engPart.resolvedPrevoutCount === dexPart.resolvedPrevoutCount;
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
