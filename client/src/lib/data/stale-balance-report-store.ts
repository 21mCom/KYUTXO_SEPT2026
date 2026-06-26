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

/** How many rows each export pass pulls back from IndexedDB at a time. */
const EXPORT_WINDOW_SIZE = 1000;

/** Escape a single CSV field per RFC 4180 (quote when it contains , " or newline). */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Stream the entire stored stale report out as a downloadable file without ever
 * holding the whole set in a single in-memory structure. Rows are read back from
 * IndexedDB one window at a time, each window is serialised to a string chunk,
 * and the chunks are handed to a Blob (which the browser backs with disk-spill
 * for large payloads). Fully offline — no network is touched.
 *
 * `format` selects CSV (one row per stale address) or JSON (a single array).
 * Returns the number of rows written.
 */
export async function exportStaleReport(
  format: 'csv' | 'json',
  onProgress?: (written: number, total: number) => void,
): Promise<{ blob: Blob; rowCount: number }> {
  const store = getStore();
  const total = await store.rows.count();
  const chunks: string[] = [];
  let written = 0;

  if (format === 'csv') {
    chunks.push('recordId,address,cachedSats,computedSats\n');
    for (let offset = 0; offset < total; offset += EXPORT_WINDOW_SIZE) {
      const rows = await store.rows
        .orderBy('seq')
        .offset(offset)
        .limit(EXPORT_WINDOW_SIZE)
        .toArray();
      if (rows.length === 0) break;
      let block = '';
      for (const r of rows) {
        block +=
          `${csvField(r.recordId)},${csvField(r.address)},` +
          `${csvField(r.cachedSats)},${csvField(r.computedSats)}\n`;
      }
      chunks.push(block);
      written += rows.length;
      onProgress?.(written, total);
    }
    return { blob: new Blob(chunks, { type: 'text/csv;charset=utf-8' }), rowCount: written };
  }

  // JSON: emit a streamed array so we never build one giant string up front.
  chunks.push('[');
  for (let offset = 0; offset < total; offset += EXPORT_WINDOW_SIZE) {
    const rows = await store.rows
      .orderBy('seq')
      .offset(offset)
      .limit(EXPORT_WINDOW_SIZE)
      .toArray();
    if (rows.length === 0) break;
    let block = '';
    for (const r of rows) {
      const entry = JSON.stringify({
        recordId: r.recordId,
        address: r.address,
        cachedSats: r.cachedSats,
        computedSats: r.computedSats,
      });
      block += written === 0 && block === '' ? entry : `,${entry}`;
      written += 1;
    }
    chunks.push(block);
    onProgress?.(written, total);
  }
  chunks.push(']');
  return { blob: new Blob(chunks, { type: 'application/json;charset=utf-8' }), rowCount: written };
}
