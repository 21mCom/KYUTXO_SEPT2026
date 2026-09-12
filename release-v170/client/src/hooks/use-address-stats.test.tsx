// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";

import { useAddressStats } from "./use-address-stats";
import type { AddressStats } from "./use-address-stats";

type StatsRecord = {
  id?: number | string;
  type: string;
  inputString: string;
  cachedBalanceSats?: number;
  cachedTxCount?: number;
  cachedLastActivityTime?: number;
  statsComputedAt?: number;
};

const EMPTY_RECORDS: Array<StatsRecord> = [];
const TX_RECORDS: Array<StatsRecord> = [
  { id: 1, type: "transaction", inputString: "tx123" },
];

describe("useAddressStats", () => {
  it("exports the hook function", () => {
    expect(typeof useAddressStats).toBe("function");
  });

  it("AddressStats interface has the expected fields", () => {
    const stats: AddressStats = { balanceSats: 100, lastTxDate: 1000, txCount: 5, synced: true };
    expect(stats.balanceSats).toBe(100);
    expect(stats.lastTxDate).toBe(1000);
    expect(stats.txCount).toBe(5);
    expect(stats.synced).toBe(true);
  });

  it("returns empty map for empty records", () => {
    const { result } = renderHook(() => useAddressStats(EMPTY_RECORDS));
    expect(result.current.size).toBe(0);
  });

  it("returns empty map when enabled is false", () => {
    const records: StatsRecord[] = [
      { id: 1, type: "address", inputString: "addr", statsComputedAt: 1, cachedBalanceSats: 5 },
    ];
    const { result } = renderHook(() => useAddressStats(records, false));
    expect(result.current.size).toBe(0);
  });

  it("skips non-address records", () => {
    const { result } = renderHook(() => useAddressStats(TX_RECORDS, true));
    expect(result.current.size).toBe(0);
  });

  it("reads cached balance, txCount, and lastTxDate from the record", () => {
    const records: StatsRecord[] = [
      {
        id: 10,
        type: "address",
        inputString: "bc1addr1",
        cachedBalanceSats: 60000,
        cachedTxCount: 3,
        cachedLastActivityTime: 1700002000,
        statsComputedAt: 1700003000,
      },
    ];

    const { result } = renderHook(() => useAddressStats(records, true));

    const stats = result.current.get("10");
    expect(stats).toBeDefined();
    expect(stats!.balanceSats).toBe(60000);
    expect(stats!.txCount).toBe(3);
    expect(stats!.lastTxDate).toBe(1700002000);
    expect(stats!.synced).toBe(true);
  });

  it("marks records without statsComputedAt as not synced", () => {
    const records: StatsRecord[] = [
      { id: 11, type: "address", inputString: "bc1addr2" },
    ];

    const { result } = renderHook(() => useAddressStats(records, true));

    const stats = result.current.get("11");
    expect(stats).toBeDefined();
    expect(stats!.synced).toBe(false);
    expect(stats!.balanceSats).toBe(0);
  });

  it("skips records without valid ids", () => {
    const records: StatsRecord[] = [
      { id: undefined, type: "address", inputString: "no_id_addr", statsComputedAt: 1 },
      { id: 5, type: "address", inputString: "valid_addr", statsComputedAt: 1, cachedBalanceSats: 10000 },
    ];

    const { result } = renderHook(() => useAddressStats(records, true));

    expect(result.current.has("5")).toBe(true);
    expect(result.current.has("undefined")).toBe(false);
    expect(result.current.size).toBe(1);
  });
});
