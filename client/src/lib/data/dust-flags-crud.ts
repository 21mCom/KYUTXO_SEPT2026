import { db, notifyDbChange, type DustFlag } from '../database';

// All writes to db.dustFlags go through this module (mirrors the other
// lightweight CRUD modules like sync-protection-crud).

export interface DustFlagInput {
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
}

export function toOutpoint(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

/**
 * Flag a set of outputs as dust. Outpoints that are already flagged are
 * skipped (the &outpoint unique index is the source of truth).
 * Returns the number of newly flagged outputs.
 */
export async function markOutpointsAsDust(entries: DustFlagInput[]): Promise<number> {
  if (entries.length === 0) return 0;

  const now = Date.now();
  // Deduplicate the input by outpoint first.
  const byOutpoint = new Map<string, DustFlag>();
  for (const e of entries) {
    const outpoint = toOutpoint(e.txid, e.vout);
    if (!byOutpoint.has(outpoint)) {
      byOutpoint.set(outpoint, {
        outpoint,
        txid: e.txid,
        vout: e.vout,
        address: e.address,
        amountSats: e.amountSats,
        markedAt: now,
      });
    }
  }

  const outpoints = Array.from(byOutpoint.keys());
  const existing = await db.dustFlags.where('outpoint').anyOf(outpoints).toArray();
  for (const row of existing) {
    byOutpoint.delete(row.outpoint);
  }

  const toAdd = Array.from(byOutpoint.values());
  if (toAdd.length > 0) {
    await db.dustFlags.bulkAdd(toAdd);
    notifyDbChange('dustFlags');
  }
  return toAdd.length;
}

/**
 * Remove dust flags for the given outpoints. Returns the number removed.
 */
export async function unmarkDustOutpoints(outpoints: string[]): Promise<number> {
  if (outpoints.length === 0) return 0;
  const removed = await db.dustFlags.where('outpoint').anyOf(outpoints).delete();
  if (removed > 0) {
    notifyDbChange('dustFlags');
  }
  return removed;
}

export async function getAllDustFlags(): Promise<DustFlag[]> {
  return db.dustFlags.toArray();
}

export interface DustFlagWriteOptions {
  skipNotification?: boolean;
}

export async function clearDustFlags(options?: DustFlagWriteOptions): Promise<void> {
  await db.dustFlags.clear();
  if (!options?.skipNotification) {
    notifyDbChange('dustFlags');
  }
}

export type DustFlagRestoreMode = 'merge' | 'replace';

/**
 * Restore dust-flag rows from a backup. SINGLE source of truth for the backup
 * restore path (v3 inline tables).
 *
 * The backup `id` is always stripped (every row gets a fresh autoincrement id).
 * Rows missing a usable `outpoint` are rebuilt from `txid`/`vout` when possible
 * and skipped otherwise (never write a row that would break the unique index).
 *
 * The `&outpoint` index is UNIQUE, so in MERGE mode rows whose outpoint already
 * exists are skipped (otherwise the first duplicate would abort the restore
 * mid-way); the skip-set is also extended as we go so an internally duplicated
 * backup can't collide with itself. In REPLACE mode the caller cleared the
 * table first, but the internal de-dup still applies for safety.
 *
 * Returns the number of rows actually written.
 */
export async function restoreDustFlagRows(
  rows: any[] | undefined,
  restoreMode: DustFlagRestoreMode,
  options?: DustFlagWriteOptions
): Promise<number> {
  if (!rows || rows.length === 0) return 0;

  const seen = new Set<string>();
  if (restoreMode === 'merge') {
    const existing = await db.dustFlags.toArray();
    for (const e of existing) seen.add(e.outpoint);
  }

  const toAdd: DustFlag[] = [];
  const now = Date.now();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const { id, ...d } = r;
    let outpoint: string | undefined =
      typeof d.outpoint === 'string' && d.outpoint.length > 0 ? d.outpoint : undefined;
    if (!outpoint && typeof d.txid === 'string' && typeof d.vout === 'number') {
      outpoint = toOutpoint(d.txid, d.vout);
    }
    if (!outpoint) continue;
    if (seen.has(outpoint)) continue;
    seen.add(outpoint);
    toAdd.push({
      outpoint,
      txid: typeof d.txid === 'string' ? d.txid : outpoint.split(':')[0],
      vout: typeof d.vout === 'number' ? d.vout : Number(outpoint.split(':')[1]) || 0,
      address: typeof d.address === 'string' ? d.address : '',
      amountSats: typeof d.amountSats === 'number' ? d.amountSats : 0,
      markedAt: typeof d.markedAt === 'number' ? d.markedAt : now,
    });
  }

  if (toAdd.length > 0) {
    await db.dustFlags.bulkAdd(toAdd);
    if (!options?.skipNotification) {
      notifyDbChange('dustFlags');
    }
  }
  return toAdd.length;
}

/**
 * The complete set of dust-flagged outpoints ("txid:vout") for fast lookups.
 */
export async function getDustFlaggedOutpointSet(): Promise<Set<string>> {
  const rows = await db.dustFlags.toArray();
  return new Set(rows.map((r) => r.outpoint));
}

/** Per-address totals of dust flags that are still unspent. */
export interface UnspentDustByAddress {
  /** address -> summed sats + flag count of its still-unspent dust outputs. */
  byAddress: Map<string, { sats: number; count: number }>;
}

/**
 * Sum the still-unspent dust-flagged outputs per address, so balance surfaces
 * can subtract them from cached per-address totals when "Hide dust" is on.
 *
 * A flag is treated as spent when ANY input participant references its
 * outpoint via the `[prevTxid+prevVout]` index (the same exact-mode rule the
 * UTXO computation uses); spent flags are excluded so a stale flag on an
 * already-spent output can never deflate a balance. Rows without a recorded
 * address are skipped — they can't be attributed to any per-address cached
 * balance. Pure local read.
 */
export async function getUnspentDustByAddress(): Promise<UnspentDustByAddress> {
  const rows = await db.dustFlags.toArray();
  const byAddress = new Map<string, { sats: number; count: number }>();
  for (const row of rows) {
    if (!row.address) continue;
    const spent = await db.transactionParticipants
      .where('[prevTxid+prevVout]')
      .equals([row.txid, row.vout])
      .count();
    if (spent > 0) continue;
    const agg = byAddress.get(row.address) ?? { sats: 0, count: 0 };
    agg.sats += row.amountSats;
    agg.count += 1;
    byAddress.set(row.address, agg);
  }
  return { byAddress };
}
