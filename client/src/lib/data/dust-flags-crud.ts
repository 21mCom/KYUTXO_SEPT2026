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

/**
 * The complete set of dust-flagged outpoints ("txid:vout") for fast lookups.
 */
export async function getDustFlaggedOutpointSet(): Promise<Set<string>> {
  const rows = await db.dustFlags.toArray();
  return new Set(rows.map((r) => r.outpoint));
}
