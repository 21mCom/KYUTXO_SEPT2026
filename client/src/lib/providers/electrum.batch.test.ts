// Coverage for ElectrumProvider's Address Checker batch fast-path:
// getAddressTxCountsBatch (one IPC round-trip per address chunk, per-address
// failures reported in the map) and getAddressBalanceSats (cheap single-call
// balance). The Electron IPC boundary is mocked; everything above it is real.

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  electrumBatchGetHistory: vi.fn(),
  electrumGetUtxos: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getElectronAPI: () => mockApi,
}));

const { ElectrumProvider } = await import("./electrum");

const ADDR_A = "bc1qaaaa";
const ADDR_B = "bc1qbbbb";
const ADDR_C = "bc1qcccc";

describe("ElectrumProvider batch fast-path", () => {
  let provider: InstanceType<typeof ElectrumProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ElectrumProvider("electrum.example.com", 50001, false, 5000);
  });

  it("maps batch history results to tx counts, per-address errors kept separate", async () => {
    mockApi.electrumBatchGetHistory.mockResolvedValue({
      success: true,
      results: [
        { address: ADDR_A, success: true, history: [{ tx_hash: "t1", height: 1 }, { tx_hash: "t2", height: 2 }] },
        { address: ADDR_B, success: true, history: [] },
        { address: ADDR_C, success: false, error: "server hiccup", history: [] },
      ],
    });

    const counts = await provider.getAddressTxCountsBatch([ADDR_A, ADDR_B, ADDR_C]);
    expect(counts.get(ADDR_A)).toBe(2);
    expect(counts.get(ADDR_B)).toBe(0);
    expect(counts.get(ADDR_C)).toEqual({ error: "server hiccup" });
    expect(mockApi.electrumBatchGetHistory).toHaveBeenCalledTimes(1);
    expect(mockApi.electrumBatchGetHistory.mock.calls[0][0].addresses).toEqual([
      ADDR_A,
      ADDR_B,
      ADDR_C,
    ]);
  });

  it("throws when the whole batch fails so callers can fall back per-address", async () => {
    mockApi.electrumBatchGetHistory.mockResolvedValue({
      success: false,
      error: "connection refused",
      results: [],
    });
    await expect(provider.getAddressTxCountsBatch([ADDR_A])).rejects.toThrow(
      "connection refused",
    );
  });

  it("getAddressBalanceSats sums unspent outputs", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue({
      success: true,
      utxos: [{ value: 1500 }, { value: 2500 }, {}],
    });
    await expect(provider.getAddressBalanceSats(ADDR_A)).resolves.toBe(4000);
  });

  it("getAddressBalanceSats surfaces failures", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue({ success: false, error: "nope", utxos: [] });
    await expect(provider.getAddressBalanceSats(ADDR_A)).rejects.toThrow("nope");
  });
});
