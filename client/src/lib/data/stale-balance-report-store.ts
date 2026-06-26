import Dexie, { type Table } from 'dexie';
import type { StaleAddressDetail } from './address-stats';

/**
 * Scratch persistence for the Balance Integrity "Check all addresses" report.
 *
 * A full-table scan on a very large vault can surface far more stale addresses
 * than we want to keep in a single in-memory array. Instead of accumulating the
 * whole set in the React tree, the check streams each batch into this dedicated,
 * local IndexedDB database (separate from the main vault DB) and the UI reads
 * only the visible window on demand. This keeps peak memory bounded regardless
 * of how many addresses are stale.
 *
 * This is purely derived, transient diagnostic data (it is recomputed from the
 * vault's own records on every run and cleared before each scan); it is NOT part
 * of the vault and never touches the guarded CRUD tables.
 */

interface StaleReportRow extends StaleAddressDetail {
  /** Auto-incrementing sequence: preserves scan order for windowed reads. */
  seq?: number;
}

class StaleReportDb extends Dexie {
  rows!: Table<StaleReportRow, number>;

  constructor() {
    super('kyutxo-stale-balance-report');
    this.version(1).stores({ rows: '++seq' });
  }
}

let instance: StaleReportDb | null = null;

function getStore(): StaleReportDb {
  if (!instance) instance = new StaleReportDb();
  return instance;
}

/** Remove every row from a previous run. Call before starting a new scan. */
export async function clearStaleReport(): Promise<void> {
  await getStore().rows.clear();
}

/** Append a streamed batch of stale addresses in scan order. */
export async function appendStaleReportRows(rows: StaleAddressDetail[]): Promise<void> {
  if (rows.length === 0) return;
  await getStore().rows.bulkAdd(rows.map(r => ({ ...r })));
}

/**
 * Read a contiguous window of stored stale rows, ordered by insertion (scan)
 * order. `offset` is a 0-based row index.
 */
export async function getStaleReportWindow(
  offset: number,
  limit: number
): Promise<StaleAddressDetail[]> {
  if (limit <= 0) return [];
  return getStore().rows.orderBy('seq').offset(offset).limit(limit).toArray();
}

/** Total number of stored stale rows. */
export async function countStaleReportRows(): Promise<number> {
  return getStore().rows.count();
}
