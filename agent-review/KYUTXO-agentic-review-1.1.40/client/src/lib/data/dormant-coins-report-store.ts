import Dexie, { type Table } from 'dexie';
import { csvField } from '../csv-export';
import {
  DORMANT_CLUE_LABELS,
  formatAgeYears,
  type DormantClueGroup,
  type DormantOutputRow,
  type DormantScanParams,
  type DormantScanSummary,
} from '../dormant-coins';

/**
 * Scratch persistence for the Dormant Coins report.
 *
 * A full-history scan on a very large vault can surface far more dormant
 * outputs than we want to keep in a single in-memory array. The scan streams
 * each batch into this dedicated, local IndexedDB database (separate from the
 * main vault DB) and the UI reads only the visible window on demand, keeping
 * peak memory bounded regardless of result size.
 *
 * Unlike the stale-balance scratch store, results here PERSIST across reloads
 * (a full scan is expensive, so the last report survives navigation); the
 * store is only cleared when a new run starts. A `meta` row tracks run state
 * so a reload mid-scan can show an interrupted-run notice instead of silently
 * presenting partial results as complete.
 *
 * This is purely derived, transient diagnostic data (recomputed from the
 * vault's own records on every run); it is NOT part of the vault and never
 * touches the guarded CRUD tables.
 */

export interface DormantRunMeta {
  id: string; // always 'run' — singleton
  status: 'running' | 'complete';
  startedAt: number;
  finishedAt?: number;
  params: DormantScanParams;
  summary?: DormantScanSummary;
}

interface DormantRow extends DormantOutputRow {
  /** Auto-incrementing sequence: preserves ranked scan order for windowed reads. */
  seq?: number;
}

interface DormantGroupRow extends DormantClueGroup {
  seq?: number;
}

class DormantReportDb extends Dexie {
  rows!: Table<DormantRow, number>;
  groups!: Table<DormantGroupRow, number>;
  meta!: Table<DormantRunMeta, string>;

  constructor() {
    super('kyutxo-dormant-coins-report');
    this.version(1).stores({ rows: '++seq', groups: '++seq', meta: 'id' });
  }
}

let instance: DormantReportDb | null = null;

function getStore(): DormantReportDb {
  if (!instance) instance = new DormantReportDb();
  return instance;
}

/** Remove every row/group/meta from a previous run. Call before starting a new scan. */
export async function clearDormantReport(): Promise<void> {
  const store = getStore();
  await Promise.all([store.rows.clear(), store.groups.clear(), store.meta.clear()]);
}

/** Mark a new run as in-flight so a reload mid-scan shows an interrupted notice. */
export async function beginDormantRun(params: DormantScanParams): Promise<void> {
  await getStore().meta.put({ id: 'run', status: 'running', startedAt: Date.now(), params });
}

/** Mark the run complete and store its summary alongside the results. */
export async function completeDormantRun(summary: DormantScanSummary): Promise<void> {
  const store = getStore();
  const existing = await store.meta.get('run');
  if (!existing) return;
  await store.meta.put({ ...existing, status: 'complete', finishedAt: Date.now(), summary });
}

/** Read the run state (for reload-time interrupted/complete restore). */
export async function getDormantRunMeta(): Promise<DormantRunMeta | undefined> {
  return getStore().meta.get('run');
}

/** Append a streamed batch of ranked dormant-output rows. */
export async function appendDormantRows(rows: DormantOutputRow[]): Promise<void> {
  if (rows.length === 0) return;
  await getStore().rows.bulkAdd(rows.map((r) => ({ ...r })));
}

/** Append the ranked co-spend clue groups. */
export async function appendDormantGroups(groups: DormantClueGroup[]): Promise<void> {
  if (groups.length === 0) return;
  await getStore().groups.bulkAdd(groups.map((g) => ({ ...g })));
}

/** Read a contiguous window of result rows in ranked order (0-based offset). */
export async function getDormantRowWindow(
  offset: number,
  limit: number,
): Promise<DormantOutputRow[]> {
  if (limit <= 0) return [];
  return getStore().rows.orderBy('seq').offset(offset).limit(limit).toArray();
}

export async function countDormantRows(): Promise<number> {
  return getStore().rows.count();
}

/** Read a contiguous window of clue groups in ranked order (0-based offset). */
export async function getDormantGroupWindow(
  offset: number,
  limit: number,
): Promise<DormantClueGroup[]> {
  if (limit <= 0) return [];
  return getStore().groups.orderBy('seq').offset(offset).limit(limit).toArray();
}

export async function countDormantGroups(): Promise<number> {
  return getStore().groups.count();
}

// ---------------------------------------------------------------------------
// Chunked export
// ---------------------------------------------------------------------------

/** How many rows each export pass pulls back from IndexedDB at a time. */
const EXPORT_WINDOW_SIZE = 1000;

export const DORMANT_CSV_HEADER = [
  'Address',
  'Clue',
  'Ownership',
  'Amount Sats',
  'Created',
  'Block',
  'Age Years',
  'Last Meaningful Activity',
  'Txid',
  'Vout',
  'Record Id',
  'Co-spend Group',
] as const;

function rowToCsv(r: DormantOutputRow, nowSec: number): string {
  const created = r.blockTime > 0 ? new Date(r.blockTime * 1000).toISOString() : '';
  const lastActive = r.lastActivity > 0 ? new Date(r.lastActivity * 1000).toISOString() : '';
  return [
    csvField(r.address),
    csvField(DORMANT_CLUE_LABELS[r.clueType]),
    csvField(r.owned ? 'owned' : 'unknown'),
    // Amounts and numeric cells are serialized from numbers, not user text,
    // so they are escaped but not apostrophe-prefixed (would corrupt them).
    csvField(String(r.amountSats)),
    csvField(created),
    csvField(String(r.blockHeight)),
    csvField(r.blockTime > 0 ? formatAgeYears(r.blockTime, nowSec) : ''),
    csvField(lastActive),
    csvField(r.txid),
    csvField(String(r.vout)),
    csvField(r.recordId != null ? String(r.recordId) : ''),
    csvField(r.groupId != null ? String(r.groupId) : ''),
  ].join(',');
}

/**
 * Stream the entire stored report out as a downloadable file without ever
 * holding the whole set in a single in-memory structure: rows are read back
 * window-by-window, each window serialised to a string chunk, and the chunks
 * handed to a Blob. Fully offline — no network is touched.
 *
 * CSV contains one row per dormant output (clue groups are summarised in the
 * JSON export). JSON is a single object with the run summary, params, groups,
 * and the full rows array.
 */
export async function exportDormantReport(
  format: 'csv' | 'json',
  onProgress?: (written: number, total: number) => void,
): Promise<{ blob: Blob; rowCount: number }> {
  const store = getStore();
  const total = await store.rows.count();
  const nowSec = Math.floor(Date.now() / 1000);
  const chunks: string[] = [];
  let written = 0;

  if (format === 'csv') {
    chunks.push(DORMANT_CSV_HEADER.join(',') + '\r\n');
    for (let offset = 0; offset < total; offset += EXPORT_WINDOW_SIZE) {
      const rows = await store.rows
        .orderBy('seq')
        .offset(offset)
        .limit(EXPORT_WINDOW_SIZE)
        .toArray();
      if (rows.length === 0) break;
      let block = '';
      for (const r of rows) block += rowToCsv(r, nowSec) + '\r\n';
      chunks.push(block);
      written += rows.length;
      onProgress?.(written, total);
    }
    return { blob: new Blob(chunks, { type: 'text/csv;charset=utf-8' }), rowCount: written };
  }

  const meta = await store.meta.get('run');
  const groups = await store.groups.orderBy('seq').toArray();
  chunks.push(
    `{"summary":${JSON.stringify(meta?.summary ?? null)},"params":${JSON.stringify(
      meta?.params ?? null,
    )},"groups":${JSON.stringify(groups)},"rows":[`,
  );
  for (let offset = 0; offset < total; offset += EXPORT_WINDOW_SIZE) {
    const rows = await store.rows
      .orderBy('seq')
      .offset(offset)
      .limit(EXPORT_WINDOW_SIZE)
      .toArray();
    if (rows.length === 0) break;
    let block = '';
    for (const r of rows) {
      const { seq: _seq, ...entry } = r;
      block += written === 0 && block === '' ? JSON.stringify(entry) : `,${JSON.stringify(entry)}`;
      written += 1;
    }
    chunks.push(block);
    onProgress?.(written, total);
  }
  chunks.push(']}');
  return { blob: new Blob(chunks, { type: 'application/json;charset=utf-8' }), rowCount: written };
}
