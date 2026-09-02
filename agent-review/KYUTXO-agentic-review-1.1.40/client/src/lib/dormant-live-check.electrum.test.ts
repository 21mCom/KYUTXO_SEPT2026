// Electron-side coverage for the Electrum strategy of the Dormant Coins
// per-row "Check node" action.
//
// The browser check (scripts/check-dormant-live-check-browser.mjs) covers the
// Esplora outspend path end-to-end; the Electrum strategy
// (checkOutpointLive → ElectrumProvider.getAddressUtxoOutpoints →
// electrumGetUtxos IPC) only runs in the desktop app and was previously
// exercised only through jsdom provider stubs. These tests wire the REAL
// ElectrumProvider (only the Electron IPC boundary is mocked) into the real
// checkOutpointLive so a regression in either layer — the listunspent →
// outpoint mapping (tx_hash/tx_pos → txid/vout) or the exact-outpoint
// matching — is caught here:
//   - outpoint present in listunspent            → "unspent";
//   - outpoint absent (spent since funding)      → "spent";
//   - same txid but different vout listed        → "spent" (no txid-only match);
//   - address-less output                        → throws before any IPC call;
//   - IPC/node failure                           → propagates the error;
//   - pre-aborted signal                         → throws without an IPC call.

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  electrumGetUtxos: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getElectronAPI: () => mockApi,
}));

const { ElectrumProvider } = await import("./providers/electrum");
const { checkOutpointLive } = await import("./dormant-live-check");

const TXID = "ab".repeat(32);
const OTHER_TXID = "cd".repeat(32);
const ADDRESS = "bc1qdormantelectrumtest" + "x".repeat(19);

function makeProvider() {
  return new ElectrumProvider("umbrel.local", 50001);
}

function utxosResult(utxos: Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>) {
  return { success: true, utxos };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkOutpointLive over ElectrumProvider (listunspent strategy)", () => {
  it("reports unspent when the exact outpoint is in the address's listunspent set", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue(
      utxosResult([
        { tx_hash: OTHER_TXID, tx_pos: 0, value: 1_000, height: 700_000 },
        { tx_hash: TXID, tx_pos: 1, value: 50_000, height: 650_000 },
      ]),
    );

    const result = await checkOutpointLive(makeProvider(), {
      txid: TXID,
      vout: 1,
      address: ADDRESS,
    });

    expect(result).toEqual({ status: "unspent" });
    expect(mockApi.electrumGetUtxos).toHaveBeenCalledTimes(1);
    expect(mockApi.electrumGetUtxos).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "umbrel.local",
        port: 50001,
        address: ADDRESS,
      }),
    );
  });

  it("reports spent when the outpoint is absent from the listunspent set", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue(
      utxosResult([{ tx_hash: OTHER_TXID, tx_pos: 0, value: 1_000, height: 700_000 }]),
    );

    const result = await checkOutpointLive(makeProvider(), {
      txid: TXID,
      vout: 1,
      address: ADDRESS,
    });

    // Electrum has no spender-txid information — status only.
    expect(result).toEqual({ status: "spent" });
  });

  it("does not match on txid alone — a different vout of the same tx counts as spent", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue(
      utxosResult([{ tx_hash: TXID, tx_pos: 0, value: 50_000, height: 650_000 }]),
    );

    const result = await checkOutpointLive(makeProvider(), {
      txid: TXID,
      vout: 1,
      address: ADDRESS,
    });

    expect(result).toEqual({ status: "spent" });
  });

  it("reports spent when the address has no unspent outputs at all", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue(utxosResult([]));

    const result = await checkOutpointLive(makeProvider(), {
      txid: TXID,
      vout: 0,
      address: ADDRESS,
    });

    expect(result).toEqual({ status: "spent" });
  });

  it("throws on an address-less output without contacting the node", async () => {
    await expect(
      checkOutpointLive(makeProvider(), { txid: TXID, vout: 0, address: "" }),
    ).rejects.toThrow(/no address.*cannot be verified over Electrum/i);
    expect(mockApi.electrumGetUtxos).not.toHaveBeenCalled();
  });

  it("propagates a node failure instead of guessing a status", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue({
      success: false,
      utxos: [],
      error: "Connection refused",
    });

    await expect(
      checkOutpointLive(makeProvider(), { txid: TXID, vout: 0, address: ADDRESS }),
    ).rejects.toThrow("Connection refused");
  });

  it("propagates a generic failure message when the IPC result carries no error text", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue({ success: false, utxos: [] });

    await expect(
      checkOutpointLive(makeProvider(), { txid: TXID, vout: 0, address: ADDRESS }),
    ).rejects.toThrow(/Failed to get address UTXOs via Electrum/);
  });

  it("throws immediately on a pre-aborted signal without an IPC call", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      checkOutpointLive(
        makeProvider(),
        { txid: TXID, vout: 0, address: ADDRESS },
        controller.signal,
      ),
    ).rejects.toThrow("Check cancelled");
    expect(mockApi.electrumGetUtxos).not.toHaveBeenCalled();
  });

  it("maps tx_hash/tx_pos/value from the IPC shape into txid/vout/valueSats", async () => {
    mockApi.electrumGetUtxos.mockResolvedValue(
      utxosResult([{ tx_hash: TXID, tx_pos: 3, value: 12_345, height: 1 }]),
    );

    const provider = makeProvider();
    const outpoints = await provider.getAddressUtxoOutpoints(ADDRESS);
    expect(outpoints).toEqual([{ txid: TXID, vout: 3, valueSats: 12_345 }]);
  });
});
