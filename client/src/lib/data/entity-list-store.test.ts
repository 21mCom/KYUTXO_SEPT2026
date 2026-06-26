import { describe, it, expect, beforeEach, vi } from "vitest";

const getSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();

vi.mock("./settings-crud", () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
  updateSettings: (...args: unknown[]) => updateSettingsMock(...args),
}));

import {
  validateEntitySnapshot,
  importEntitySnapshot,
  resetEntitySnapshot,
  loadEntitySnapshotFromStorage,
  getEntityListStatus,
  serializeActiveEntityList,
} from "./entity-list-store";
import {
  getActiveEntityList,
  getActiveEntitySource,
  resetActiveEntityList,
  getBundledEntityCount,
  type EntityEntry,
} from "../privacy-entity-list";

// Real, valid Bitcoin addresses (validated via the real bitcoinjs-lib path).
const ADDR_A = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";
const ADDR_B = "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s";
const ADDR_C = "bc1ql42rmpvvq488tkqxvg8wmaa7j3jsrkxgnm8cy6";

function entry(over: Partial<EntityEntry> = {}): Record<string, unknown> {
  return { address: ADDR_A, name: "Test Entity", category: "exchange", ...over };
}

beforeEach(() => {
  getSettingsMock.mockReset();
  updateSettingsMock.mockReset();
  updateSettingsMock.mockResolvedValue(undefined);
  // Each test starts from the bundled default list.
  resetActiveEntityList();
});

describe("validateEntitySnapshot", () => {
  it("accepts a bare array of entries", () => {
    const result = validateEntitySnapshot([entry()]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.total).toBe(1);
    expect(result.entries).toEqual([
      { address: ADDR_A, name: "Test Entity", category: "exchange" },
    ]);
  });

  it("accepts an object with an entries array", () => {
    const result = validateEntitySnapshot({ entries: [entry()] });
    expect(result.valid).toBe(true);
    expect(result.entries).toHaveLength(1);
  });

  it("preserves and trims an optional sourceNote", () => {
    const result = validateEntitySnapshot([entry({ sourceNote: "  public source  " })]);
    expect(result.valid).toBe(true);
    expect(result.entries[0].sourceNote).toBe("public source");
  });

  it("trims address, name and category before validating", () => {
    const result = validateEntitySnapshot([
      { address: `  ${ADDR_A}  `, name: "  Trimmed  ", category: "  exchange  " },
    ]);
    expect(result.valid).toBe(true);
    expect(result.entries[0]).toEqual({
      address: ADDR_A,
      name: "Trimmed",
      category: "exchange",
    });
  });

  it("rejects an invalid Bitcoin address", () => {
    const result = validateEntitySnapshot([entry({ address: "not-an-address" })]);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(0);
    expect(result.errors[0].message).toMatch(/Invalid Bitcoin address/);
  });

  it("rejects an unknown category", () => {
    const result = validateEntitySnapshot([entry({ category: "bank" })]);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Unknown category/);
  });

  it("rejects a duplicate address", () => {
    const result = validateEntitySnapshot([entry(), entry()]);
    expect(result.valid).toBe(false);
    const dup = result.errors.find((e) => /Duplicate address/.test(e.message));
    expect(dup).toBeDefined();
    expect(dup!.index).toBe(1);
  });

  it("rejects a non-string sourceNote", () => {
    const result = validateEntitySnapshot([entry({ sourceNote: 42 as unknown as string })]);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/"sourceNote" must be a string/);
  });

  it("reports a missing address and missing name", () => {
    const result = validateEntitySnapshot([{ category: "exchange" }]);
    expect(result.valid).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(messages).toContain('Missing "address".');
    expect(messages).toContain('Missing "name".');
  });

  it("rejects an empty array as having no entries", () => {
    const result = validateEntitySnapshot([]);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/no entries/);
  });

  it("rejects a non-array, non-object input", () => {
    const result = validateEntitySnapshot("nope");
    expect(result.valid).toBe(false);
    expect(result.errors[0].index).toBe(-1);
    expect(result.errors[0].message).toMatch(/Expected a JSON array/);
  });

  it("rejects a non-object entry", () => {
    const result = validateEntitySnapshot([null]);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Entry must be an object/);
  });

  it("collects multiple valid entries", () => {
    const result = validateEntitySnapshot([
      entry({ address: ADDR_A }),
      entry({ address: ADDR_B }),
      entry({ address: ADDR_C }),
    ]);
    expect(result.valid).toBe(true);
    expect(result.entries).toHaveLength(3);
  });
});

describe("importEntitySnapshot", () => {
  it("applies and persists a valid snapshot", async () => {
    const result = await importEntitySnapshot([entry()], "my-source.json");
    expect(result.valid).toBe(true);
    expect(result.count).toBe(1);
    expect(result.total).toBe(1);

    // Active list now reflects the imported entry.
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityList()).toEqual([
      { address: ADDR_A, name: "Test Entity", category: "exchange" },
    ]);

    // Persisted to settings with the source label.
    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    const [id, changes] = updateSettingsMock.mock.calls[0];
    expect(id).toBe("default");
    expect(changes.entityListSnapshot.sourceLabel).toBe("my-source.json");
    expect(changes.entityListSnapshot.entries).toHaveLength(1);
    expect(typeof changes.entityListSnapshot.importedAt).toBe("number");
  });

  it("does not apply or persist an invalid snapshot", async () => {
    const result = await importEntitySnapshot([entry({ category: "bank" })]);
    expect(result.valid).toBe(false);
    expect(result.count).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);

    // Active list stays bundled, nothing persisted.
    expect(getActiveEntitySource()).toBe("bundled");
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});

describe("resetEntitySnapshot", () => {
  it("restores the bundled list and clears the persisted snapshot", async () => {
    // First import so there is something to reset.
    await importEntitySnapshot([entry()]);
    expect(getActiveEntitySource()).toBe("imported");
    updateSettingsMock.mockClear();

    await resetEntitySnapshot();

    expect(getActiveEntitySource()).toBe("bundled");
    expect(updateSettingsMock).toHaveBeenCalledWith("default", {
      entityListSnapshot: undefined,
    });
  });
});

describe("loadEntitySnapshotFromStorage", () => {
  it("round-trips a persisted valid snapshot into the active list", async () => {
    getSettingsMock.mockResolvedValue({
      id: "default",
      entityListSnapshot: {
        importedAt: 123,
        sourceLabel: "saved.json",
        entries: [entry()],
      },
    });

    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");
    expect(status.activeCount).toBe(1);
    expect(getActiveEntityList()).toEqual([
      { address: ADDR_A, name: "Test Entity", category: "exchange" },
    ]);
  });

  it("falls back to the bundled list when the persisted snapshot is corrupt", async () => {
    getSettingsMock.mockResolvedValue({
      id: "default",
      entityListSnapshot: {
        importedAt: 123,
        entries: [{ address: "garbage", name: "X", category: "exchange" }],
      },
    });

    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("bundled");
    expect(status.activeCount).toBe(getBundledEntityCount());
  });

  it("leaves the bundled list active when there is no persisted snapshot", async () => {
    getSettingsMock.mockResolvedValue({ id: "default" });
    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("bundled");
    expect(status.activeCount).toBe(getBundledEntityCount());
  });

  it("falls back to the bundled list when reading settings throws", async () => {
    getSettingsMock.mockRejectedValue(new Error("db unavailable"));
    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("bundled");
    expect(status.activeCount).toBe(getBundledEntityCount());
  });
});

describe("serializeActiveEntityList round-trip", () => {
  it("re-imports the exported bundled template cleanly", () => {
    const json = serializeActiveEntityList();
    const parsed = JSON.parse(json);

    const result = validateEntitySnapshot(parsed);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(getBundledEntityCount());
  });

  it("round-trips a previously imported list back through validation and import", async () => {
    // Replace the active list with a small custom snapshot.
    const custom = [
      entry({ address: ADDR_A }),
      entry({ address: ADDR_B }),
      entry({ address: ADDR_C, sourceNote: "public" }),
    ];
    const imported = await importEntitySnapshot(custom, "first.json");
    expect(imported.valid).toBe(true);
    expect(imported.count).toBe(3);

    // Export the now-active list and parse it back.
    const json = serializeActiveEntityList();
    const parsed = JSON.parse(json);

    const result = validateEntitySnapshot(parsed);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(3);
    expect(result.entries).toEqual(getActiveEntityList());

    // The round-tripped snapshot imports without errors.
    updateSettingsMock.mockClear();
    const reimported = await importEntitySnapshot(parsed, "second.json");
    expect(reimported.valid).toBe(true);
    expect(reimported.count).toBe(3);
    expect(reimported.errors).toEqual([]);
    expect(getActiveEntityList()).toEqual(custom);
  });
});

describe("getEntityListStatus", () => {
  it("reports the bundled count and bundled source by default", () => {
    const status = getEntityListStatus();
    expect(status.source).toBe("bundled");
    expect(status.activeCount).toBe(getBundledEntityCount());
    expect(status.bundledCount).toBe(getBundledEntityCount());
  });
});
