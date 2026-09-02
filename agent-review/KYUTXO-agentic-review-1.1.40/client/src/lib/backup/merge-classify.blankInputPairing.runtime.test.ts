// @vitest-environment jsdom
//
// Behaviour tests for the FULLY-BLANK live-input ordinal pairing in the v3
// MERGE classifier (task: prevent the v3 merge restore from duplicating the
// same blank input rows), mirroring
// legacy-restore-blank-input-pairing.runtime.test.ts.
//
// A live input row with NEITHER an address NOR a resolved prevout (only
// txid+role='input') has no key-based identity, so a richer backup input that
// carries prevTxid/prevVout could never be matched to it and was previously
// classified as INSERT — two rows for one logical spend. The fix pairs blank
// live inputs with unmatched backup input outpoints ORDINALLY, but only when
// the counts are exactly equal (unambiguous); when they differ, the old
// insert behaviour is deliberately kept. Because the same MergeClassifier
// drives both the actual merge restore and the read-only merge analysis, the
// pairing applies to both.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { MergeClassifier } from "./merge-classify";
import { clearAllRecords } from "@/lib/data/record-crud";
import {
  clearTransactions,
  clearParticipants,
  bulkAddParticipants,
} from "@/lib/data/transaction-crud";

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
}

beforeEach(async () => {
  await clearEverything();
});

const kinds = (
  decisions: Array<{ kind: string }>,
): string[] => decisions.map((d) => d.kind);

describe("v3 merge classifier: fully-blank live inputs are enriched, not duplicated", () => {
  it("pairs a single blank live input with the backup input that resolved its outpoint", async () => {
    // The live input knows NOTHING but txid+role — no address, no prevout.
    await bulkAddParticipants(
      [
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
        { txid: "tx-blank", role: "output", address: "bc1qout", amount: 9000, vout: 0 } as any,
      ],
      { skipNotification: true },
    );

    const classifier = new MergeClassifier();
    const decisions = await classifier.classifyParticipants([
      { txid: "tx-blank", role: "input", address: "bc1qsrc", amount: 10000, prevTxid: "src-tx", prevVout: 3 },
      { txid: "tx-blank", role: "output", address: "bc1qout", amount: 9000, vout: 0 },
    ]);

    expect(kinds(decisions)).toEqual(["enrich", "enrich"]);
    // The enrich target for the input IS the blank live row.
    const inputDecision = decisions[0] as { kind: "enrich"; live: any };
    expect(inputDecision.live.role).toBe("input");
    expect(inputDecision.live.address ?? "").toBe("");
    expect(inputDecision.live.prevTxid).toBeUndefined();
  });

  it("pairs multiple blank live inputs ordinally when counts match exactly", async () => {
    const liveIds = await bulkAddParticipants(
      [
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
      ],
      { skipNotification: true },
    );

    const classifier = new MergeClassifier();
    const decisions = await classifier.classifyParticipants([
      { txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
      { txid: "tx-blank", role: "input", address: "bc1qb", amount: 2000, prevTxid: "src-b", prevVout: 1 },
    ]);

    expect(kinds(decisions)).toEqual(["enrich", "enrich"]);
    // Ordinal pairing: first backup outpoint ↔ blank row with the lowest id.
    const sortedIds = [...liveIds].sort((a, b) => a - b);
    expect((decisions[0] as any).live.id).toBe(sortedIds[0]);
    expect((decisions[1] as any).live.id).toBe(sortedIds[1]);
  });

  it("falls back to inserting when counts differ (ambiguous pairing)", async () => {
    // TWO blank live inputs, but the backup resolves only ONE outpoint —
    // pairing would be a guess, so the documented fallback inserts the row.
    await bulkAddParticipants(
      [
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
      ],
      { skipNotification: true },
    );

    const classifier = new MergeClassifier();
    const decisions = await classifier.classifyParticipants([
      { txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
    ]);

    expect(kinds(decisions)).toEqual(["insert"]);
  });

  it("does not pair a live input that already has an address (identity via exact key)", async () => {
    // Live input HAS an address (so it is not fully blank) but no prevout.
    await bulkAddParticipants(
      [{ txid: "tx-blank", role: "input", address: "bc1qlive", amount: 500 } as any],
      { skipNotification: true },
    );

    const classifier = new MergeClassifier();
    // Backup input for a DIFFERENT address with a resolved outpoint: this is
    // not pairable with the addressed live row — it must be inserted.
    const decisions = await classifier.classifyParticipants([
      { txid: "tx-blank", role: "input", address: "bc1qother", amount: 700, prevTxid: "src-x", prevVout: 0 },
    ]);

    expect(kinds(decisions)).toEqual(["insert"]);
  });

  it("counts DISTINCT backup outpoints — duplicate backup rows for one outpoint still pair", async () => {
    await bulkAddParticipants(
      [{ txid: "tx-blank", role: "input", address: "", amount: 0 } as any],
      { skipNotification: true },
    );

    const classifier = new MergeClassifier();
    // The same outpoint appears TWICE in the (malformed) backup: still one
    // distinct spend, so pairing with the single blank row stays unambiguous.
    const decisions = await classifier.classifyParticipants([
      { txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
      { txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
    ]);

    // Both rows resolve to the SAME blank live row (second is an enrich of the
    // same target, so no duplicate row is ever inserted).
    expect(kinds(decisions)).toEqual(["enrich", "enrich"]);
    expect((decisions[0] as any).live.id).toBe((decisions[1] as any).live.id);
  });

  it("pairing is per-txid: blanks of one tx never absorb another tx's inputs", async () => {
    await bulkAddParticipants(
      [
        { txid: "tx-blank", role: "input", address: "", amount: 0 } as any,
        // tx-other has NO blank inputs.
        { txid: "tx-other", role: "input", address: "bc1qother", amount: 100, prevTxid: "src-o", prevVout: 0 } as any,
      ],
      { skipNotification: true },
    );

    const classifier = new MergeClassifier();
    const decisions = await classifier.classifyParticipants([
      { txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
      // A NEW input for tx-other (unmatched there) must be inserted for
      // tx-other, never paired into tx-blank's blank row.
      { txid: "tx-other", role: "input", address: "bc1qnew", amount: 200, prevTxid: "src-n", prevVout: 1 },
    ]);

    expect(kinds(decisions)).toEqual(["enrich", "insert"]);
    expect((decisions[0] as any).live.txid).toBe("tx-blank");
  });

  it("never pairs the same blank live row twice across streamed batches (analysis parity)", async () => {
    // The analysis pipeline classifies without writing, so a later batch
    // re-loads the same still-blank live row. It must NOT be paired again.
    await bulkAddParticipants(
      [{ txid: "tx-blank", role: "input", address: "", amount: 0 } as any],
      { skipNotification: true },
    );

    const classifier = new MergeClassifier();
    const first = await classifier.classifyParticipants([
      { txid: "tx-blank", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
    ]);
    expect(kinds(first)).toEqual(["enrich"]);

    // A DIFFERENT outpoint in a later batch: the only blank row was already
    // consumed, so this must fall back to insert, not double-pair.
    const second = await classifier.classifyParticipants([
      { txid: "tx-blank", role: "input", address: "bc1qb", amount: 2000, prevTxid: "src-b", prevVout: 1 },
    ]);
    expect(kinds(second)).toEqual(["insert"]);
  });

  it("does not pair with an outpoint the stream already decided to insert", async () => {
    // Batch 1: no blanks live for tx-ins yet... simulate an outpoint inserted
    // in an earlier batch for a txid that ALSO has a blank live row: the blank
    // must not absorb the already-inserted outpoint when it repeats later.
    await bulkAddParticipants(
      [{ txid: "tx-mixed", role: "input", address: "", amount: 0 } as any],
      { skipNotification: true },
    );

    const classifier = new MergeClassifier();
    // First batch pairs the blank with src-a (counts equal: 1 blank, 1 outpoint).
    const first = await classifier.classifyParticipants([
      { txid: "tx-mixed", role: "input", address: "bc1qa", amount: 1000, prevTxid: "src-a", prevVout: 0 },
      { txid: "tx-mixed", role: "input", address: "bc1qb", amount: 2000, prevTxid: "src-b", prevVout: 1 },
    ]);
    // 1 blank vs 2 distinct unmatched outpoints → ambiguous → both inserted.
    expect(kinds(first)).toEqual(["insert", "insert"]);

    // Later batch repeats src-b exactly: stream self-dedupe, never a pair.
    const second = await classifier.classifyParticipants([
      { txid: "tx-mixed", role: "input", address: "bc1qb", amount: 2000, prevTxid: "src-b", prevVout: 1 },
    ]);
    expect(kinds(second)).toEqual(["duplicate"]);
  });
});
