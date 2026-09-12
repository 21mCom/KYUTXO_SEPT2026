// @vitest-environment jsdom
//
// Task #1740 — "old records missing from search": tier parity + repairs.
//
// Guards the three row classes that used to make old (often long-ago synced
// and tagged) records silently unfindable on the Records page:
//
//   Class 1 — tier-hidden rows: blockchain-discovered / pending-review rows
//     match the search but are excluded by the default view. They must be
//     COUNTED (countHiddenTierMatches on Dexie; include-minus-exclude count
//     diff on the engine) so the UI can offer a one-click include instead of
//     a dead-end "No records match".
//   Class 2 — missing/invalid tiers: the engine's WHERE uses exclusion
//     semantics (`addressImportance IS NULL OR NOT IN (hidden)`), while the
//     Dexie search narrowing is an inclusion index (`anyOf(tiers)`). Rows
//     with unrecognized legacy tiers (restored verbatim from old backups)
//     were engine-visible but Dexie-search-invisible. Fixed by resolving the
//     visible tier list dynamically (resolveVisibleTierValues) and by the
//     provenance-aware repairAddressImportanceTiers. Rows with NO tier at
//     all cannot be reached by any Dexie index — that residual gap is
//     documented here: they stay reachable via the engine + the identifier
//     fast path, and the repair normalizes them for good.
//   Class 3 — stale inputStringLower: the engine free-text search now lowers
//     inputString at query time (never trusting the mirrored lower column),
//     and repairInputStringLower is re-runnable on demand so the Dexie
//     identifier fast path recovers too.
//
// Structure note: the describe blocks run IN ORDER (pre-repair → repairs →
// post-repair) and intentionally share one Dexie TestDb, because the point of
// the later blocks is to verify the repairs close the gaps the earlier blocks
// demonstrate.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";

import {
  createSchema,
  insertRecords,
  getRecordPage,
  countRecords as engineCountRecords,
  type RecordRow,
} from "../engine-core";
import { createInMemoryEngineDb } from "../better-sqlite3-adapter";

// ---------------------------------------------------------------------------
// Dexie test database (mirror of the records schema indexes Records.tsx uses)
// ---------------------------------------------------------------------------

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
    });
  }
}

const testDb = new TestDb(`KYUTXO-tier-parity-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

// Imported after the mock is registered so they bind to the TestDb.
const {
  repairAddressImportanceTiers,
  repairInputStringLower,
  countHiddenTierMatches,
} = await import("../../data/record-crud");
const {
  buildRecordsCollection,
  buildIdentifierSearchCollection,
  fetchRecordsPage,
  resolveVisibleTierValues,
  USER_TIERS,
} = await import("../../records-query");
const { isHiddenDiscoveryTier } = await import("../../db-types");

const PAGE = 50;

// ---------------------------------------------------------------------------
// Fixture — one row per class plus healthy controls.
// ---------------------------------------------------------------------------

const ADDR = {
  alpha: "bc1qalpha0000000000000000000000000000001",
  bravo: "bc1qbravo0000000000000000000000000000002",
  charlie: "bc1qcharlie00000000000000000000000000003",
  delta: "bc1qdelta0000000000000000000000000000004",
  echo: "bc1qecho00000000000000000000000000000005",
  foxtrot: "bc1qfoxtrot000000000000000000000000000006",
  golf: "bc1qgolf00000000000000000000000000000007",
  hotel: "bc1qhotel000000000000000000000000000008",
  india: "bc1qindia000000000000000000000000000009",
  juliet: "bc1qJULIETStaleLower00000000000000000010",
} as const;

interface Fx {
  id: number;
  inputString: string;
  /** Defaults to the correct lowercase; row 10 sets a deliberately stale one. */
  inputStringLower?: string;
  label?: string;
  tags?: string[];
  /** Omit for the missing-tier legacy row. */
  addressImportance?: string;
  syncDepth?: number;
}

const FIXTURES: Fx[] = [
  { id: 1, inputString: ADDR.alpha, label: "Cold storage alpha", addressImportance: "manual" },
  { id: 2, inputString: ADDR.bravo, label: "Exchange main", addressImportance: "verified" },
  // Class 2a: unrecognized legacy tier string, user metadata present.
  {
    id: 3,
    inputString: ADDR.charlie,
    label: "Old laptop stash",
    tags: ["legacy-vault"],
    addressImportance: "important",
  },
  // Class 2b: no tier at all (pre-tier row) — unreachable by ANY Dexie tier index.
  { id: 4, inputString: ADDR.delta, label: "Grandfather vault stash" },
  // Class 1: tagged long ago, but sync stamped it blockchain-discovered.
  {
    id: 5,
    inputString: ADDR.echo,
    label: "Tagged counterparty",
    tags: ["exchange-deposit"],
    addressImportance: "blockchain-discovered",
  },
  { id: 6, inputString: ADDR.foxtrot, label: "Pending review stash", addressImportance: "pending-review" },
  { id: 7, inputString: ADDR.golf, addressImportance: "manual" },
  { id: 8, inputString: ADDR.hotel, addressImportance: "blockchain-discovered" },
  // Class 2a with sync provenance: repair must send it BACK to a hidden
  // discovery tier (blanket-normalizing to 'manual' would leak it into
  // curated balance surfaces).
  {
    id: 9,
    inputString: ADDR.india,
    label: "Sync found stash",
    addressImportance: "auto-found",
    syncDepth: 2,
  },
  // Class 3: stale lowercase mirror (legacy-decrypt era drift).
  {
    id: 10,
    inputString: ADDR.juliet,
    inputStringLower: "zzzz-stale",
    label: "Stale key row",
    addressImportance: "manual",
  },
];

const CREATED_BASE = 1_700_000_000_000;

function toDexieRow(f: Fx): DbRecord {
  const row: globalThis.Record<string, unknown> = {
    id: f.id,
    type: "address",
    inputString: f.inputString,
    inputStringLower: f.inputStringLower ?? f.inputString.toLowerCase(),
    label: f.label,
    tags: f.tags ?? [],
    categories: [],
    createdAt: CREATED_BASE + f.id,
    updatedAt: 1000 + f.id,
  };
  if (f.addressImportance !== undefined) row.addressImportance = f.addressImportance;
  if (f.syncDepth !== undefined) row.syncDepth = f.syncDepth;
  return row as unknown as DbRecord;
}

function dexieToEngineRow(r: DbRecord): RecordRow {
  return {
    id: r.id as number,
    type: r.type,
    inputString: r.inputString,
    inputStringLower: r.inputStringLower ?? "",
    label: r.label ?? null,
    notes: r.notes ?? null,
    owner: r.owner ?? null,
    walletName: r.walletName ?? null,
    seedName: null,
    walletSoftware: null,
    addressImportance: (r.addressImportance as string | undefined) ?? null,
    chainType: null,
    syncDepth: (r as { syncDepth?: number }).syncDepth ?? null,
    firstSeenBlockTime: null,
    cachedBalanceSats: null,
    cachedTxCount: null,
    cachedUtxoCount: null,
    statsComputedAt: null,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
    tags: JSON.stringify(r.tags ?? []),
    categories: "[]",
  } as RecordRow;
}

const engine = createInMemoryEngineDb();

beforeAll(async () => {
  createSchema(engine);
  insertRecords(engine, FIXTURES.map((f) => dexieToEngineRow(toDexieRow(f))));
  await testDb.records.bulkAdd(FIXTURES.map(toDexieRow));
});

afterAll(async () => {
  engine.close?.();
  testDb.close();
  await Dexie.delete(testDb.name);
});

// ---------------------------------------------------------------------------
// Records.tsx replicas
// ---------------------------------------------------------------------------

// filterFn (exclusion semantics — mirrors the page's residual predicate).
function makeResidualNoTier(search: string) {
  const s = search.toLowerCase().trim();
  return (record: DbRecord): boolean => {
    if (s) {
      if (
        !(
          record.label?.toLowerCase().includes(s) ||
          record.inputString?.toLowerCase().includes(s) ||
          record.owner?.toLowerCase().includes(s) ||
          record.walletName?.toLowerCase().includes(s) ||
          record.notes?.toLowerCase().includes(s) ||
          record.tags?.some((t) => t.toLowerCase().includes(s))
        )
      ) {
        return false;
      }
    }
    return true;
  };
}

function makeFilterFn(search: string) {
  const residual = makeResidualNoTier(search);
  return (record: DbRecord): boolean => {
    if (isHiddenDiscoveryTier(record.addressImportance)) return false;
    return residual(record);
  };
}

function engineSearchIds(db: typeof engine, search: string, include: boolean): number[] {
  return getRecordPage(db, {
    search,
    includeBlockchainDiscovered: include,
    limit: PAGE,
  }).map((r) => r.id as number);
}

async function dexieSearchIds(
  search: string,
  visibleTierValues?: string[],
): Promise<number[]> {
  const s = search.toLowerCase().trim();
  const built = buildRecordsCollection(
    {
      search: s,
      columnFilters: [],
      includeBlockchainDiscovered: false,
      visibleTierValues,
    },
    makeFilterFn(s),
  );
  const page = await fetchRecordsPage(built, 0, PAGE, () => false);
  if (page === null) throw new Error("fetchRecordsPage returned null");
  return page.records.map((r) => r.id as number);
}

async function dexieIdentifierIds(identifier: string): Promise<number[]> {
  const s = identifier.toLowerCase().trim();
  const built = buildIdentifierSearchCollection(
    identifier,
    { search: s, columnFilters: [], includeBlockchainDiscovered: false },
    makeFilterFn(s),
  );
  const page = await fetchRecordsPage(built, 0, PAGE, () => false);
  if (page === null) throw new Error("fetchRecordsPage returned null");
  return page.records.map((r) => r.id as number);
}

// ---------------------------------------------------------------------------
// 1. Pre-repair: demonstrate visibility + parity of the seeded classes.
// ---------------------------------------------------------------------------

describe("pre-repair: invalid/missing tiers and hidden-tier matches", () => {
  it("engine search (default view) sees invalid- AND missing-tier rows (exclusion semantics)", () => {
    expect(engineSearchIds(engine, "stash", false)).toEqual([9, 4, 3]);
    expect(engineSearchIds(engine, "stash", true)).toEqual([9, 6, 4, 3]);
  });

  it("resolveVisibleTierValues = distinct stored tiers minus hidden, unioned with the standard tiers", async () => {
    const visible = await resolveVisibleTierValues();
    const set = new Set(visible);
    for (const t of USER_TIERS) expect(set.has(t)).toBe(true);
    expect(set.has("important")).toBe(true);
    expect(set.has("auto-found")).toBe(true);
    expect(set.has("blockchain-discovered")).toBe(false);
    expect(set.has("pending-review")).toBe(false);
  });

  it("Dexie search finds invalid-tier rows with the dynamic tier list — and missed them with the old static one", async () => {
    const visible = await resolveVisibleTierValues();
    expect(await dexieSearchIds("stash", visible)).toEqual([9, 3]);
    // The old behavior (static USER_TIERS narrowing): both legacy-tier rows
    // silently invisible — the exact bug class this task fixes.
    expect(await dexieSearchIds("stash")).toEqual([]);
  });

  it("missing-tier row stays reachable via the identifier fast path (documented Dexie substring-index gap)", async () => {
    // No Dexie index can enumerate rows whose addressImportance key is absent,
    // so the dynamic tier list cannot surface row 4 in substring search — the
    // engine path and the identifier path cover it until the tier repair
    // normalizes it (post-repair block below).
    expect(await dexieIdentifierIds(ADDR.delta)).toEqual([4]);
  });

  it("hidden-tier match count: Dexie helper agrees with the engine include/exclude diff", async () => {
    const withHidden = engineCountRecords(engine, {
      search: "stash",
      includeBlockchainDiscovered: true,
    });
    const visibleOnly = engineCountRecords(engine, {
      search: "stash",
      includeBlockchainDiscovered: false,
    });
    expect(withHidden - visibleOnly).toBe(1); // row 6 (pending-review)

    const dexie = await countHiddenTierMatches({
      matches: makeResidualNoTier("stash"),
    });
    expect(dexie).toEqual({ count: 1, capped: false, scanCapped: false });
  });

  it("countHiddenTierMatches respects matchCap, scanCap, and the identifier index", async () => {
    // All three hidden rows (5, 6, 8) match a pass-everything predicate.
    const all = await countHiddenTierMatches({ matches: () => true });
    expect(all).toEqual({ count: 3, capped: false, scanCapped: false });

    const capped = await countHiddenTierMatches({ matches: () => true, matchCap: 2 });
    expect(capped.count).toBe(2);
    expect(capped.capped).toBe(true);

    const scanCapped = await countHiddenTierMatches({
      matches: () => false,
      scanCap: 1,
    });
    expect(scanCapped.count).toBe(0);
    expect(scanCapped.scanCapped).toBe(true);

    const viaIdentifier = await countHiddenTierMatches({
      matches: () => true,
      identifier: ADDR.echo,
    });
    expect(viaIdentifier.count).toBe(1);

    // Cancellation stops the walk without throwing.
    const cancelled = await countHiddenTierMatches({
      matches: () => true,
      isCancelled: () => true,
    });
    expect(cancelled.count).toBe(0);
  });

  it("engine free-text search ignores a stale lowercase mirror (lowers inputString at query time)", () => {
    // Row 10's mirrored inputStringLower is "zzzz-stale". The engine must
    // find it by its REAL address text and must NOT find it by the stale key.
    expect(engineSearchIds(engine, "julietstale", false)).toEqual([10]);
    expect(engineSearchIds(engine, "zzzz-stale", false)).toEqual([]);
  });

  it("Dexie identifier fast path misses the stale-lower row (repaired below)", async () => {
    expect(await dexieIdentifierIds(ADDR.juliet)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Repairs (provenance-aware tiers; re-runnable search-key rebuild).
// ---------------------------------------------------------------------------

describe("repairs", () => {
  it("repairAddressImportanceTiers normalizes by provenance, bumps updatedAt, and is idempotent", async () => {
    const res = await repairAddressImportanceTiers();
    expect(res).toEqual({ scanned: 10, fixed: 3, ok: true });

    const [r3, r4, r9] = await Promise.all([
      testDb.records.get(3),
      testDb.records.get(4),
      testDb.records.get(9),
    ]);
    // No provenance → manual (user tier, becomes visible + searchable).
    expect(r3?.addressImportance).toBe("manual");
    expect(r4?.addressImportance).toBe("manual");
    // Sync provenance (syncDepth > 0) → back to a hidden discovery tier, NOT
    // 'manual' — a blanket-manual repair would inflate curated balances.
    expect(r9?.addressImportance).toBe("blockchain-discovered");

    // Fixed rows must be visible to the engine's freshness fingerprint
    // (count/maxId/maxUpdatedAt): updatedAt bumped on fixed rows only.
    expect(r3!.updatedAt).toBeGreaterThan(CREATED_BASE);
    expect(r4!.updatedAt).toBeGreaterThan(CREATED_BASE);
    expect(r9!.updatedAt).toBeGreaterThan(CREATED_BASE);
    const [r1, r5] = await Promise.all([testDb.records.get(1), testDb.records.get(5)]);
    expect(r1?.updatedAt).toBe(1001);
    expect(r1?.addressImportance).toBe("manual");
    // Valid hidden tiers are never "promoted" by the repair.
    expect(r5?.addressImportance).toBe("blockchain-discovered");
    expect(r5?.updatedAt).toBe(1005);

    const again = await repairAddressImportanceTiers();
    expect(again).toEqual({ scanned: 10, fixed: 0, ok: true });
  });

  it("repairInputStringLower re-runs on demand and restores identifier searchability", async () => {
    const res = await repairInputStringLower();
    expect(res.ok).toBe(true);
    expect(res.fixed).toBeGreaterThanOrEqual(1);

    const r10 = await testDb.records.get(10);
    expect(r10?.inputStringLower).toBe(ADDR.juliet.toLowerCase());
    expect(await dexieIdentifierIds(ADDR.juliet)).toEqual([10]);
  });
});

// ---------------------------------------------------------------------------
// 3. Post-repair: full engine/Dexie search parity, including the previously
//    missing-tier row, with the repaired vault mirrored into a fresh engine.
// ---------------------------------------------------------------------------

describe("post-repair parity", () => {
  let engine2: ReturnType<typeof createInMemoryEngineDb>;

  beforeAll(async () => {
    engine2 = createInMemoryEngineDb();
    createSchema(engine2);
    const rows = await testDb.records.toArray();
    insertRecords(engine2, rows.map(dexieToEngineRow));
  });

  afterAll(() => {
    engine2.close?.();
  });

  it("engine and Dexie agree exactly on default-view search (repaired rows included, sync-provenance row hidden)", async () => {
    const engineIds = engineSearchIds(engine2, "stash", false);
    expect(engineIds).toEqual([4, 3]);

    const visible = await resolveVisibleTierValues();
    expect(await dexieSearchIds("stash", visible)).toEqual(engineIds);
    // After the repair even the legacy static narrowing agrees.
    expect(await dexieSearchIds("stash")).toEqual(engineIds);
  });

  it("hidden-match counts still agree (row 9 now correctly counted as hidden)", async () => {
    const withHidden = engineCountRecords(engine2, {
      search: "stash",
      includeBlockchainDiscovered: true,
    });
    const visibleOnly = engineCountRecords(engine2, {
      search: "stash",
      includeBlockchainDiscovered: false,
    });
    expect(withHidden - visibleOnly).toBe(2); // rows 6 and 9

    const dexie = await countHiddenTierMatches({
      matches: makeResidualNoTier("stash"),
    });
    expect(dexie.count).toBe(2);
  });
});
