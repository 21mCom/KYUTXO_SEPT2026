// @vitest-environment jsdom
//
// Behaviour tests for the FULLY-BLANK live-input ordinal pairing in the legacy
// (pre-v3) MERGE restore (task: prevent duplicate input rows when a restored
// backup resolves an outpoint the live row never knew).
//
// A live input row with NEITHER an address NOR a resolved prevout (only
// txid+role='input') has no key-based identity, so a richer backup input that
// carries prevTxid/prevVout could never be matched to it and was previously
// ADDED as a separate row — two rows for one logical spend. The fix pairs blank
// live inputs with unmatched backup input outpoints ORDINALLY, but only when
// the counts are exactly equal (unambiguous); when they differ, the old
// add-a-new-row behaviour is deliberately kept.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { restoreLegacyTransactions } from "./legacy-restore";
import { clearAllRecords } from "@/lib/data/record-crud";
import {
  clearTransactions,
  clearParticipants,
  bulkAddTransactions,
  bulkAddParticipants,
  getAllTransactionParticipants,
} from "@/lib/data/transaction-crud";

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
}

beforeEach(async () => {
  await clearEverything();
});

const TX = { txid: "tx-blank", blockHeight: 800000, blockTime: 1_700_000_000, fee: 500, feeRate: 2, syncedAt: 1 };

describe("legacy restore (MERGE): fully-blank live inputs are enriched, not duplicated", () => {
  it("pairs a single blank live input with the backup input that resolved its outpoint", async () => {
    await bulkAddTransactions([TX as any], { skipNotification: true });
    // The live input knows NOTHING but txid+role — no address, no prevout.
    await bulkAddParticipants(
      [
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
        { txid: "tx-blank", role: "output", address: "bc1qout", amount: 9000, vout: 0 } as any,
      ],
      { skipNotification: true },
    );

    const result = await restoreLegacyTransactions(
      [{ id: 1, ...TX }],
      [
        { id: 11, txid: "tx-blank", role: "input", address: "bc1qsrc", amount: 10000, prevTxid: "src-tx", prevVout: 3, recordId: 7 },
        { id: 12, txid: "tx-blank", role: "output", address: "bc1qout", amount: 9000, vout: 0 },
      ],
      "merge",
      new Map([[7, 555]]),
    );

    // No new row: the blank input was enriched in place.
    expect(result.participantsAdded).toBe(0);
    expect(result.participantsEnriched).toBe(1);

    const all = await getAllTransactionParticipants();
    expect(all).toHaveLength(2);
    const input = all.find((p) => p.role === "input")!;
    expect(input.address).toBe("bc1qsrc");
    expect(input.amount).toBe(10000);
    expect(input.prevTxid).toBe("src-tx");
    expect(input.prevVout).toBe(3);
    // recordId is the REMAPPED live id, never the raw backup id.
    expect(input.recordId).toBe(555);
  });

  it("pairs multiple blank live inputs ordinally when counts match exactly", async () => {
    await bulkAddTransactions([TX as any], { skipNotification: true });
    await bulkAddParticipants(
      [
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
      ],
      { skipNotification: true },
    );

    const result = await restoreLegacyTransactions(
      [{ id: 1, ...TX }],
      [
        { id: 21, txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
        { id: 22, txid: "tx-blank", role: "input", address: "bc1qb", amount: 2000, prevTxid: "src-b", prevVout: 1 },
      ],
      "merge",
      new Map(),
    );

    expect(result.participantsAdded).toBe(0);
    expect(result.participantsEnriched).toBe(2);

    const all = await getAllTransactionParticipants();
    expect(all).toHaveLength(2);
    // Ordinal pairing: first blank (lowest id) gets the first backup outpoint.
    const sorted = [...all].sort((a, b) => (a.id as number) - (b.id as number));
    expect(sorted[0].prevTxid).toBe("src-a");
    expect(sorted[0].address).toBe("bc1qa");
    expect(sorted[1].prevTxid).toBe("src-b");
    expect(sorted[1].address).toBe("bc1qb");
  });

  it("falls back to adding when counts differ (ambiguous pairing)", async () => {
    await bulkAddTransactions([TX as any], { skipNotification: true });
    // TWO blank live inputs, but the backup resolves only ONE outpoint —
    // pairing would be a guess, so the documented fallback adds the row.
    await bulkAddParticipants(
      [
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
      ],
      { skipNotification: true },
    );

    const result = await restoreLegacyTransactions(
      [{ id: 1, ...TX }],
      [{ id: 31, txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 }],
      "merge",
      new Map(),
    );

    expect(result.participantsAdded).toBe(1);
    expect(result.participantsEnriched).toBe(0);
    const all = await getAllTransactionParticipants();
    expect(all).toHaveLength(3);
    // The blank rows are untouched.
    expect(all.filter((p) => !p.prevTxid && !p.address)).toHaveLength(2);
  });

  it("does not pair a live input that already has an address (identity via exact key)", async () => {
    await bulkAddTransactions([TX as any], { skipNotification: true });
    // Live input HAS an address (so it is not fully blank) but no prevout.
    await bulkAddParticipants(
      [{ txid: "tx-blank", role: "input", address: "bc1qlive", amount: 500 } as any],
      { skipNotification: true },
    );

    const result = await restoreLegacyTransactions(
      [{ id: 1, ...TX }],
      // Backup input for a DIFFERENT address with a resolved outpoint: this is
      // not pairable with the addressed live row — it must be added.
      [{ id: 41, txid: "tx-blank", role: "input", address: "bc1qother", amount: 700, prevTxid: "src-x", prevVout: 0 }],
      "merge",
      new Map(),
    );

    expect(result.participantsAdded).toBe(1);
    expect(result.participantsEnriched).toBe(0);
    const all = await getAllTransactionParticipants();
    expect(all).toHaveLength(2);
    const live = all.find((p) => p.address === "bc1qlive")!;
    expect(live.prevTxid).toBeUndefined();
  });

  it("counts DISTINCT backup outpoints — duplicate backup rows for one outpoint still pair", async () => {
    await bulkAddTransactions([TX as any], { skipNotification: true });
    await bulkAddParticipants(
      [{ txid: "tx-blank", role: "input", address: "", amount: 0 } as any],
      { skipNotification: true },
    );

    const result = await restoreLegacyTransactions(
      [{ id: 1, ...TX }],
      // The same outpoint appears TWICE in the (malformed) backup: still one
      // distinct spend, so pairing with the single blank row stays unambiguous.
      [
        { id: 51, txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
        { id: 52, txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
      ],
      "merge",
      new Map(),
    );

    expect(result.participantsAdded).toBe(0);
    expect(result.participantsEnriched).toBe(1);
    const all = await getAllTransactionParticipants();
    expect(all).toHaveLength(1);
    expect(all[0].prevTxid).toBe("src-a");
    expect(all[0].address).toBe("bc1qa");
  });

  it("pairing is per-txid: blanks of one tx never absorb another tx's inputs", async () => {
    await bulkAddTransactions(
      [TX as any, { ...TX, txid: "tx-other" } as any],
      { skipNotification: true },
    );
    await bulkAddParticipants(
      [
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
        // tx-other has NO blank inputs.
        { txid: "tx-other", role: "input", address: "bc1qother", amount: 100, prevTxid: "src-o", prevVout: 0 } as any,
      ],
      { skipNotification: true },
    );

    const result = await restoreLegacyTransactions(
      [
        { id: 1, ...TX },
        { id: 2, ...TX, txid: "tx-other" },
      ],
      [
        { id: 61, txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
        // A NEW input for tx-other (unmatched there) must be added to tx-other,
        // never paired into tx-blank's blank row.
        { id: 62, txid: "tx-other", role: "input", address: "bc1qnew", amount: 200, prevTxid: "src-n", prevVout: 1 },
      ],
      "merge",
      new Map(),
    );

    expect(result.participantsAdded).toBe(1);
    expect(result.participantsEnriched).toBe(1);
    const all = await getAllTransactionParticipants();
    const blankTx = all.filter((p) => p.txid === "tx-blank");
    expect(blankTx).toHaveLength(1);
    expect(blankTx[0].prevTxid).toBe("src-a");
    const otherTx = all.filter((p) => p.txid === "tx-other");
    expect(otherTx).toHaveLength(2);
  });
});
