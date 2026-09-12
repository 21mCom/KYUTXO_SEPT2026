import { describe, expect, it } from "vitest";
import { calculateCoinOrigins, filterCoinOrigins, filterCoinOriginsByOwner, filterCoinOriginsByWallet, UNKNOWN_ORIGIN_ID } from "./coin-origins-core";
import { UNASSIGNED_OWNER_VALUE } from "./owner-constants";

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

  it("scopes acquisition lots to current allocations without counting the synthetic unknown holding", () => {
    const ledger = calculateCoinOrigins({
      addresses: [
        { inputString: "cold", type: "address", addressImportance: "manual", walletName: "Cold" },
        { inputString: "hot", type: "address", addressImportance: "manual", walletName: "Hot" },
      ],
      transactions: [
        { txid: "cold-acquisition", blockHeight: 1, blockTime: 100 },
        { txid: "hot-acquisition", blockHeight: 2, blockTime: 200 },
        { txid: "mixed", blockHeight: 3, blockTime: 300 },
      ],
      participants: [
        { txid: "cold-acquisition", role: "output", address: "cold", amount: 100, vout: 0 },
        { txid: "hot-acquisition", role: "output", address: "hot", amount: 200, vout: 0 },
        { txid: "mixed", role: "input", address: "cold", amount: 100, prevTxid: "cold-acquisition", prevVout: 0 },
        { txid: "mixed", role: "input", address: "", amount: 50, prevTxid: "missing", prevVout: 0 },
        { txid: "mixed", role: "output", address: "cold", amount: 150, vout: 0 },
      ],
    });

    const scoped = filterCoinOriginsByWallet(ledger, "Cold");

    expect(ledger.lots).toHaveLength(2);
    expect(scoped.lots.map((lot) => lot.lotId)).toEqual(["lot:cold-acquisition:0"]);
    expect(scoped.holdings.map((holding) => holding.lotId)).toEqual(["lot:cold-acquisition:0", UNKNOWN_ORIGIN_ID]);
    expect(scoped.holdings).toHaveLength(2);
    expect(scoped.summary.currentSats).toBe(150);
  });

  it("keeps acquisition metadata descriptive and scopes blank owners without inventing an owner", () => {
    const ledger = calculateCoinOrigins({
      addresses: [
        { inputString: "alice", addressImportance: "manual", walletName: "Shared", owner: "Alice" },
        { inputString: "blank", addressImportance: "manual", walletName: "Shared", owner: "  " },
      ],
      transactions: [
        { txid: "alice-in", blockTime: 100, acquisitionMethod: "purchase", costBasisUsd: 125.5 },
        { txid: "blank-in", blockTime: 200 },
      ],
      participants: [
        { txid: "alice-in", role: "output", address: "alice", amount: 100, vout: 0 },
        { txid: "blank-in", role: "output", address: "blank", amount: 200, vout: 0 },
      ],
    });
    expect(ledger.lots.find((lot) => lot.lotId === "lot:alice-in:0")).toMatchObject({
      acquisitionMethod: "purchase", costBasisUsd: 125.5, costProvenance: "provided",
    });
    expect(filterCoinOrigins(ledger, { owner: "Alice" }).summary.currentSats).toBe(100);
    expect(filterCoinOrigins(ledger, { owner: "" }).summary.currentSats).toBe(200);
  });

  it("stops attribution at a conservative equal-output CoinJoin boundary", () => {
    const ledger = calculateCoinOrigins({
      addresses: owned,
      transactions: [{ txid: "in", blockTime: 1 }, { txid: "mix", blockTime: 2 }],
      participants: [
        { txid: "in", role: "output", address: "owned", amount: 1_000, vout: 0 },
        { txid: "mix", role: "input", address: "owned", amount: 1_000, prevTxid: "in", prevVout: 0 },
        { txid: "mix", role: "input", address: "peer", amount: 1_000, prevTxid: "peer-in", prevVout: 0 },
        { txid: "mix", role: "input", address: "peer-2", amount: 1_000, prevTxid: "peer-2-in", prevVout: 0 },
        { txid: "mix", role: "output", address: "owned", amount: 900, vout: 0 },
        { txid: "mix", role: "output", address: "peer", amount: 900, vout: 1 },
        { txid: "mix", role: "output", address: "peer-2", amount: 900, vout: 2 },
      ],
    });
    expect(ledger.hops.find((hop) => hop.txid === "mix")).toMatchObject({ kind: "coinjoin", boundary: "unknown" });
    expect(ledger.outpoints[0]).toMatchObject({ boundary: "unknown", preMixTxids: ["in"] });
    expect(ledger.outpoints[0].allocations).toEqual([{ lotId: UNKNOWN_ORIGIN_ID, sats: 900 }]);
    expect(ledger.summary.currentSats).toBe(ledger.summary.allocatedSats);
  });

  it("does not mistake an ordinary equal payment and change for a CoinJoin", () => {
    const ledger = calculateCoinOrigins({
      addresses: owned,
      transactions: [{ txid: "a" }, { txid: "b" }, { txid: "spend" }],
      participants: [
        { txid: "a", role: "output", address: "owned", amount: 500, vout: 0 },
        { txid: "b", role: "output", address: "owned", amount: 500, vout: 0 },
        { txid: "spend", role: "input", address: "owned", amount: 500, prevTxid: "a", prevVout: 0 },
        { txid: "spend", role: "input", address: "owned", amount: 500, prevTxid: "b", prevVout: 0 },
        { txid: "spend", role: "output", address: "owned", amount: 500, vout: 0 },
        { txid: "spend", role: "output", address: "merchant", amount: 500, vout: 1 },
      ],
    });
    expect(ledger.hops.find((hop) => hop.txid === "spend")?.kind).not.toBe("coinjoin");
    expect(ledger.outpoints[0].allocations).toEqual([{ lotId: "lot:a:0", sats: 500 }]);
  });

  it("scopes holdings by selected owner, including the shared unassigned value", () => {
    const ledger = calculateCoinOrigins({
      addresses: [
        { inputString: "alice", type: "address", addressImportance: "manual", owner: "Alice" },
        { inputString: "blank", type: "address", addressImportance: "manual" },
      ],
      transactions: [{ txid: "fund", blockHeight: 1, blockTime: 100 }],
      participants: [
        { txid: "fund", role: "output", address: "alice", amount: 100, vout: 0 },
        { txid: "fund", role: "output", address: "blank", amount: 200, vout: 1 },
      ],
    });
    expect(filterCoinOriginsByOwner(ledger, ["Alice"]).summary.currentSats).toBe(100);
    expect(filterCoinOriginsByOwner(ledger, [UNASSIGNED_OWNER_VALUE]).summary.currentSats).toBe(200);
    expect(filterCoinOriginsByOwner(ledger, ["Alice", UNASSIGNED_OWNER_VALUE]).summary.currentSats).toBe(300);
  });
});