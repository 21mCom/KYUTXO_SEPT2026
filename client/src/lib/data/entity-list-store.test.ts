import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setActiveEntityList,
  resetActiveEntityList,
  type EntityEntry,
} from "../privacy-entity-list";
import {
  buildEntitySnapshotPreview,
  prepareEntitySnapshot,
} from "./entity-list-store";

// Real, known-valid mainnet Bitcoin addresses drawn from the bundled list so
// they pass validateAddress() inside prepareEntitySnapshot.
const ADDR = {
  binance: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  binanceCold: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
  bitstamp: "12cgpFdJViXbwHbhrA3TuW1EGnL25Zqc3P",
  gambling1: "18WsHUKZ3D6DPTjWcDGS99E1uL2xYaxDaW",
  gambling2: "1NGSrBs4BAazQRfD3PafjHB9jwJocoNy6i",
} as const;

function entry(
  address: string,
  category: EntityEntry["category"],
  name = "Test",
): EntityEntry {
  return { address, name, category };
}

describe("buildEntitySnapshotPreview", () => {
  afterEach(() => {
    // Avoid leaking the imported active list into other tests / suites.
    resetActiveEntityList();
  });

  it("treats every incoming address as added when the current list is empty", () => {
    setActiveEntityList([]);
    const incoming = [
      entry(ADDR.binance, "exchange"),
      entry(ADDR.gambling1, "gambling"),
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
      entry(ADDR.binance, "exchange"),
      entry(ADDR.binanceCold, "exchange"),
    ]);
    const incoming = [
      entry(ADDR.gambling1, "gambling"),
      entry(ADDR.gambling2, "gambling"),
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
      entry(ADDR.binance, "exchange"),
      entry(ADDR.binanceCold, "exchange"),
      entry(ADDR.bitstamp, "exchange"),
    ]);
    // Incoming: binance (shared), bitstamp (shared), gambling1 (new)
    const incoming = [
      entry(ADDR.binance, "exchange"),
      entry(ADDR.bitstamp, "exchange"),
      entry(ADDR.gambling1, "gambling"),
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
      entry(ADDR.binance, "exchange"),
      entry(ADDR.gambling1, "gambling"),
    ];
    setActiveEntityList(list);

    const preview = buildEntitySnapshotPreview([
      entry(ADDR.binance, "exchange"),
      entry(ADDR.gambling1, "gambling"),
    ]);

    expect(preview.added).toBe(0);
    expect(preview.removed).toBe(0);
    expect(preview.unchanged).toBe(2);
  });

  it("produces a per-category breakdown only for categories present on either side", () => {
    setActiveEntityList([
      entry(ADDR.binance, "exchange"),
      entry(ADDR.binanceCold, "exchange"),
    ]);
    const incoming = [
      entry(ADDR.binance, "exchange"), // shared exchange
      entry(ADDR.gambling1, "gambling"), // new gambling
      entry(ADDR.gambling2, "gambling"), // new gambling
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
    setActiveEntityList([entry(ADDR.binance, "exchange")]);
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
    expect(result.preview!.unchanged).toBe(1); // binance
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
    expect(result.preview!.unchanged).toBe(1);
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
