import { describe, expect, it } from "vitest";
import { createInMemoryEngineDb } from "../better-sqlite3-adapter";
import {
  createSchema,
  getCoinOrigins,
  insertParticipants,
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
});