// @vitest-environment jsdom
//
// #423: coverage for the apply/persist path of the Privacy Audit entity list.
//
// Task #416 covered the pure preview/diff logic. This file exercises the
// DB-backed half: applyEntitySnapshot / importEntitySnapshot / resetEntitySnapshot
// / loadEntitySnapshotFromStorage. These write to the settings record via Dexie
// and swap the active in-memory list, so a regression could silently fail to
// persist an imported list, or fail to fall back to the bundled list on corrupt
// data. We mock @/lib/database with a minimal Dexie (settings table only) backed
// by fake-indexeddb so the real CRUD path runs end to end.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Settings } from "@/lib/db-types";
import type { EntityEntry } from "../privacy-entity-list";

class TestDb extends Dexie {
  settings!: Table<Settings, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ settings: "id" });
  }
}

const testDb = new TestDb(`KYUTXO-entity-persist-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb, notifyDbChange: vi.fn() };
});

const {
  applyEntitySnapshot,
  importEntitySnapshot,
  resetEntitySnapshot,
  loadEntitySnapshotFromStorage,
  getEntityListStatus,
} = await import("./entity-list-store");
const { getSettings, putSettings } = await import("./settings-crud");
const {
  resetActiveEntityList,
  getActiveEntityList,
  getActiveEntitySource,
  getBundledEntityCount,
} = await import("../privacy-entity-list");

// Real, known-valid mainnet addresses drawn from the bundled list so they pass
// validateAddress() inside the import/load path.
const ADDR = {
  binance: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  binanceCold: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
  bitstamp: "12cgpFdJViXbwHbhrA3TuW1EGnL25Zqc3P",
  gambling1: "18WsHUKZ3D6DPTjWcDGS99E1uL2xYaxDaW",
} as const;

function entry(
  address: string,
  category: EntityEntry["category"],
  name = "Test",
): EntityEntry {
  return { address, name, category };
}

// A Dexie settings update is a no-op when the row is absent, so the real app
// always has a 'default' settings record. Seed a minimal one before each test.
async function seedDefaultSettings(): Promise<void> {
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
}

beforeEach(async () => {
  await testDb.settings.clear();
  await seedDefaultSettings();
  resetActiveEntityList();
});

afterEach(() => {
  // Never leak an imported active list into other suites.
  resetActiveEntityList();
});

describe("applyEntitySnapshot", () => {
  it("swaps the active list to the imported entries and persists them", async () => {
    const entries = [
      entry(ADDR.binance, "exchange", "Binance"),
      entry(ADDR.gambling1, "gambling", "Casino"),
    ];

    await applyEntitySnapshot(entries, "my-snapshot.json");

    // Active in-memory list swapped.
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityList()).toHaveLength(2);
    const active = new Set(getActiveEntityList().map((e) => e.address));
    expect(active.has(ADDR.binance)).toBe(true);
    expect(active.has(ADDR.gambling1)).toBe(true);

    // Persisted to the settings record.
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot).toBeDefined();
    expect(settings!.entityListSnapshot!.entries).toHaveLength(2);
    expect(settings!.entityListSnapshot!.sourceLabel).toBe("my-snapshot.json");
    expect(typeof settings!.entityListSnapshot!.importedAt).toBe("number");
  });

  it("replaces a previously persisted snapshot rather than appending to it", async () => {
    await applyEntitySnapshot([entry(ADDR.binance, "exchange")], "first.json");
    await applyEntitySnapshot(
      [entry(ADDR.bitstamp, "exchange"), entry(ADDR.gambling1, "gambling")],
      "second.json",
    );

    const settings = await getSettings("default");
    expect(settings!.entityListSnapshot!.entries).toHaveLength(2);
    expect(settings!.entityListSnapshot!.sourceLabel).toBe("second.json");
    const persisted = new Set(
      settings!.entityListSnapshot!.entries.map((e) => e.address),
    );
    expect(persisted.has(ADDR.binance)).toBe(false);
    expect(persisted.has(ADDR.bitstamp)).toBe(true);

    // Active list reflects the second snapshot only.
    expect(getActiveEntityList()).toHaveLength(2);
  });
});

describe("importEntitySnapshot", () => {
  it("validates, applies, and persists a valid snapshot", async () => {
    const raw = [
      { address: ADDR.binance, name: "Binance", category: "exchange" },
      { address: ADDR.gambling1, name: "Casino", category: "gambling" },
    ];

    const result = await importEntitySnapshot(raw, "import.json");

    expect(result.valid).toBe(true);
    expect(result.count).toBe(2);
    expect(result.total).toBe(2);
    expect(getActiveEntitySource()).toBe("imported");

    const settings = await getSettings("default");
    expect(settings!.entityListSnapshot!.entries).toHaveLength(2);
  });

  it("does not apply or persist an invalid snapshot", async () => {
    const raw = [
      { address: "not-a-valid-address", name: "Bad", category: "exchange" },
    ];

    const result = await importEntitySnapshot(raw, "bad.json");

    expect(result.valid).toBe(false);
    expect(result.count).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);

    // Active list untouched (still bundled) and nothing persisted.
    expect(getActiveEntitySource()).toBe("bundled");
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot).toBeUndefined();
  });
});

describe("resetEntitySnapshot", () => {
  it("restores the bundled list and clears the persisted snapshot", async () => {
    await applyEntitySnapshot([entry(ADDR.binance, "exchange")], "import.json");
    expect(getActiveEntitySource()).toBe("imported");
    expect((await getSettings("default"))?.entityListSnapshot).toBeDefined();

    await resetEntitySnapshot();

    // Active list is bundled again.
    expect(getActiveEntitySource()).toBe("bundled");
    expect(getActiveEntityList().length).toBe(getBundledEntityCount());

    // Persisted snapshot removed from the settings record.
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot).toBeUndefined();
  });
});

describe("loadEntitySnapshotFromStorage", () => {
  it("re-applies a valid persisted snapshot at startup", async () => {
    // Persist a snapshot, then simulate a fresh start by resetting the in-memory list.
    await applyEntitySnapshot(
      [entry(ADDR.binance, "exchange"), entry(ADDR.gambling1, "gambling")],
      "import.json",
    );
    resetActiveEntityList();
    expect(getActiveEntitySource()).toBe("bundled");

    const status = await loadEntitySnapshotFromStorage();

    expect(status.source).toBe("imported");
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityList()).toHaveLength(2);
  });

  it("falls back to the bundled list when no snapshot is persisted", async () => {
    const status = await loadEntitySnapshotFromStorage();

    expect(status.source).toBe("bundled");
    expect(getActiveEntitySource()).toBe("bundled");
    expect(status.activeCount).toBe(getBundledEntityCount());
  });

  it("falls back to the bundled list when the persisted snapshot is corrupt", async () => {
    // Write a corrupt snapshot directly (invalid address) bypassing validation.
    await putSettings(
      {
        id: "default",
        entityListSnapshot: {
          importedAt: Date.now(),
          sourceLabel: "corrupt.json",
          entries: [
            { address: "not-a-valid-address", name: "Bad", category: "exchange" },
          ],
        },
      } as Settings,
      { skipNotification: true },
    );

    const status = await loadEntitySnapshotFromStorage();

    expect(status.source).toBe("bundled");
    expect(getActiveEntitySource()).toBe("bundled");
    expect(status.activeCount).toBe(getBundledEntityCount());
  });

  it("ignores an empty persisted snapshot and keeps the bundled list", async () => {
    await putSettings(
      {
        id: "default",
        entityListSnapshot: {
          importedAt: Date.now(),
          sourceLabel: "empty.json",
          entries: [],
        },
      } as Settings,
      { skipNotification: true },
    );

    const status = await loadEntitySnapshotFromStorage();

    expect(status.source).toBe("bundled");
    expect(getActiveEntitySource()).toBe("bundled");
  });
});

describe("getEntityListStatus", () => {
  it("reports bundled source and counts by default", () => {
    const status = getEntityListStatus();
    expect(status.source).toBe("bundled");
    expect(status.bundledCount).toBe(getBundledEntityCount());
    expect(status.activeCount).toBe(getBundledEntityCount());
  });
});
