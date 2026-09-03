import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllRecords, createRecord } from "./record-crud";
import {
  addParticipant,
  addTransaction,
  clearParticipants,
  clearTransactions,
  countActionableTransactionCurations,
  getTransactionByTxid,
  queueTransactionForReview,
  updateTransactionCuration,
} from "./transaction-crud";

const txid = (char: string) => char.repeat(64);

beforeEach(async () => {
  await clearParticipants();
  await clearTransactions();
  await clearAllRecords();
});

describe("transaction curation", () => {
  it("queues an owned transaction exactly once", async () => {
    const recordId = await createRecord({
      type: "address",
      inputString: "bc1qowned",
      addressImportance: "manual",
    });
    await addTransaction({ txid: txid("a"), blockHeight: 1, blockTime: 1, syncedAt: 1 });
    await addParticipant({
      txid: txid("a"),
      role: "output",
      address: "bc1qowned",
      amount: 100,
      vout: 0,
      recordId,
    });

    expect(await queueTransactionForReview(txid("a"))).toBe(true);
    expect(await queueTransactionForReview(txid("a"))).toBe(false);
    expect((await getTransactionByTxid(txid("a")))?.curationState).toBe("new");
    expect(await countActionableTransactionCurations()).toBe(1);
  });

  it("does not queue a transaction that only touches discovered addresses", async () => {
    const recordId = await createRecord({
      type: "address",
      inputString: "bc1qexternal",
      addressImportance: "blockchain-discovered",
    });
    await addTransaction({ txid: txid("b"), blockHeight: 1, blockTime: 1, syncedAt: 1 });
    await addParticipant({
      txid: txid("b"),
      role: "output",
      address: "bc1qexternal",
      amount: 100,
      vout: 0,
      recordId,
    });

    expect(await queueTransactionForReview(txid("b"))).toBe(false);
    expect((await getTransactionByTxid(txid("b")))?.curationState).toBeUndefined();
  });

  it("recognizes owned spends through a blank-address Electrum prevout", async () => {
    const recordId = await createRecord({
      type: "address",
      inputString: "bc1qownedprevout",
      addressImportance: "wallet-import",
    });
    await addTransaction({ txid: txid("c"), blockHeight: 1, blockTime: 1, syncedAt: 1 });
    await addParticipant({
      txid: txid("c"),
      role: "output",
      address: "bc1qownedprevout",
      amount: 100,
      vout: 2,
      recordId,
    });
    await addTransaction({ txid: txid("d"), blockHeight: 2, blockTime: 2, syncedAt: 2 });
    await addParticipant({
      txid: txid("d"),
      role: "input",
      address: "",
      amount: 100,
      prevTxid: txid("c"),
      prevVout: 2,
    });

    expect(await queueTransactionForReview(txid("d"))).toBe(true);
    expect((await getTransactionByTxid(txid("d")))?.curationState).toBe("new");
  });

  it("classifies existing metadata as annotated and preserves explicit states", async () => {
    const recordId = await createRecord({
      type: "address",
      inputString: "bc1qownedmeta",
      addressImportance: "verified",
    });
    await createRecord({
      type: "transaction",
      inputString: txid("e"),
      label: "Already reviewed",
    });
    await addTransaction({ txid: txid("e"), blockHeight: 1, blockTime: 1, syncedAt: 1 });
    await addParticipant({
      txid: txid("e"),
      role: "output",
      address: "bc1qownedmeta",
      amount: 100,
      vout: 0,
      recordId,
    });

    expect(await queueTransactionForReview(txid("e"))).toBe(false);
    expect((await getTransactionByTxid(txid("e")))?.curationState).toBe("annotated");

    const until = Date.now() + 60_000;
    await updateTransactionCuration(txid("e"), "snoozed", { snoozedUntil: until });
    expect((await getTransactionByTxid(txid("e")))?.snoozedUntil).toBe(until);
    expect(await countActionableTransactionCurations()).toBe(0);

    await updateTransactionCuration(txid("e"), "new");
    expect((await getTransactionByTxid(txid("e")))?.curationState).toBe("new");
    expect(await countActionableTransactionCurations()).toBe(1);
  });
});