// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mockExploreAddress = vi.fn();
const mockCreateProvider = vi.fn();
const mockParseTransaction = vi.fn();

vi.mock("./use-node-settings", () => ({
  useNodeSettings: () => ({
    nodeSettings: {
      id: "default",
      providerType: "mempool-space",
      useTor: false,
      requestTimeout: 30000,
      network: "mainnet",
      allowLocalNetwork: false,
      trustedLocalHosts: [],
      useElectrum: false,
      electrumPort: 50001,
      electrumSSL: false,
    },
    isLoading: false,
  }),
}));

vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: (...args: unknown[]) => mockCreateProvider(...args),
  parseTransaction: (...args: unknown[]) => mockParseTransaction(...args),
}));

vi.mock("@/lib/provenance", () => ({
  exploreAddress: (...args: unknown[]) => mockExploreAddress(...args),
}));

vi.mock("@/lib/database", () => ({
  db: {
    records: {
      where: () => ({
        equalsIgnoreCase: () => ({ first: () => Promise.resolve(undefined) }),
      }),
    },
  },
}));

import { useFlowData } from "./use-flow-data";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useFlowData", () => {
  it("returns null flowData initially", () => {
    const { result } = renderHook(() => useFlowData());
    expect(result.current.flowData).toBeNull();
  });

  it("isLoading is false initially", () => {
    const { result } = renderHook(() => useFlowData());
    expect(result.current.isLoading).toBe(false);
  });

  it("error is null initially", () => {
    const { result } = renderHook(() => useFlowData());
    expect(result.current.error).toBeNull();
  });

  it("dataSource is null initially", () => {
    const { result } = renderHook(() => useFlowData());
    expect(result.current.dataSource).toBeNull();
  });

  it("exposes a fetchFlow function", () => {
    const { result } = renderHook(() => useFlowData());
    expect(typeof result.current.fetchFlow).toBe("function");
  });

  it("fetchFlow with local data sets dataSource to local", async () => {
    mockExploreAddress.mockResolvedValue({
      centerAddress: "bc1abc",
      centerNode: { address: "bc1abc", isLabeled: false },
      incoming: [
        {
          address: "bc1sender",
          isLabeled: false,
          edges: [
            { txid: "tx1", fromAddress: "bc1sender", toAddress: "bc1abc", amount: 50000, blockTime: 1700000000, blockHeight: 800000 },
          ],
          direction: "incoming",
          hopDistance: 1,
        },
      ],
      outgoing: [
        {
          address: "bc1receiver",
          isLabeled: false,
          edges: [
            { txid: "tx2", fromAddress: "bc1abc", toAddress: "bc1receiver", amount: 30000, blockTime: 1700001000, blockHeight: 800001 },
          ],
          direction: "outgoing",
          hopDistance: 1,
        },
      ],
      totalIncoming: 1,
      totalOutgoing: 1,
      filteredOut: 0,
    });

    const { result } = renderHook(() => useFlowData());

    await act(async () => {
      await result.current.fetchFlow("bc1abc", 1);
    });

    expect(result.current.dataSource).toBe("local");
    expect(result.current.flowData).not.toBeNull();
    expect(result.current.flowData!.stats.inputCount).toBe(1);
    expect(result.current.flowData!.stats.outputCount).toBe(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("fetchFlow populates nodes and links from local data", async () => {
    mockExploreAddress.mockResolvedValue({
      centerAddress: "bc1abc",
      centerNode: { address: "bc1abc", isLabeled: true, label: "My Wallet" },
      incoming: [
        {
          address: "bc1sender",
          isLabeled: false,
          edges: [
            { txid: "tx1", fromAddress: "bc1sender", toAddress: "bc1abc", amount: 100000, blockTime: 1700000000, blockHeight: 800000 },
          ],
          direction: "incoming",
          hopDistance: 1,
        },
      ],
      outgoing: [],
      totalIncoming: 1,
      totalOutgoing: 0,
      filteredOut: 0,
    });

    const { result } = renderHook(() => useFlowData());

    await act(async () => {
      await result.current.fetchFlow("bc1abc", 1);
    });

    const flowData = result.current.flowData!;
    expect(flowData.nodes.length).toBeGreaterThanOrEqual(2);

    const selectedNode = flowData.nodes.find((n) => n.type === "selected");
    expect(selectedNode).toBeDefined();
    expect(selectedNode!.address).toBe("bc1abc");

    const inputNode = flowData.nodes.find((n) => n.type === "input");
    expect(inputNode).toBeDefined();
    expect(inputNode!.address).toBe("bc1sender");
    expect(inputNode!.amount).toBe(100000 / 100000000);

    expect(flowData.links.length).toBeGreaterThanOrEqual(1);
    expect(flowData.stats.totalInputValue).toBe(100000 / 100000000);
  });

  it("fetchFlow without local data and blockchain disabled sets an error", async () => {
    mockExploreAddress.mockResolvedValue({
      centerAddress: "bc1abc",
      centerNode: null,
      incoming: [],
      outgoing: [],
      totalIncoming: 0,
      totalOutgoing: 0,
      filteredOut: 0,
    });

    const { result } = renderHook(() => useFlowData());

    await act(async () => {
      await result.current.fetchFlow("bc1abc", 1, false);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.error).toContain("No local data");
    expect(result.current.flowData).toBeNull();
    expect(result.current.dataSource).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("fetchFlow falls back to blockchain when no local data", async () => {
    mockExploreAddress.mockResolvedValue({
      centerAddress: "bc1abc",
      centerNode: null,
      incoming: [],
      outgoing: [],
      totalIncoming: 0,
      totalOutgoing: 0,
      filteredOut: 0,
    });

    const mockProvider = {
      getAddressTransactions: vi.fn().mockResolvedValue([
        { txid: "tx1", status: { block_time: 1700000000 } },
      ]),
    };
    mockCreateProvider.mockReturnValue(mockProvider);
    mockParseTransaction.mockReturnValue({
      txid: "tx1",
      blockTime: 1700000000,
      blockHeight: 800000,
      inputs: [{ address: "bc1sender", amount: 50000 }],
      outputs: [{ address: "bc1abc", amount: 49000 }],
    });

    const { result } = renderHook(() => useFlowData());

    await act(async () => {
      await result.current.fetchFlow("bc1abc", 1, true);
    });

    expect(result.current.dataSource).toBe("blockchain");
    expect(result.current.flowData).not.toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("fetchFlow sets error on blockchain API failure", async () => {
    mockExploreAddress.mockResolvedValue({
      centerAddress: "bc1abc",
      centerNode: null,
      incoming: [],
      outgoing: [],
      totalIncoming: 0,
      totalOutgoing: 0,
      filteredOut: 0,
    });

    const mockProvider = {
      getAddressTransactions: vi.fn().mockRejectedValue(new Error("Network error")),
    };
    mockCreateProvider.mockReturnValue(mockProvider);

    const { result } = renderHook(() => useFlowData());

    await act(async () => {
      await result.current.fetchFlow("bc1abc", 1, true);
    });

    expect(result.current.error).toBe("Network error");
    expect(result.current.flowData).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("fetchFlow sets error when local lookup throws", async () => {
    mockExploreAddress.mockRejectedValue(new Error("DB corrupt"));

    const mockProvider = {
      getAddressTransactions: vi.fn().mockResolvedValue([]),
    };
    mockCreateProvider.mockReturnValue(mockProvider);

    const { result } = renderHook(() => useFlowData());

    await act(async () => {
      await result.current.fetchFlow("bc1abc", 1, true);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.isLoading).toBe(false);
  });

  it("fetchFlow sets isLoading during the async operation", async () => {
    let resolveExplore: ((v: unknown) => void) | undefined;
    mockExploreAddress.mockImplementation(
      () => new Promise((resolve) => { resolveExplore = resolve; }),
    );

    const { result } = renderHook(() => useFlowData());

    let fetchPromise: Promise<void>;
    act(() => {
      fetchPromise = result.current.fetchFlow("bc1abc", 1, false);
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    await act(async () => {
      resolveExplore!({
        centerAddress: "bc1abc",
        centerNode: null,
        incoming: [],
        outgoing: [],
        totalIncoming: 0,
        totalOutgoing: 0,
        filteredOut: 0,
      });
      await fetchPromise!;
    });

    expect(result.current.isLoading).toBe(false);
  });
});
