import { describe, it, expect, beforeEach } from "vitest";
import {
  setPendingSyncAddresses,
  consumePendingSyncAddresses,
  hasPendingSyncAddresses,
  partitionTargetedAddresses,
} from "./pendingSyncTargets";

describe("pendingSyncTargets", () => {
  beforeEach(() => {
    // Clear any leftover state between tests.
    consumePendingSyncAddresses();
  });

  it("returns null when nothing is queued", () => {
    expect(hasPendingSyncAddresses()).toBe(false);
    expect(consumePendingSyncAddresses()).toBeNull();
  });

  it("queues and consumes addresses once", () => {
    setPendingSyncAddresses(["bc1qaaa", "bc1qbbb"]);
    expect(hasPendingSyncAddresses()).toBe(true);
    expect(consumePendingSyncAddresses()).toEqual(["bc1qaaa", "bc1qbbb"]);
    // Consuming clears the queue.
    expect(hasPendingSyncAddresses()).toBe(false);
    expect(consumePendingSyncAddresses()).toBeNull();
  });

  it("trims, drops blanks, and de-duplicates case-insensitively (first-seen casing wins)", () => {
    setPendingSyncAddresses(["  bc1qAAA  ", "bc1qaaa", "", "   ", "bc1qBBB"]);
    expect(consumePendingSyncAddresses()).toEqual(["bc1qAAA", "bc1qBBB"]);
  });

  it("clears the queue when given an empty or blank-only list", () => {
    setPendingSyncAddresses(["bc1qaaa"]);
    setPendingSyncAddresses(["   ", ""]);
    expect(hasPendingSyncAddresses()).toBe(false);
    expect(consumePendingSyncAddresses()).toBeNull();
  });
});

describe("partitionTargetedAddresses", () => {
  it("returns no skipped when every flagged address matched a record", () => {
    const matched = new Set(["bc1qaaa", "bc1qbbb"]);
    const { requested, skipped } = partitionTargetedAddresses(["bc1qaaa", "bc1qbbb"], matched);
    expect(requested).toEqual(["bc1qaaa", "bc1qbbb"]);
    expect(skipped).toEqual([]);
  });

  it("flags addresses that have no matching record as skipped", () => {
    const matched = new Set(["bc1qaaa"]);
    const { requested, skipped } = partitionTargetedAddresses(["bc1qaaa", "bc1qbbb"], matched);
    expect(requested).toEqual(["bc1qaaa", "bc1qbbb"]);
    expect(skipped).toEqual(["bc1qbbb"]);
  });

  it("reports every flagged address as skipped when none matched", () => {
    const { skipped } = partitionTargetedAddresses(["bc1qaaa", "bc1qbbb"], new Set());
    expect(skipped).toEqual(["bc1qaaa", "bc1qbbb"]);
  });

  it("matches case-insensitively but keeps original casing in skipped output", () => {
    // The DB stores inputStringLower, so the match set is lowercase.
    const matched = new Set(["bc1qaaa"]);
    const { skipped } = partitionTargetedAddresses(["BC1QAAA", "BC1QBBB"], matched);
    expect(skipped).toEqual(["BC1QBBB"]);
  });

  it("trims, drops blanks, and de-duplicates (first-seen casing wins)", () => {
    const { requested, skipped } = partitionTargetedAddresses(
      ["  bc1qAAA  ", "bc1qaaa", "", "   ", "bc1qBBB"],
      new Set(),
    );
    // Lowercased + de-duplicated requested keys.
    expect(requested).toEqual(["bc1qaaa", "bc1qbbb"]);
    // Skipped preserves first-seen original casing.
    expect(skipped).toEqual(["bc1qAAA", "bc1qBBB"]);
  });
});
