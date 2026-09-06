import { describe, expect, it } from "vitest";
import { createInMemoryEngineDb } from "../better-sqlite3-adapter";
import {
  createSchema,
  getCoinOrigins,
  getCoinOriginsPage,
  getEngineMeta,
  insertParticipants,
  insertTransactionMetadata,
  insertRecords,
  insertTransactions,
  type ParticipantRow,
  type RecordRow,
  type TransactionRow,
} from "../engine-core";

function record(id: number, address: string, walletName: string): RecordRow {
  return {
    id,
    type: "address",
    inputString: address,
    inputStringLower: address.toLowerCase(),
    label: address,
    notes: null,
    owner: null,
    walletName,
    seedName: null,
    walletSoftware: null,
    addressImportance: "manual",
    chainType: null,
    syncDepth: null,
    firstSeenBlockTime: null,
    cachedBalanceSats: null,
    cachedTxCount: null,
    cachedUtxoCount: null,
    statsComputedAt: null,
    createdAt: id,
    updatedAt: id,
    tags: "[]",
    categories: "[]",
  };
}

function transaction(id: number, txid: string): TransactionRow {
  return { id, txid, blockHeight: id, blockTime: id * 60, fee: id === 1 ? 0 : 10, feeRate: 1, vsize: 100, hasOpReturn: 0 };
}

function output(id: number, txid: string, address: string, amount: number): ParticipantRow {
  return { id, txid, role: "output", address, amount, vout: 0, prevTxid: null, prevVout: null, recordId: 1, scriptType: "v0_p2wpkh" };
}

describe("native engine coin origins query", () => {
  it("calculates the same reconciled ledger in SQLite and honors wallet scope", () => {
    const db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, [record(1, "cold", "Cold"), record(2, "hot", "Hot")]);
    insertTransactions(db, [transaction(1, "a"), transaction(2, "b")]);
    insertParticipants(db, [
      output(1, "a", "cold", 1_000),
      { id: 2, txid: "b", role: "input", address: "cold", amount: 1_000, vout: null, prevTxid: "a", prevVout: 0, recordId: 1, scriptType: "v0_p2wpkh" },
      output(3, "b", "hot", 990),
    ]);

    const all = getCoinOrigins(db);
    const hot = getCoinOrigins(db, { walletName: "Hot" });

    expect(all.summary).toMatchObject({ currentSats: 990, feeSats: 10, reconciled: true });
    expect(hot.outpoints).toHaveLength(1);
    expect(hot.outpoints[0].walletName).toBe("Hot");
    expect(hot.holdings[0]).toMatchObject({ lotId: "lot:a:0", sats: 990 });
    expect(hot.lots.map((lot) => lot.lotId)).toEqual(["lot:a:0"]);
    expect(getCoinOriginsPage(db, { walletName: "Hot" }).lotsTotal).toBe(1);
    db.close();
  });

  it("applies mirrored acquisition metadata and bounded owner scope", () => {
    const db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, [{ ...record(1, "alice", "Shared"), owner: "Alice" }, { ...record(2, "blank", "Shared"), owner: "" }]);
    insertTransactions(db, [transaction(1, "arrival"), transaction(2, "other")]);
    insertTransactionMetadata(db, [{ id: 1, txid: "arrival", acquisitionMethod: "purchase", costBasisUsd: 50, updatedAt: 1 }]);
    insertParticipants(db, [output(1, "arrival", "alice", 100), output(2, "other", "blank", 200)]);
    // The legacy owner text remains the current scope identity; empty is a
    // deliberate unassigned scope, not a guessed default owner.
    expect(getCoinOrigins(db, { owner: "Alice" }).lots[0]).toMatchObject({
      acquisitionMethod: "purchase", costBasisUsd: 50, costProvenance: "provided",
    });
    expect(getCoinOriginsPage(db, { owner: "", limit: 10 }).summary.currentSats).toBe(200);
    db.close();
  });

  it("handles a representative chain in the native core without materializing persisted ledger state", () => {
    const db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, [record(1, "owned", "Scale")]);
    const transactions: TransactionRow[] = [];
    const participants: ParticipantRow[] = [];
    const size = 5_000;
    for (let i = 1; i <= size; i++) {
      const txid = `tx-${String(i).padStart(6, "0")}`;
      transactions.push({ id: i, txid, blockHeight: i, blockTime: i, fee: i === 1 ? 0 : 1, feeRate: 1, vsize: 100, hasOpReturn: 0 });
      if (i > 1) {
        participants.push({ id: participants.length + 1, txid, role: "input", address: "owned", amount: 10_001 - i, vout: null, prevTxid: `tx-${String(i - 1).padStart(6, "0")}`, prevVout: 0, recordId: 1, scriptType: null });
      }
      participants.push({ id: participants.length + 1, txid, role: "output", address: "owned", amount: 10_000 - i, vout: 0, prevTxid: null, prevVout: null, recordId: 1, scriptType: null });
    }
    insertTransactions(db, transactions);
    insertParticipants(db, participants);

    const ledger = getCoinOrigins(db);
    expect(ledger.outpoints).toHaveLength(1);
    expect(ledger.outpoints[0].hopTxids).toHaveLength(size);
    expect(ledger.summary.reconciled).toBe(true);
    expect(db.selectScalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'coinOrigin%'")).toBe(0);
    db.close();
  });

  it("windows broad multi-lot holdings and outpoints behind a fingerprint-keyed checkpoint", () => {
    const db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, [record(1, "owned", "Broad")]);
    const transactions: TransactionRow[] = [];
    const participants: ParticipantRow[] = [];
    const size = 1_000;
    for (let i = 1; i <= size; i++) {
      const txid = `acquire-${String(i).padStart(6, "0")}`;
      transactions.push({ id: i, txid, blockHeight: i, blockTime: i, fee: 0, feeRate: 0, vsize: 100, hasOpReturn: 0 });
      participants.push({ id: i, txid, role: "output", address: "owned", amount: i, vout: 0, prevTxid: null, prevVout: null, recordId: 1, scriptType: null });
    }
    insertTransactions(db, transactions);
    insertParticipants(db, participants);

    const first = getCoinOriginsPage(db, { limit: 10_000 });
    expect(first.holdingsTotal).toBe(size);
    expect(first.outpointsTotal).toBe(size);
    expect(first.holdings).toHaveLength(250);
    expect(first.outpoints).toHaveLength(250);
    expect(first.outpoints.every((row) => row.allocations.length === 0 && row.hopTxids.length === 0)).toBe(true);
    expect(first.holdingsHasMore).toBe(true);
    expect(first.outpointsHasMore).toBe(true);
    expect(getEngineMeta(db, "coin_origins_checkpoint_fingerprint")).toBe(first.checkpointKey);

    const second = getCoinOriginsPage(db, { holdingsOffset: 250, outpointsOffset: 250, limit: 250 });
    expect(second.checkpointKey).toBe(first.checkpointKey);
    expect(second.holdings[0].lotId).not.toBe(first.holdings[0].lotId);
    expect(second.outpoints[0].txid).not.toBe(first.outpoints[0].txid);

    insertTransactions(db, [{ id: size + 1, txid: "later", blockHeight: size + 1, blockTime: size + 1, fee: 0, feeRate: 0, vsize: 100, hasOpReturn: 0 }]);
    insertParticipants(db, [{ id: size + 1, txid: "later", role: "output", address: "owned", amount: 1, vout: 0, prevTxid: null, prevVout: null, recordId: 1, scriptType: null }]);
    expect(() => getCoinOriginsPage(db, {
      outpoint: "later:0",
      expectedCheckpointKey: first.checkpointKey,
    })).toThrow("checkpoint changed");
    const rebuilt = getCoinOriginsPage(db, { limit: 1 });
    expect(rebuilt.checkpointKey).not.toBe(first.checkpointKey);
    expect(rebuilt.outpointsTotal).toBe(size + 1);

    const detail = getCoinOriginsPage(db, { outpoint: "later:0" });
    expect(detail.outpoints).toHaveLength(1);
    expect(detail.outpoints[0].allocations).toHaveLength(1);
    expect(detail.detail?.hops.map((hop) => hop.txid)).toEqual(["later"]);
    db.close();
  });

  it("bounds a passport whose current outpoint consolidates hundreds of acquisition lots", () => {
    const db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, [record(1, "owned", "Broad")]);
    const lotCount = 300;
    const transactions: TransactionRow[] = [];
    const participants: ParticipantRow[] = [];
    for (let i = 1; i <= lotCount; i++) {
      const txid = `lot-${String(i).padStart(4, "0")}`;
      transactions.push({ id: i, txid, blockHeight: i, blockTime: i, fee: 0, feeRate: 0, vsize: 100, hasOpReturn: 0 });
      participants.push({ id: participants.length + 1, txid, role: "output", address: "owned", amount: 1, vout: 0, prevTxid: null, prevVout: null, recordId: 1, scriptType: null });
    }
    transactions.push({ id: lotCount + 1, txid: "consolidated", blockHeight: lotCount + 1, blockTime: lotCount + 1, fee: 0, feeRate: 0, vsize: 100, hasOpReturn: 0 });
    for (let i = 1; i <= lotCount; i++) {
      participants.push({
        id: participants.length + 1,
        txid: "consolidated",
        role: "input",
        address: "owned",
        amount: 1,
        vout: null,
        prevTxid: `lot-${String(i).padStart(4, "0")}`,
        prevVout: 0,
        recordId: 1,
        scriptType: null,
      });
    }
    participants.push({ id: participants.length + 1, txid: "consolidated", role: "output", address: "owned", amount: lotCount, vout: 0, prevTxid: null, prevVout: null, recordId: 1, scriptType: null });
    insertTransactions(db, transactions);
    insertParticipants(db, participants);

    const first = getCoinOriginsPage(db, { outpoint: "consolidated:0", limit: 100 });
    expect(first.outpoints[0].allocations).toHaveLength(100);
    expect(first.holdings).toHaveLength(100);
    expect(first.detail).toMatchObject({
      allocationsOffset: 0,
      allocationsTotal: lotCount,
      allocationsHasMore: true,
    });
    const last = getCoinOriginsPage(db, { outpoint: "consolidated:0", allocationsOffset: 200, limit: 100 });
    expect(last.outpoints[0].allocations).toHaveLength(100);
    expect(last.detail?.allocationsHasMore).toBe(false);
    db.close();
  });
});