import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  buildEntitySnapshotPreview,
  prepareEntitySnapshot,
} from "./entity-list-store";
import {
  getActiveEntityList,
  getActiveEntitySource,
  setActiveEntityList,
  resetActiveEntityList,
  getBundledEntityCount,
  type EntityEntry,
} from "../privacy-entity-list";

// Real, valid Bitcoin addresses (validated via the real bitcoinjs-lib path).
const ADDR_A = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";
const ADDR_B = "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s";
const ADDR_C = "bc1ql42rmpvvq488tkqxvg8wmaa7j3jsrkxgnm8cy6";

// Real, known-valid mainnet Bitcoin addresses drawn from the bundled list so
// they pass validateAddress() inside prepareEntitySnapshot.
const ADDR = {
  binance: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  binanceCold: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
  bitstamp: "12cgpFdJViXbwHbhrA3TuW1EGnL25Zqc3P",
  gambling1: "18WsHUKZ3D6DPTjWcDGS99E1uL2xYaxDaW",
  gambling2: "1NGSrBs4BAazQRfD3PafjHB9jwJocoNy6i",
} as const;

function entry(over: Partial<EntityEntry> = {}): Record<string, unknown> {
  return { address: ADDR_A, name: "Test Entity", category: "exchange", ...over };
}

function addrEntry(
  address: string,
  category: EntityEntry["category"],
  name = "Test",
): EntityEntry {
  return { address, name, category };
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

  it("defaults to replace mode and persists mode='replace'", async () => {
    const result = await importEntitySnapshot([entry()], "src.json");
    expect(result.valid).toBe(true);
    expect(result.mode).toBe("replace");
    expect(result.activeCount).toBe(1);
    expect(getActiveEntityList()).toHaveLength(1);

    const [, changes] = updateSettingsMock.mock.calls[0];
    expect(changes.entityListSnapshot.mode).toBe("replace");
    expect(changes.entityListSnapshot.entries).toHaveLength(1);
  });

  it("merges the snapshot on top of the bundled list", async () => {
    // ADDR_A exists in the bundled list (Binance). A brand-new address does not.
    const NEW_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const bundledCount = getBundledEntityCount();
    const result = await importEntitySnapshot(
      [entry({ address: NEW_ADDR, name: "New Market", category: "darknet" })],
      "src.json",
      "merge",
    );

    expect(result.valid).toBe(true);
    expect(result.mode).toBe("merge");
    // One brand-new address added on top of bundled.
    expect(result.activeCount).toBe(bundledCount + 1);
    expect(getActiveEntityList()).toHaveLength(bundledCount + 1);

    // Only the user-supplied entry is persisted (not the merged result).
    const [, changes] = updateSettingsMock.mock.calls[0];
    expect(changes.entityListSnapshot.mode).toBe("merge");
    expect(changes.entityListSnapshot.entries).toHaveLength(1);
  });

  it("lets a merged snapshot override a bundled address without growing the list", async () => {
    const bundledCount = getBundledEntityCount();
    // ADDR_A is in the bundled list; overriding it should not change the count.
    const result = await importEntitySnapshot(
      [entry({ address: ADDR_A, name: "Overridden", category: "mixer" })],
      "src.json",
      "merge",
    );

    expect(result.valid).toBe(true);
    expect(result.activeCount).toBe(bundledCount);
    const overridden = getActiveEntityList().find((e) => e.address === ADDR_A);
    expect(overridden).toEqual({ address: ADDR_A, name: "Overridden", category: "mixer" });
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

  it("re-merges a persisted merge snapshot on top of the bundled list", async () => {
    const NEW_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const bundledCount = getBundledEntityCount();
    getSettingsMock.mockResolvedValue({
      id: "default",
      entityListSnapshot: {
        importedAt: 123,
        mode: "merge",
        entries: [{ address: NEW_ADDR, name: "New Market", category: "darknet" }],
      },
    });

    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");
    // Re-applied as a merge: bundled entries plus the one new address.
    expect(status.activeCount).toBe(bundledCount + 1);
    expect(getActiveEntityList().find((e) => e.address === NEW_ADDR)).toBeDefined();
  });

  it("replaces with a persisted snapshot that has no mode (legacy)", async () => {
    getSettingsMock.mockResolvedValue({
      id: "default",
      entityListSnapshot: {
        importedAt: 123,
        entries: [entry()],
      },
    });

    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");
    expect(status.activeCount).toBe(1);
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

  it("re-imports a hand-edited export template (add/edit/remove)", async () => {
    // A brand-new valid address that is not in the bundled list.
    const NEW_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

    const json = serializeActiveEntityList();
    const parsed = JSON.parse(json) as {
      entries: Array<{ address: string; name: string; category: string; sourceNote?: string }>;
    };
    const bundledCount = parsed.entries.length;
    expect(bundledCount).toBe(getBundledEntityCount());
    expect(bundledCount).toBeGreaterThan(2);

    // Simulate a realistic hand-edit of the template:
    // 1) Add one brand-new valid entry.
    parsed.entries.push({
      address: NEW_ADDR,
      name: "Hand Added Market",
      category: "darknet",
    });
    // 2) Edit an existing entry's name and category.
    parsed.entries[0] = {
      ...parsed.entries[0],
      name: "Renamed Entity",
      category: "mixer",
    };
    // 3) Remove an existing entry.
    const removed = parsed.entries.splice(1, 1)[0];

    // Net effect: +1 added, -1 removed → same count as the bundled list.
    const expectedCount = bundledCount;
    expect(parsed.entries).toHaveLength(expectedCount);

    const result = validateEntitySnapshot(parsed);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.total).toBe(expectedCount);
    expect(result.entries).toHaveLength(expectedCount);

    // The edited and added entries are present; the removed one is gone.
    expect(result.entries.find((e) => e.address === NEW_ADDR)).toEqual({
      address: NEW_ADDR,
      name: "Hand Added Market",
      category: "darknet",
    });
    const edited = result.entries.find((e) => e.address === parsed.entries[0].address);
    expect(edited).toMatchObject({ name: "Renamed Entity", category: "mixer" });
    expect(result.entries.find((e) => e.address === removed.address)).toBeUndefined();

    // The hand-edited snapshot imports without errors.
    updateSettingsMock.mockClear();
    const imported = await importEntitySnapshot(parsed, "hand-edited.json");
    expect(imported.valid).toBe(true);
    expect(imported.count).toBe(expectedCount);
    expect(imported.errors).toEqual([]);
    expect(getActiveEntityList()).toHaveLength(expectedCount);
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

describe("buildEntitySnapshotPreview", () => {
  afterEach(() => {
    // Avoid leaking the imported active list into other tests / suites.
    resetActiveEntityList();
  });

  it("treats every incoming address as added when the current list is empty", () => {
    setActiveEntityList([]);
    const incoming = [
      addrEntry(ADDR.binance, "exchange"),
      addrEntry(ADDR.gambling1, "gambling"),
    ];

    const preview = buildEntitySnapshotPreview(incoming);

    expect(preview.incomingCount).toBe(2);
    expect(preview.currentCount).toBe(0);
    expect(preview.added).toBe(2);
    expect(preview.removed).toBe(0);
    expect(preview.unchanged).toBe(0);
  });

  it("counts everything as added/removed for a fully new (non-overlapping) list", () => {
    setActiveEntityList([
      addrEntry(ADDR.binance, "exchange"),
      addrEntry(ADDR.binanceCold, "exchange"),
    ]);
    const incoming = [
      addrEntry(ADDR.gambling1, "gambling"),
      addrEntry(ADDR.gambling2, "gambling"),
    ];

    const preview = buildEntitySnapshotPreview(incoming);

    expect(preview.incomingCount).toBe(2);
    expect(preview.currentCount).toBe(2);
    expect(preview.added).toBe(2);
    expect(preview.removed).toBe(2);
    expect(preview.unchanged).toBe(0);
  });

  it("computes added/removed/unchanged for a partial overlap", () => {
    // Current: binance, binanceCold, bitstamp
    setActiveEntityList([
      addrEntry(ADDR.binance, "exchange"),
      addrEntry(ADDR.binanceCold, "exchange"),
      addrEntry(ADDR.bitstamp, "exchange"),
    ]);
    // Incoming: binance (shared), bitstamp (shared), gambling1 (new)
    const incoming = [
      addrEntry(ADDR.binance, "exchange"),
      addrEntry(ADDR.bitstamp, "exchange"),
      addrEntry(ADDR.gambling1, "gambling"),
    ];

    const preview = buildEntitySnapshotPreview(incoming);

    expect(preview.incomingCount).toBe(3);
    expect(preview.currentCount).toBe(3);
    expect(preview.added).toBe(1); // gambling1
    expect(preview.removed).toBe(1); // binanceCold
    expect(preview.unchanged).toBe(2); // binance, bitstamp
  });

  it("reports 0 added and 0 removed for an identical list", () => {
    const list = [
      addrEntry(ADDR.binance, "exchange"),
      addrEntry(ADDR.gambling1, "gambling"),
    ];
    setActiveEntityList(list);

    const preview = buildEntitySnapshotPreview([
      addrEntry(ADDR.binance, "exchange"),
      addrEntry(ADDR.gambling1, "gambling"),
    ]);

    expect(preview.added).toBe(0);
    expect(preview.removed).toBe(0);
    expect(preview.unchanged).toBe(2);
  });

  it("returns every incoming entry in addedEntries when the current list is empty", () => {
    setActiveEntityList([]);
    const incoming = [
      addrEntry(ADDR.binance, "exchange", "Binance"),
      addrEntry(ADDR.gambling1, "gambling", "Casino"),
    ];

    const preview = buildEntitySnapshotPreview(incoming);

    expect(preview.added).toBe(2);
    expect(preview.removed).toBe(0);
    expect(preview.addedEntries).toEqual(incoming);
    expect(preview.removedEntries).toEqual([]);
  });

  it("returns every current entry in removedEntries when the incoming list is empty", () => {
    const current = [
      addrEntry(ADDR.binance, "exchange", "Binance"),
      addrEntry(ADDR.gambling1, "gambling", "Casino"),
    ];
    setActiveEntityList(current);

    const preview = buildEntitySnapshotPreview([]);

    expect(preview.added).toBe(0);
    expect(preview.removed).toBe(2);
    expect(preview.addedEntries).toEqual([]);
    expect(preview.removedEntries).toEqual(current);
  });

  it("returns empty added/removed entry arrays when both lists are empty", () => {
    setActiveEntityList([]);

    const preview = buildEntitySnapshotPreview([]);

    expect(preview.added).toBe(0);
    expect(preview.removed).toBe(0);
    expect(preview.unchanged).toBe(0);
    expect(preview.addedEntries).toEqual([]);
    expect(preview.removedEntries).toEqual([]);
  });

  it("classifies entries only in incoming as added and only in current as removed", () => {
    const binanceCurrent = addrEntry(ADDR.binance, "exchange", "Binance");
    const binanceColdRemoved = addrEntry(ADDR.binanceCold, "exchange", "Binance Cold");
    const bitstampCurrent = addrEntry(ADDR.bitstamp, "exchange", "Bitstamp");
    setActiveEntityList([binanceCurrent, binanceColdRemoved, bitstampCurrent]);

    const binanceIncoming = addrEntry(ADDR.binance, "exchange", "Binance");
    const bitstampIncoming = addrEntry(ADDR.bitstamp, "exchange", "Bitstamp");
    const gamblingAdded = addrEntry(ADDR.gambling1, "gambling", "Casino");
    const incoming = [binanceIncoming, bitstampIncoming, gamblingAdded];

    const preview = buildEntitySnapshotPreview(incoming);

    // Added = incoming addresses not in current (gambling1 only).
    expect(preview.added).toBe(1);
    expect(preview.addedEntries).toEqual([gamblingAdded]);

    // Removed = current addresses not in incoming (binanceCold only).
    expect(preview.removed).toBe(1);
    expect(preview.removedEntries).toEqual([binanceColdRemoved]);

    // Shared addresses are unchanged and appear in neither array.
    expect(preview.unchanged).toBe(2);
  });

  it("uses the current list's entry objects (not the incoming ones) for removedEntries", () => {
    // Same addresses, different metadata, to prove which side each array sources from.
    const currentBinance = addrEntry(ADDR.binance, "exchange", "Current Binance");
    setActiveEntityList([currentBinance]);

    const incomingBinance = addrEntry(ADDR.binance, "mixer", "Incoming Binance");
    const incomingGambling = addrEntry(ADDR.gambling1, "gambling", "Casino");

    const preview = buildEntitySnapshotPreview([incomingBinance, incomingGambling]);

    // binance is in both lists but its name AND category differ, so it is a
    // change (not unchanged) and appears in neither the added nor removed array.
    expect(preview.changed).toBe(1);
    expect(preview.unchanged).toBe(0);
    expect(preview.removedEntries).toEqual([]);
    // The change records both sides: current object and incoming object.
    expect(preview.changedEntries).toEqual([
      {
        address: ADDR.binance,
        current: currentBinance,
        incoming: incomingBinance,
        nameChanged: true,
        categoryChanged: true,
      },
    ]);
    // Only gambling1 is genuinely new, and it comes from the incoming list.
    expect(preview.addedEntries).toEqual([incomingGambling]);
  });

  it("reports empty added/removed entry arrays for an identical list", () => {
    const list = [
      addrEntry(ADDR.binance, "exchange", "Binance"),
      addrEntry(ADDR.gambling1, "gambling", "Casino"),
    ];
    setActiveEntityList(list);

    const preview = buildEntitySnapshotPreview([
      addrEntry(ADDR.binance, "exchange", "Binance"),
      addrEntry(ADDR.gambling1, "gambling", "Casino"),
    ]);

    expect(preview.addedEntries).toEqual([]);
    expect(preview.removedEntries).toEqual([]);
    expect(preview.unchanged).toBe(2);
  });

  it("produces a per-category breakdown only for categories present on either side", () => {
    setActiveEntityList([
      addrEntry(ADDR.binance, "exchange"),
      addrEntry(ADDR.binanceCold, "exchange"),
    ]);
    const incoming = [
      addrEntry(ADDR.binance, "exchange"), // shared exchange
      addrEntry(ADDR.gambling1, "gambling"), // new gambling
      addrEntry(ADDR.gambling2, "gambling"), // new gambling
    ];

    const preview = buildEntitySnapshotPreview(incoming);

    const byCategory = Object.fromEntries(
      preview.categories.map((c) => [c.category, c]),
    );

    // exchange: incoming 1, current 2
    expect(byCategory.exchange).toMatchObject({
      label: "Exchange",
      incoming: 1,
      current: 2,
    });
    // gambling: incoming 2, current 0
    expect(byCategory.gambling).toMatchObject({
      label: "Gambling",
      incoming: 2,
      current: 0,
    });
    // Categories with no entries on either side are excluded.
    expect(preview.categories).toHaveLength(2);
    expect(byCategory.mixer).toBeUndefined();
  });
});

describe("prepareEntitySnapshot", () => {
  afterEach(() => {
    resetActiveEntityList();
  });

  beforeEach(() => {
    setActiveEntityList([addrEntry(ADDR.binance, "exchange")]);
  });

  it("returns a preview for a valid bare-array snapshot", () => {
    const raw = [
      { address: ADDR.binance, name: "Binance", category: "exchange" },
      { address: ADDR.gambling1, name: "Casino", category: "gambling" },
    ];

    const result = prepareEntitySnapshot(raw);

    expect(result.valid).toBe(true);
    expect(result.total).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.preview).toBeDefined();
    expect(result.preview!.incomingCount).toBe(2);
    expect(result.preview!.added).toBe(1); // gambling1
    // binance is in both lists but its name differs ("Test" -> "Binance"),
    // so it is a change rather than unchanged.
    expect(result.preview!.changed).toBe(1); // binance renamed
    expect(result.preview!.unchanged).toBe(0);
    expect(result.preview!.currentCount).toBe(1);
  });

  it('accepts the wrapped { entries: [...] } object form', () => {
    const raw = {
      entries: [
        { address: ADDR.binance, name: "Binance", category: "exchange" },
      ],
    };

    const result = prepareEntitySnapshot(raw);

    expect(result.valid).toBe(true);
    expect(result.preview!.incomingCount).toBe(1);
    expect(result.preview!.added).toBe(0);
    // binance is in both lists but renamed ("Test" -> "Binance"): changed, not unchanged.
    expect(result.preview!.changed).toBe(1);
    expect(result.preview!.unchanged).toBe(0);
  });

  it("returns errors and no preview for an invalid snapshot", () => {
    const raw = [
      { address: "not-a-valid-address", name: "Bad", category: "exchange" },
      { address: ADDR.gambling1, name: "Casino", category: "no-such-category" },
    ];

    const result = prepareEntitySnapshot(raw);

    expect(result.valid).toBe(false);
    expect(result.preview).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.total).toBe(2);
  });

  it("rejects a non-array, non-object snapshot", () => {
    const result = prepareEntitySnapshot("nonsense");

    expect(result.valid).toBe(false);
    expect(result.preview).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an empty snapshot with no entries", () => {
    const result = prepareEntitySnapshot([]);

    expect(result.valid).toBe(false);
    expect(result.preview).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
