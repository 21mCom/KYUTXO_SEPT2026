import { describe, expect, it } from "vitest";
import { calculateCoinOrigins, UNKNOWN_ORIGIN_ID } from "./coin-origins-core";

const owned = [{ inputString: "owned", type: "address", addressImportance: "manual", walletName: "Cold" }];

describe("coin origins ledger", () => {
  it("reconciles an acquisition, partial spend, external disposal, and fee exactly", () => {
    const ledger = calculateCoinOrigins({
      addresses: owned,
      transactions: [
        { txid: "a", blockHeight: 1, blockTime: 100, fee: 0 },
        { txid: "b", blockHeight: 2, blockTime: 200, fee: 100 },
      ],
      participants: [
        { id: 1, txid: "a", role: "output", address: "owned", amount: 10_000, vout: 0 },
        { id: 2, txid: "b", role: "input", address: "owned", amount: 10_000, prevTxid: "a", prevVout: 0 },
        { id: 3, txid: "b", role: "output", address: "owned", amount: 5_900, vout: 0 },
        { id: 4, txid: "b", role: "output", address: "merchant", amount: 4_000, vout: 1 },
      ],
    });

    expect(ledger.summary).toMatchObject({
      currentSats: 5_900,
      allocatedSats: 5_900,
      unknownSats: 0,
      disposedSats: 4_000,
      feeSats: 100,
      acquisitionSats: 10_000,
      reconciled: true,
    });
    expect(ledger.outpoints[0].allocations).toEqual([{ lotId: "lot:a:0", sats: 5_900 }]);
    expect(ledger.outpoints[0].hopTxids).toEqual(["a", "b"]);
    expect(ledger.disposals.find((d) => d.kind === "fee")?.allocations).toEqual([
      { lotId: "lot:a:0", sats: 100 },
    ]);
    expect(ledger.hops.find((h) => h.txid === "b")?.kind).toBe("partial-spend");
  });

  it("preserves both lots through consolidation with deterministic integer remainders", () => {
    const input = {
      addresses: owned,
      transactions: [
        { txid: "a", blockHeight: 1, blockTime: 100 },
        { txid: "b", blockHeight: 2, blockTime: 200 },
        { txid: "c", blockHeight: 3, blockTime: 300, fee: 500 },
      ],
      participants: [
        { id: 1, txid: "a", role: "output" as const, address: "owned", amount: 6_000, vout: 0 },
        { id: 2, txid: "b", role: "output" as const, address: "owned", amount: 4_000, vout: 0 },
        { id: 3, txid: "c", role: "input" as const, address: "owned", amount: 6_000, prevTxid: "a", prevVout: 0 },
        { id: 4, txid: "c", role: "input" as const, address: "owned", amount: 4_000, prevTxid: "b", prevVout: 0 },
        { id: 5, txid: "c", role: "output" as const, address: "owned", amount: 9_500, vout: 0 },
      ],
    };
    const first = calculateCoinOrigins(input);
    const second = calculateCoinOrigins(input);

    expect(first).toEqual(second);
    expect(first.outpoints[0].allocations).toEqual([
      { lotId: "lot:a:0", sats: 5_500 },
      { lotId: "lot:b:0", sats: 4_000 },
    ]);
    expect(first.hops.find((h) => h.txid === "c")?.kind).toBe("consolidation");
    expect(first.summary.reconciled).toBe(true);
  });

  it("keeps unresolved and mixed prevouts visibly unknown instead of inventing provenance", () => {
    const ledger = calculateCoinOrigins({
      addresses: owned,
      transactions: [
        { txid: "known", blockHeight: 1, blockTime: 100 },
        { txid: "mix", blockHeight: 2, blockTime: 200 },
      ],
      participants: [
        { id: 1, txid: "known", role: "output", address: "owned", amount: 2_000, vout: 0 },
        { id: 2, txid: "mix", role: "input", address: "owned", amount: 2_000, prevTxid: "known", prevVout: 0 },
        { id: 3, txid: "mix", role: "input", address: "", amount: 3_000, prevTxid: "missing", prevVout: 7 },
        { id: 4, txid: "mix", role: "output", address: "owned", amount: 4_900, vout: 0 },
      ],
    });
    const output = ledger.outpoints[0];

    expect(output.boundary).toBe("mixed");
    expect(output.allocations).toEqual([
      { lotId: "lot:known:0", sats: 1_900 },
      { lotId: UNKNOWN_ORIGIN_ID, sats: 3_000 },
    ]);
    expect(ledger.summary.unknownSats).toBe(3_000);
    expect(ledger.summary.reconciled).toBe(true);
  });

  it("starts a visibly-unknown acquisition lot at the wallet boundary without charging the sender's fee", () => {
    const ledger = calculateCoinOrigins({
      addresses: owned,
      transactions: [{ txid: "receive", blockHeight: 3, blockTime: 300, fee: 100 }],
      participants: [
        { txid: "receive", role: "input", address: "", amount: 5_000, prevTxid: "outside", prevVout: 2 },
        { txid: "receive", role: "output", address: "owned", amount: 4_900, vout: 0 },
      ],
    });

    expect(ledger.lots[0]).toMatchObject({
      lotId: "lot:receive:0",
      acquiredSats: 4_900,
      sourceBoundary: "unknown",
    });
    expect(ledger.outpoints[0]).toMatchObject({ boundary: "unknown" });
    expect(ledger.outpoints[0].allocations).toEqual([{ lotId: "lot:receive:0", sats: 4_900 }]);
    expect(ledger.summary.feeSats).toBe(0);
    expect(ledger.summary.disposedSats).toBe(0);
  });

  it("propagates unknown acquisition certainty through descendants and their fees", () => {
    const ledger = calculateCoinOrigins({
      addresses: owned,
      transactions: [
        { txid: "receive", blockHeight: 1, blockTime: 100 },
        { txid: "move", blockHeight: 2, blockTime: 200 },
      ],
      participants: [
        { txid: "receive", role: "input", address: "", amount: 5_000, prevTxid: "outside", prevVout: 1 },
        { txid: "receive", role: "output", address: "owned", amount: 4_900, vout: 0 },
        { txid: "move", role: "input", address: "owned", amount: 4_900, prevTxid: "receive", prevVout: 0 },
        { txid: "move", role: "output", address: "owned", amount: 4_800, vout: 0 },
      ],
    });

    expect(ledger.outpoints[0].boundary).toBe("unknown");
    expect(ledger.hops.find((hop) => hop.txid === "move")?.boundary).toBe("unknown");
    expect(ledger.disposals.find((row) => row.txid === "move" && row.kind === "fee")?.boundary).toBe("unknown");
    expect(ledger.summary).toMatchObject({ unknownSats: 4_800, knownSats: 0 });
  });

  it("marks malformed transaction conservation as unreconciled", () => {
    const ledger = calculateCoinOrigins({
      addresses: owned,
      transactions: [{ txid: "bad", blockHeight: 1, blockTime: 100 }],
      participants: [
        { txid: "bad", role: "input", address: "", amount: 500, prevTxid: "missing", prevVout: 0 },
        { txid: "bad", role: "output", address: "owned", amount: 600, vout: 0 },
      ],
    });

    expect(ledger.hops[0]).toMatchObject({ reconciled: false, residualSats: -100 });
    expect(ledger.summary.reconciled).toBe(false);
  });

  it("updates incrementally when a later spend is added without changing historical identities", () => {
    const base = {
      addresses: owned,
      transactions: [{ txid: "a", blockHeight: 1, blockTime: 100 }],
      participants: [{ id: 1, txid: "a", role: "output" as const, address: "owned", amount: 1_000, vout: 0 }],
    };
    const before = calculateCoinOrigins(base);
    const after = calculateCoinOrigins({
      ...base,
      transactions: [...base.transactions, { txid: "b", blockHeight: 2, blockTime: 200 }],
      participants: [
        ...base.participants,
        { id: 2, txid: "b", role: "input" as const, address: "owned", amount: 1_000, prevTxid: "a", prevVout: 0 },
        { id: 3, txid: "b", role: "output" as const, address: "owned", amount: 900, vout: 0 },
      ],
    });

    expect(before.outpoints.map((o) => `${o.txid}:${o.vout}`)).toEqual(["a:0"]);
    expect(after.outpoints.map((o) => `${o.txid}:${o.vout}`)).toEqual(["b:0"]);
    expect(after.outpoints[0].allocations[0].lotId).toBe(before.outpoints[0].allocations[0].lotId);
  });
});