import { describe, it, expect, beforeEach } from "vitest";
import {
  setPendingSyncAddresses,
  consumePendingSyncAddresses,
  hasPendingSyncAddresses,
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
