import type Dexie from "dexie";
import type { ColumnFilter } from "@/components/RecordFilters";
import { db, type Record as DbRecord, type AddressImportance } from "@/lib/database";

export const USER_TIERS: AddressImportance[] = [
  "verified",
  "manual",
  "wallet-import",
  "xpub-derived",
];

// Text fields whose `equals` comparison must be case-insensitive to match
// the residual filterFn (which lowercases both sides). The pre-lowered
// `inputStringLower` index handles inputString equality directly via .equals().
const CASE_INSENSITIVE_EQUALS_FIELDS = new Set([
  "label",
  "owner",
  "walletName",
  "seedName",
  "walletSoftware",
]);

// Hard cap on how many records we materialize from a narrowed Collection
// before sorting/paginating in JS. Larger narrowings will only count and
// paginate within this window — preferable to loading hundreds of MB of
// objects into memory and freezing the renderer.
export const MAX_MATERIALIZE = 10_000;

type IndexedNarrowing =
  | { kind: "equals"; field: string; value: string }
  | { kind: "startsWith"; field: string; value: string }
  | { kind: "multiEntry"; field: string; value: string }
  | { kind: "anyOf"; field: string; values: string[] };

const FIELD_PRIORITY: Record<string, number> = {
  inputString_equals: 1,
  inputString_startsWith: 2,
  tags_includes: 3,
  categories_includes: 3,
  label_equals: 4,
  label_startsWith: 5,
  owner_equals: 6,
  walletName_equals: 6,
  seedName_equals: 6,
  walletSoftware_equals: 6,
  owner_startsWith: 7,
  walletName_startsWith: 7,
  seedName_startsWith: 7,
  walletSoftware_startsWith: 7,
  addressImportance_equals: 8,
  chainType_equals: 9,
  type_equals: 10,
};

function classifyFilter(f: ColumnFilter): { narrow: IndexedNarrowing; priority: number } | null {
  const raw = f.value ?? "";
  const trimmed = raw.trim();
  const key = `${f.field}_${f.operator}`;
  const priority = FIELD_PRIORITY[key] ?? Number.MAX_SAFE_INTEGER;
  if (priority === Number.MAX_SAFE_INTEGER) return null;
  if (!trimmed) return null;

  switch (f.field) {
    case "type":
    case "addressImportance":
    case "chainType":
      return { narrow: { kind: "equals", field: f.field, value: trimmed }, priority };
    case "tags":
    case "categories":
      return { narrow: { kind: "multiEntry", field: f.field, value: trimmed }, priority };
    case "label":
    case "owner":
    case "walletName":
    case "seedName":
    case "walletSoftware":
      if (f.operator === "equals") {
        return { narrow: { kind: "equals", field: f.field, value: trimmed }, priority };
      }
      if (f.operator === "startsWith") {
        return { narrow: { kind: "startsWith", field: f.field, value: trimmed }, priority };
      }
      return null;
    case "inputString":
      if (f.operator === "equals") {
        return {
          narrow: { kind: "equals", field: "inputStringLower", value: trimmed.toLowerCase() },
          priority,
        };
      }
      if (f.operator === "startsWith") {
        return {
          narrow: { kind: "startsWith", field: "inputStringLower", value: trimmed.toLowerCase() },
          priority,
        };
      }
      return null;
    default:
      return null;
  }
}

export interface BuildRecordsQueryParams {
  search: string;
  columnFilters: ColumnFilter[];
  includeBlockchainDiscovered: boolean;
}

export interface RecordsQueryStrategy {
  source:
    | "search-or-chain"
    | "column-filter"
    | "address-importance-tiers"
    | "full-table";
  narrowing?: IndexedNarrowing;
}

export interface BuildRecordsQueryResult {
  collection: Dexie.Collection<DbRecord, number>;
  strategy: RecordsQueryStrategy;
}

export function pickPrimaryNarrowing(
  search: string,
  columnFilters: ColumnFilter[],
  includeBlockchainDiscovered: boolean,
): RecordsQueryStrategy {
  if (search) return { source: "search-or-chain" };

  const candidates = columnFilters
    .map(classifyFilter)
    .filter((c): c is { narrow: IndexedNarrowing; priority: number } => c !== null)
    .sort((a, b) => a.priority - b.priority);

  if (candidates.length > 0) {
    return { source: "column-filter", narrowing: candidates[0].narrow };
  }

  if (!includeBlockchainDiscovered) {
    return {
      source: "address-importance-tiers",
      narrowing: { kind: "anyOf", field: "addressImportance", values: USER_TIERS },
    };
  }

  return { source: "full-table" };
}

export function buildRecordsCollection(
  params: BuildRecordsQueryParams,
  residualPredicate: (record: DbRecord) => boolean,
): BuildRecordsQueryResult {
  const { search, columnFilters, includeBlockchainDiscovered } = params;
  const strategy = pickPrimaryNarrowing(search, columnFilters, includeBlockchainDiscovered);

  let collection: Dexie.Collection<DbRecord, number>;

  if (strategy.source === "search-or-chain") {
    // NOTE: switching from substring (.includes) to indexed prefix on
    // label/inputStringLower/owner/walletName — required to avoid full-table
    // scans on 1-2M rows. Substring matches that aren't prefixes (and notes
    // substring matches with no other narrowing) are no longer surfaced.
    collection = db.records
      .where("label").startsWithIgnoreCase(search)
      .or("inputStringLower").startsWith(search)
      .or("owner").startsWithIgnoreCase(search)
      .or("walletName").startsWithIgnoreCase(search);
  } else if (strategy.source === "column-filter" && strategy.narrowing) {
    const n = strategy.narrowing;
    if (n.kind === "equals") {
      // Use case-insensitive equality for text fields so the index narrowing
      // matches the case-insensitive comparison done by the residual filterFn.
      // For enums/scalars (type/addressImportance/chainType, multi-entry tags),
      // case-sensitive equality is correct.
      if (CASE_INSENSITIVE_EQUALS_FIELDS.has(n.field)) {
        collection = db.records.where(n.field).equalsIgnoreCase(n.value);
      } else {
        collection = db.records.where(n.field).equals(n.value);
      }
    } else if (n.kind === "startsWith") {
      collection = db.records.where(n.field).startsWithIgnoreCase(n.value);
    } else if (n.kind === "multiEntry") {
      collection = db.records.where(n.field).equalsIgnoreCase(n.value);
    } else {
      collection = db.records.where(n.field).anyOf(n.values);
    }
  } else if (strategy.source === "address-importance-tiers" && strategy.narrowing?.kind === "anyOf") {
    collection = db.records.where(strategy.narrowing.field).anyOf(strategy.narrowing.values);
  } else {
    // Worst-case fallback: only fires when blockchain-discovered are included
    // AND no indexable filter exists (e.g. only `notes contains X`). Behavior
    // matches the old code — slow but at least not regressing the result set.
    collection = db.records.toCollection();
  }

  return {
    collection: collection.and(residualPredicate),
    strategy,
  };
}

export async function fetchRecordsPage(
  result: BuildRecordsQueryResult,
  pgOffset: number,
  pageSize: number,
  isCancelled: () => boolean,
): Promise<{
  records: DbRecord[];
  total: number;          // full match count (from .count() when truncated)
  effectiveTotal: number; // capped to MAX_MATERIALIZE for pagination math
  truncated: boolean;
} | null> {
  // Walk the narrowed Collection with an early-stop cap so we never allocate
  // hundreds of thousands of record objects in JS even if the residual
  // predicate (e.g. notes contains) is broad. Cancellation is checked per
  // batch so navigation away aborts the work promptly.
  const collected: DbRecord[] = [];
  const seen = new Set<number>();
  let truncated = false;
  let cancelled = false;

  await result.collection
    .until(() => collected.length >= MAX_MATERIALIZE || isCancelled())
    .each((record) => {
      if (isCancelled()) {
        cancelled = true;
        return;
      }
      if (record.id == null || seen.has(record.id)) return;
      seen.add(record.id);
      collected.push(record);
    });

  if (cancelled || isCancelled()) return null;

  if (collected.length >= MAX_MATERIALIZE) {
    truncated = true;
  }

  collected.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

  // When truncated, fall back to .count() for an accurate total since the
  // materialized slice doesn't represent the full match set. .count() walks
  // the narrowed index without allocating records, so it's much cheaper
  // than .toArray() even on broad residual predicates.
  let total = collected.length;
  if (truncated) {
    try {
      total = await result.collection.count();
      if (isCancelled()) return null;
    } catch {
      total = collected.length;
    }
  }

  return {
    records: collected.slice(pgOffset, pgOffset + pageSize),
    total,
    effectiveTotal: Math.min(total, collected.length),
    truncated,
  };
}
