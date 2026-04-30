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

// Lower number = more selective (narrower index → smaller candidate set).
// Selectivity is approximate; specifically, equality on a high-cardinality
// text field (label/owner/walletName/etc.) is cheaper than equality on a
// low-cardinality enum (type/addressImportance/chainType), because the
// residual predicate has to walk every candidate the index returns.
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
    | "column-filter"
    | "address-importance-tiers"
    | "full-table";
  narrowing?: IndexedNarrowing;
}

export interface BuildRecordsQueryResult {
  collection: Dexie.Collection<DbRecord, number>;
  strategy: RecordsQueryStrategy;
}

/**
 * Pick the primary indexed narrowing for a Records query.
 *
 * Search is intentionally NEVER chosen as the primary narrowing — it is
 * applied as a residual substring predicate by the caller's filterFn, which
 * preserves the legacy `.includes()` semantics across label / inputString /
 * owner / walletName / notes.
 *
 * Selection order:
 *   1. Most selective indexable column filter (by FIELD_PRIORITY).
 *   2. addressImportance.anyOf(USER_TIERS) when blockchain-discovered are
 *      excluded (always true when the user hasn't toggled the include).
 *   3. Full-table scan — only when the user opts in to include blockchain-
 *      discovered AND has no indexable column filter. Matches legacy
 *      behavior; bounded by MAX_MATERIALIZE in fetchRecordsPage.
 */
export function pickPrimaryNarrowing(
  search: string,
  columnFilters: ColumnFilter[],
  includeBlockchainDiscovered: boolean,
): RecordsQueryStrategy {
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

  if (strategy.source === "column-filter" && strategy.narrowing) {
    const n = strategy.narrowing;
    if (n.kind === "equals") {
      // Use case-insensitive equality for text fields so the index narrowing
      // matches the case-insensitive comparison done by the residual filterFn.
      // For enums/scalars (type/addressImportance/chainType) and the pre-
      // lowered inputStringLower index, case-sensitive equality is correct.
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
    // AND no indexable column filter exists. Behavior matches the legacy code
    // (full-table walk with the residual predicate) — slow but does not
    // change the result set. Bounded by MAX_MATERIALIZE in fetchRecordsPage.
    collection = db.records.toCollection();
  }

  return {
    collection: collection.and(residualPredicate),
    strategy,
  };
}

export interface FetchRecordsPageResult {
  records: DbRecord[];
  /** Exact match count when not truncated; equal to MAX_MATERIALIZE when truncated. */
  total: number;
  /** Capped to MAX_MATERIALIZE for pagination math. */
  effectiveTotal: number;
  /** True when the materialization cap was hit. UI should render "10,000+" and prompt the user to narrow. */
  truncated: boolean;
}

export async function fetchRecordsPage(
  result: BuildRecordsQueryResult,
  pgOffset: number,
  pageSize: number,
  isCancelled: () => boolean,
): Promise<FetchRecordsPageResult | null> {
  // Walk the narrowed Collection with an early-stop cap so we never allocate
  // hundreds of thousands of record objects in JS even if the residual
  // predicate (e.g. notes contains) is broad. Cancellation is checked per
  // batch so navigation away aborts the work promptly.
  //
  // ORDERING NOTE: rows are collected in the iteration order of the chosen
  // primary index (NOT globally id-desc), then sorted id-desc IN-WINDOW for
  // display. When the cap is hit, the materialized window is therefore a
  // "first N matches by index order" sample, not the globally top-N by id.
  // The UI surfaces this with the truncation notice and asks the user to
  // narrow further before drawing conclusions about completeness.
  //
  // We deliberately do NOT call result.collection.count() on the truncated
  // path: count() must walk every candidate the primary index returns and
  // run the residual JS predicate on each, which is exactly the expensive
  // path we're trying to avoid on broad search/filter combinations against
  // 1-2M rows. Instead the UI renders "10,000+" semantics from the
  // truncated flag.
  const collected: DbRecord[] = [];
  const seen = new Set<number>();
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

  const truncated = collected.length >= MAX_MATERIALIZE;

  collected.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

  return {
    records: collected.slice(pgOffset, pgOffset + pageSize),
    total: collected.length,
    effectiveTotal: collected.length,
    truncated,
  };
}
