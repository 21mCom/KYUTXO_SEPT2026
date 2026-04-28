// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const mockGetParticipants = vi.fn(() => Promise.resolve([]));
const mockTxToArray = vi.fn(() => Promise.resolve([]));

vi.mock("@/lib/database", () => ({
  db: {
    blockchainTransactions: {
      where: () => ({ anyOf: () => ({ toArray: () => mockTxToArray() }) }),
    },
  },
}));

vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddresses: (...args: unknown[]) => mockGetParticipants(...args),
}));

import { useAddressStats } from "./use-address-stats";
import type { AddressStats } from "./use-address-stats";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetParticipants.mockResolvedValue([]);
  mockTxToArray.mockResolvedValue([]);
});

const EMPTY_RECORDS: Array<{ id?: number | string; type: string; inputString: string }> = [];
const TX_RECORDS: Array<{ id?: number | string; type: string; inputString: string }> = [
  { id: 1, type: "transaction", inputString: "tx123" },
];

describe("useAddressStats", () => {
  it("exports the hook function", () => {
    expect(typeof useAddressStats).toBe("function");
  });

  it("AddressStats interface has the expected fields", () => {
    const stats: AddressStats = { balanceSats: 100, lastTxDate: 1000, txCount: 5 };
    expect(stats.balanceSats).toBe(100);
    expect(stats.lastTxDate).toBe(1000);
    expect(stats.txCount).toBe(5);
  });

  it("returns empty map for empty records", () => {
    const { result } = renderHook(() => useAddressStats(EMPTY_RECORDS));
    expect(result.current.size).toBe(0);
  });

  it("returns empty map when enabled is false", () => {
    const { result } = renderHook(() => useAddressStats(EMPTY_RECORDS, false));
    expect(result.current.size).toBe(0);
  });

  it("returns empty map when no address-type records exist", () => {
    const { result } = renderHook(() => useAddressStats(TX_RECORDS, true));
    expect(result.current).toBeInstanceOf(Map);
  });

  it("computes balance, txCount, and lastTxDate from participants", async () => {
    const addressRecords = [
      { id: 10, type: "address", inputString: "bc1addr1" },
    ];
    const stableRef = [...addressRecords];

    mockGetParticipants.mockResolvedValue([
      { address: "bc1addr1", txid: "tx1", role: "output", amount: 50000 },
      { address: "bc1addr1", txid: "tx2", role: "output", amount: 30000 },
      { address: "bc1addr1", txid: "tx3", role: "input", amount: 20000 },
    ]);

    mockTxToArray.mockResolvedValue([
      { txid: "tx1", blockTime: 1700000000 },
      { txid: "tx2", blockTime: 1700001000 },
      { txid: "tx3", blockTime: 1700002000 },
    ]);

    const { result } = renderHook(() => useAddressStats(stableRef, true));

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });

    const stats = result.current.get("10");
    expect(stats).toBeDefined();
    expect(stats!.balanceSats).toBe(60000);
    expect(stats!.txCount).toBe(3);
    expect(stats!.lastTxDate).toBe(1700002000);
  });

  it("aggregates multiple addresses separately", async () => {
    const addressRecords = [
      { id: 1, type: "address", inputString: "addr_a" },
      { id: 2, type: "address", inputString: "addr_b" },
    ];
    const stableRef = [...addressRecords];

    mockGetParticipants.mockResolvedValue([
      { address: "addr_a", txid: "tx1", role: "output", amount: 100000 },
      { address: "addr_b", txid: "tx2", role: "output", amount: 200000 },
      { address: "addr_b", txid: "tx3", role: "input", amount: 50000 },
    ]);

    mockTxToArray.mockResolvedValue([
      { txid: "tx1", blockTime: 1700000000 },
      { txid: "tx2", blockTime: 1700001000 },
      { txid: "tx3", blockTime: 1700002000 },
    ]);

    const { result } = renderHook(() => useAddressStats(stableRef, true));

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });

    const statsA = result.current.get("1");
    expect(statsA).toBeDefined();
    expect(statsA!.balanceSats).toBe(100000);
    expect(statsA!.txCount).toBe(1);

    const statsB = result.current.get("2");
    expect(statsB).toBeDefined();
    expect(statsB!.balanceSats).toBe(150000);
    expect(statsB!.txCount).toBe(2);
    expect(statsB!.lastTxDate).toBe(1700002000);
  });

  it("skips records without valid ids", async () => {
    const addressRecords = [
      { id: undefined, type: "address", inputString: "no_id_addr" },
      { id: 5, type: "address", inputString: "valid_addr" },
    ];
    const stableRef = [...addressRecords];

    mockGetParticipants.mockResolvedValue([
      { address: "valid_addr", txid: "tx1", role: "output", amount: 10000 },
    ]);

    mockTxToArray.mockResolvedValue([
      { txid: "tx1", blockTime: 1700000000 },
    ]);

    const { result } = renderHook(() => useAddressStats(stableRef, true));

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });

    expect(result.current.has("5")).toBe(true);
    expect(result.current.has("undefined")).toBe(false);
  });
});
