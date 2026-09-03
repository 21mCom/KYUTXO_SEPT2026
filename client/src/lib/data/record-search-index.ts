import Dexie, { type Table } from "dexie";
import { db, type Record as DbRecord } from "../database";

/**
 * This table is deliberately derived and device-local. It is not included in
 * backups: records are the source of truth and the index can always be rebuilt.
 */
export interface RecordSearchIndexEntry {
  id?: number;
  gram: string;
  kind: "notes" | "custom";
  recordId: number;
}

export interface RecordSearchIndexState {
  id: "state";
  version: 1;
  status: "ready" | "building";
  recordCount: number;
  maxId: number;
  maxUpdatedAt: number;
  pendingMutations?: number;
  rebuilding?: boolean;
  generation?: number;
}

const INDEX_VERSION = 1;
const MIN_GRAM_LENGTH = 3;

type SearchIndexTable = Table<RecordSearchIndexEntry, number>;
type SearchIndexStateTable = Table<RecordSearchIndexState, string>;

function getIndexTable(): SearchIndexTable | undefined {
  return (db as unknown as { recordSearchIndex?: SearchIndexTable }).recordSearchIndex;
}

function getStateTable(): SearchIndexStateTable | undefined {
  return (db as unknown as { recordSearchIndexState?: SearchIndexStateTable }).recordSearchIndexState;
}

function gramsForText(text: string): string[] {
  const normalized = text.toLowerCase();
  if (normalized.length < MIN_GRAM_LENGTH) return [];
  const grams = new Set<string>();
  for (let i = 0; i <= normalized.length - MIN_GRAM_LENGTH; i++) {
    grams.add(normalized.slice(i, i + MIN_GRAM_LENGTH));
  }
  return [...grams];
}

export function buildRecordSearchIndexEntries(record: DbRecord): RecordSearchIndexEntry[] {
  if (record.id == null) return [];
  const entries: RecordSearchIndexEntry[] = [];
  const noteGrams = new Set(gramsForText(record.notes ?? ""));
  for (const gram of noteGrams) {
    entries.push({ gram, kind: "notes", recordId: record.id });
  }
  const customGrams = new Set<string>();
  for (const text of Object.values(record.customFields ?? {})) {
    if (typeof text !== "string") continue;
    for (const gram of gramsForText(text)) customGrams.add(gram);
  }
  for (const gram of customGrams) {
    entries.push({ gram, kind: "custom", recordId: record.id });
  }
  return entries;
}

export type RecordSearchIndexFingerprint = Pick<
  RecordSearchIndexState,
  "recordCount" | "maxId" | "maxUpdatedAt"
>;

export async function persistRecordSearchIndexReadyState(
  fingerprint: RecordSearchIndexFingerprint,
  expectedGeneration?: number,
): Promise<boolean> {
  const stateTable = getStateTable();
  if (!stateTable) return true;
  return db.transaction("rw", stateTable, async () => {
    const current = await stateTable.get("state");
    const pendingMutations = current?.pendingMutations ?? 0;
    const generation = current?.generation ?? 0;
    const generationMatches =
      expectedGeneration === undefined || generation === expectedGeneration;
    const ready = pendingMutations === 0 && generationMatches;
    await stateTable.put({
      id: "state",
      version: INDEX_VERSION,
      status: ready ? "ready" : "building",
      pendingMutations,
      rebuilding: !ready,
      generation,
      ...fingerprint,
    });
    return ready;
  });
}

export async function markRecordSearchIndexBuilding(
  fingerprint: RecordSearchIndexFingerprint,
): Promise<void> {
  const stateTable = getStateTable();
  if (!stateTable) return;
  const current = await stateTable.get("state");
  await stateTable.put({
    id: "state",
    version: INDEX_VERSION,
    status: "building",
    pendingMutations: current?.pendingMutations ?? 0,
    rebuilding: true,
    generation: current?.generation ?? 0,
    ...fingerprint,
  });
}

export async function beginRecordSearchIndexRebuild(
  fingerprint: RecordSearchIndexFingerprint,
): Promise<number | undefined> {
  const stateTable = getStateTable();
  if (!stateTable) return 0;
  return db.transaction("rw", stateTable, async () => {
    const current = await stateTable.get("state");
    const pendingMutations = current?.pendingMutations ?? 0;
    const generation = current?.generation ?? 0;
    await stateTable.put({
      id: "state",
      version: INDEX_VERSION,
      status: "building",
      pendingMutations,
      rebuilding: true,
      generation,
      ...fingerprint,
    });
    return pendingMutations === 0 ? generation : undefined;
  });
}

export async function beginRecordSearchIndexMutation(): Promise<void> {
  const stateTable = getStateTable();
  if (!stateTable) return;
  await db.transaction("rw", stateTable, async () => {
    const current = await stateTable.get("state");
    await stateTable.put({
      id: "state",
      version: INDEX_VERSION,
      status: "building",
      recordCount: current?.recordCount ?? 0,
      maxId: current?.maxId ?? 0,
      maxUpdatedAt: current?.maxUpdatedAt ?? 0,
      pendingMutations: (current?.pendingMutations ?? 0) + 1,
      rebuilding: current?.rebuilding ?? false,
      generation: (current?.generation ?? 0) + 1,
    });
  });
}

export async function completeRecordSearchIndexMutation(
  fingerprint: RecordSearchIndexFingerprint,
): Promise<void> {
  const stateTable = getStateTable();
  if (!stateTable) return;
  await db.transaction("rw", stateTable, async () => {
    const current = await stateTable.get("state");
    const pendingMutations = Math.max(0, (current?.pendingMutations ?? 1) - 1);
    await stateTable.put({
      id: "state",
      version: INDEX_VERSION,
      status: pendingMutations === 0 && !current?.rebuilding ? "ready" : "building",
      pendingMutations,
      rebuilding: current?.rebuilding ?? false,
      generation: current?.generation ?? 0,
      ...fingerprint,
    });
  });
}

/**
 * Release a mutation whose derived index write failed without claiming that
 * the current postings are usable. The source records remain authoritative,
 * so the next search must rebuild from them rather than waiting forever on a
 * pending mutation that can never complete.
 */
export async function failRecordSearchIndexMutation(): Promise<void> {
  const stateTable = getStateTable();
  if (!stateTable) return;
  await db.transaction("rw", stateTable, async () => {
    const current = await stateTable.get("state");
    const pendingMutations = Math.max(0, (current?.pendingMutations ?? 1) - 1);
    await stateTable.put({
      id: "state",
      version: INDEX_VERSION,
      status: "building",
      pendingMutations,
      rebuilding: true,
      generation: current?.generation ?? 0,
      recordCount: current?.recordCount ?? 0,
      maxId: current?.maxId ?? 0,
      maxUpdatedAt: current?.maxUpdatedAt ?? 0,
    });
  });
}

/**
 * Keep one record's metadata postings in sync. The CRUD layer calls this after
 * the source row is written; a failed derived write is recoverable because the
 * fingerprint forces a rebuild on the next search.
 */
export async function syncRecordSearchIndex(record: DbRecord): Promise<void> {
  const indexTable = getIndexTable();
  if (!indexTable || record.id == null) return;
  await indexTable.where("recordId").equals(record.id).delete();
  const entries = buildRecordSearchIndexEntries(record);
  if (entries.length > 0) await indexTable.bulkAdd(entries);
}

export async function syncRecordSearchIndexBatch(records: DbRecord[]): Promise<void> {
  const indexTable = getIndexTable();
  if (!indexTable || records.length === 0) return;
  const ids = records.map((record) => record.id).filter((id): id is number => id != null);
  if (ids.length > 0) await indexTable.where("recordId").anyOf(ids).delete();
  const entries = records.flatMap(buildRecordSearchIndexEntries);
  if (entries.length > 0) await indexTable.bulkAdd(entries);
}

export async function removeRecordsFromSearchIndex(ids: number[]): Promise<void> {
  const indexTable = getIndexTable();
  if (!indexTable || ids.length === 0) return;
  await indexTable.where("recordId").anyOf(ids).delete();
}

export async function clearRecordSearchIndex(): Promise<void> {
  const indexTable = getIndexTable();
  const stateTable = getStateTable();
  if (indexTable) await indexTable.clear();
  if (stateTable) {
    await stateTable.put({
      id: "state",
      version: INDEX_VERSION,
      status: "ready",
      recordCount: 0,
      maxId: 0,
      maxUpdatedAt: 0,
      pendingMutations: 0,
      rebuilding: false,
      generation: 0,
    });
  }
}

export async function resetRecordSearchIndexForRebuild(): Promise<void> {
  const indexTable = getIndexTable();
  if (indexTable) await indexTable.clear();
}

export async function getRecordSearchIndexState(): Promise<RecordSearchIndexState | undefined> {
  const stateTable = getStateTable();
  return stateTable?.get("state");
}

/**
 * Returns record ids whose metadata contains every trigram in query. The
 * caller still checks the full metadata text, so trigram collisions cannot
 * produce false results. No records-table scan is used here.
 */
export async function getRecordIdsFromSearchIndex(query: string): Promise<number[]> {
  const indexTable = getIndexTable();
  if (!indexTable) return [];
  const normalized = query.trim().toLowerCase();
  if (normalized.length < MIN_GRAM_LENGTH) return [];
  const allGrams = gramsForText(normalized);
  // Keep long pasted queries bounded while sampling across their full span.
  const MAX_QUERY_GRAMS = 12;
  const grams = allGrams.length <= MAX_QUERY_GRAMS
    ? allGrams
    : Array.from(
        { length: MAX_QUERY_GRAMS },
        (_, index) => allGrams[Math.floor(index * (allGrams.length - 1) / (MAX_QUERY_GRAMS - 1))],
      );
  if (grams.length === 0) return [];

  const MAX_PER_KIND = 500;
  const postings = await Promise.all(
    (["notes", "custom"] as const).map(async (kind) => {
      const ranges = grams.map((gram) => ({
        gram,
        collection: indexTable
          .where("[gram+kind+recordId]")
          .between([gram, kind, Dexie.minKey], [gram, kind, Dexie.maxKey]),
      }));
      const counts = await Promise.all(ranges.map(({ collection }) => collection.count()));
      let rarestIndex = 0;
      for (let index = 1; index < counts.length; index++) {
        if (counts[index] < counts[rarestIndex]) rarestIndex = index;
      }
      return ranges[rarestIndex].collection.reverse().limit(MAX_PER_KIND).toArray();
    }),
  );
  const candidates = new Set(
    postings.flat().map((entry) => `${entry.kind}:${entry.recordId}`),
  );

  // A very common trigram must not turn a keystroke into an unbounded records
  // hydration. Ranking gives every notes match a higher base score than a
  // custom-field-only match, then prefers the greatest id within each group,
  // so retaining the newest candidates from both kinds preserves the palette's
  // top results while keeping hydration strictly bounded.
  const notes: number[] = [];
  const custom: number[] = [];
  for (const key of candidates) {
    const [kind, rawId] = key.split(":");
    const id = Number(rawId);
    (kind === "notes" ? notes : custom).push(id);
  }
  notes.sort((a, b) => b - a);
  custom.sort((a, b) => b - a);
  return [...new Set([...notes.slice(0, MAX_PER_KIND), ...custom.slice(0, MAX_PER_KIND)])];
}
