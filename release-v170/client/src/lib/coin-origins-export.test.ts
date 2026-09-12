import { describe, expect, it } from "vitest";
import { calculateCoinOrigins } from "./coin-origins-core";
import { buildCoinOriginsCsv, buildCoinOriginsExportPayload } from "./coin-origins-export";

describe("coin origin exports", () => {
  it("exports the exact displayed allocations and sanitizes user-controlled CSV cells", () => {
    const ledger = calculateCoinOrigins({
      addresses: [{ inputString: "owned", addressImportance: "manual", walletName: "=danger" }],
      transactions: [{ txid: "a", blockHeight: 1, blockTime: 100 }],
      participants: [{ txid: "a", role: "output", address: "owned", amount: 2_500, vout: 0 }],
    });
    const payload = buildCoinOriginsExportPayload(ledger, { walletName: "=danger" });
    const csv = buildCoinOriginsCsv(payload);

    expect(csv).toContain("'=danger");
    expect(csv).toContain("lot:a:0");
    expect(csv).toContain(",2500");
    expect(payload.summary.currentSats).toBe(2_500);
    expect(payload.outpoints[0].allocations.reduce((sum, row) => sum + row.sats, 0)).toBe(2_500);
  });

  it("uses the same canonical payload for a selected Coin Passport", () => {
    const ledger = calculateCoinOrigins({
      addresses: [{ inputString: "owned", addressImportance: "manual" }],
      transactions: [
        { txid: "a", blockHeight: 1, blockTime: 100 },
        { txid: "b", blockHeight: 2, blockTime: 200 },
      ],
      participants: [
        { txid: "a", role: "output", address: "owned", amount: 1_000, vout: 0 },
        { txid: "b", role: "input", address: "owned", amount: 1_000, prevTxid: "a", prevVout: 0 },
        { txid: "b", role: "output", address: "owned", amount: 900, vout: 0 },
      ],
    });
    const payload = buildCoinOriginsExportPayload(ledger, { outpoint: "b:0" });

    expect(payload.title).toBe("Coin Passport");
    expect(payload.hops.map((hop) => hop.txid)).toEqual(["a", "b"]);
    expect(payload.summary.currentSats).toBe(900);
    expect(buildCoinOriginsCsv(payload)).toContain("b:0");
  });

  it("keeps unknown lot certainty in selected passport totals", () => {
    const ledger = calculateCoinOrigins({
      addresses: [{ inputString: "owned", addressImportance: "manual" }],
      transactions: [
        { txid: "receive", blockHeight: 1, blockTime: 100 },
        { txid: "move", blockHeight: 2, blockTime: 200 },
      ],
      participants: [
        { txid: "receive", role: "input", address: "", amount: 1_000, prevTxid: "outside", prevVout: 0 },
        { txid: "receive", role: "output", address: "owned", amount: 900, vout: 0 },
        { txid: "move", role: "input", address: "owned", amount: 900, prevTxid: "receive", prevVout: 0 },
        { txid: "move", role: "output", address: "owned", amount: 800, vout: 0 },
      ],
    });
    const payload = buildCoinOriginsExportPayload(ledger, { outpoint: "move:0" });
    expect(payload.summary).toMatchObject({ currentSats: 800, unknownSats: 800, knownSats: 0 });
  });

  it("keeps an ancestor conservation failure visible in a descendant passport", () => {
    const ledger = calculateCoinOrigins({
      addresses: [{ inputString: "owned", addressImportance: "manual" }],
      transactions: [
        { txid: "bad", blockHeight: 1, blockTime: 100 },
        { txid: "child", blockHeight: 2, blockTime: 200 },
      ],
      participants: [
        { txid: "bad", role: "input", address: "", amount: 500, prevTxid: "outside", prevVout: 0 },
        { txid: "bad", role: "output", address: "owned", amount: 600, vout: 0 },
        { txid: "child", role: "input", address: "owned", amount: 600, prevTxid: "bad", prevVout: 0 },
        { txid: "child", role: "output", address: "owned", amount: 600, vout: 0 },
      ],
    });
    const payload = buildCoinOriginsExportPayload(ledger, { outpoint: "child:0" });
    expect(payload.hops.map((hop) => hop.reconciled)).toEqual([false, true]);
    expect(payload.summary.reconciled).toBe(false);
  });
});