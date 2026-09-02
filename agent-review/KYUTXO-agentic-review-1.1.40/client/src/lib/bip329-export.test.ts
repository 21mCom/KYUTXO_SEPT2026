// @vitest-environment jsdom
//
// Scale + correctness tests for the BIP-329 label export walk
// (client/src/lib/bip329-export.ts) against the real Dexie schema via
// fake-indexeddb.
//
// Regression guarded here: the export used to walk the whole records table
// and then join every line into ONE giant string on the main thread —
// measured at ~150ms for the join and ~330ms for the Blob copy at 100k
// records (scaling linearly), i.e. a visible page freeze on huge vaults.
// The batched helper must (a) yield to the event loop between keyset batches,
// (b) never build one giant string (parts stay bounded), and (c) produce
// byte-exact JSONL that round-trips through parseJsonLines.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/lib/database";
import { exportBip329LabelParts } from "@/lib/bip329-export";
import { parseJsonLines } from "@/lib/bip329";
import type { Record as DbRecord } from "@/lib/db-types";
import type { BlockchainTransaction } from "@/lib/db-types";

const TXID = (n: number) => n.toString(16).padStart(64, "0");
const ADDR = (n: number) => `bc1qexport${n.toString(36).padStart(28, "0")}`;

function makeRecord(n: number): Omit<DbRecord, "id"> {
  const kind = n % 4;
  if (kind === 0) {
    // Unlabeled rows must be skipped.
    return {
      type: "address",
      inputString: ADDR(n),
      label: "",
      tags: [],
      categories: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  if (kind === 1) {
    return {
      type: "address",
      inputString: ADDR(n),
      label: `Address label ${n}`,
      notes: "Origin: wpkh([abcd1234/84'/0'/0']xpubExample/0/0)",
      tags: [],
      categories: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  if (kind === 2) {
    return {
      type: "transaction",
      inputString: TXID(n),
      label: `Transaction label ${n}`,
      tags: [],
      categories: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  return {
    type: "transaction",
    inputString: `${TXID(n)}:1`,
    label: `Output label ${n}`,
    notes: "BIP-329 output at index 1. Spendable: false",
    tags: [],
    categories: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function seedRecords(total: number, seedBatch = 5000): Promise<void> {
  for (let i = 0; i < total; i += seedBatch) {
    const rows: Omit<DbRecord, "id">[] = [];
    for (let j = 0; j < Math.min(seedBatch, total - i); j++) rows.push(makeRecord(i + j));
    await db.records.bulkAdd(rows as DbRecord[]);
  }
}

// Tracks the longest stretch the event loop was starved (ms beyond the 4ms
// timer interval) while the monitored work runs.
function lagMonitor() {
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last - 4;
    if (gap > maxGap) maxGap = gap;
    last = now;
  }, 4);
  return { stop: () => clearInterval(timer), maxGap: () => maxGap };
}

describe("exportBip329LabelParts", () => {
  beforeEach(async () => {
    await db.records.clear();
  });

  it("returns no parts for an empty vault", async () => {
    const result = await exportBip329LabelParts();
    expect(result.parts).toEqual([]);
    expect(result.lineCount).toBe(0);
    expect(result.scannedCount).toBe(0);
  });

  it("exports a small vault as a single well-formed part", async () => {
    await seedRecords(8);
    const result = await exportBip329LabelParts({ batchSize: 100 });
    // 2 of every 4 records are unlabeled... kind 0 only, so 6 of 8 export.
    expect(result.scannedCount).toBe(8);
    expect(result.lineCount).toBe(6);
    expect(result.parts).toHaveLength(1);
    const parsed = parseJsonLines(result.parts.join(""));
    expect(parsed).toHaveLength(6);
    expect(parsed.map((p) => p.type).sort()).toEqual(
      ["addr", "addr", "output", "output", "tx", "tx"].sort(),
    );
  });

  it("round-trips a huge vault with bounded parts and a responsive event loop", async () => {
    const TOTAL = 100_000;
    const BATCH = 1000;
    await seedRecords(TOTAL);

    const yieldControl = vi.fn(() => Promise.resolve());
    const mon = lagMonitor();
    const result = await exportBip329LabelParts({ batchSize: BATCH, yieldControl });
    mon.stop();

    // Correctness: every labeled record exported exactly once, valid JSONL.
    expect(result.scannedCount).toBe(TOTAL);
    expect(result.lineCount).toBe((TOTAL / 4) * 3);
    const parsed = parseJsonLines(result.parts.join(""));
    expect(parsed).toHaveLength(result.lineCount);
    expect(parsed[0]).toMatchObject({ type: "addr", ref: ADDR(1), label: "Address label 1" });
    expect(parsed[parsed.length - 1].label).toBeDefined();

    // Batching: one part per batch, each ending in a newline, and no part
    // large enough to stall on join/copy (~1000 lines << 1MB).
    expect(result.parts.length).toBe(TOTAL / BATCH);
    for (const part of result.parts) {
      expect(part.endsWith("\n")).toBe(true);
      expect(part.length).toBeLessThan(1024 * 1024);
    }

    // Event loop: a yield between every batch, and the longest starved
    // stretch stays far below a dropped-frame cliff (the old giant join alone
    // measured ~150ms at this scale and grows linearly with vault size).
    // One yield after every batch (the final full batch cannot know it is
    // last, so it yields once more before the empty read ends the walk).
    expect(yieldControl).toHaveBeenCalledTimes(TOTAL / BATCH);
    // Smoke bound on event-loop starvation. fake-indexeddb structured-clones
    // each batch synchronously on the JS thread (~150ms per 1000-row batch
    // here; real browsers clone off the main thread), so this threshold is
    // generous — the precise guards against a monolithic-join regression are
    // the yield count and per-part size bounds above.
    expect(mon.maxGap()).toBeLessThan(400);
  }, 300_000);

  it("applies the export filter while batching", async () => {
    await seedRecords(8);
    const result = await exportBip329LabelParts({
      batchSize: 4,
      filter: { kind: "address" },
    });
    expect(result.scannedCount).toBe(8);
    expect(result.lineCount).toBe(2); // kinds 1 and 5 are labeled addresses
    const parsed = parseJsonLines(result.parts.join(""));
    expect(parsed).toEqual([
      { type: "addr", ref: ADDR(1), label: "Address label 1", origin: "wpkh([abcd1234/84'/0'/0']xpubExample/0/0)" },
      { type: "addr", ref: ADDR(5), label: "Address label 5", origin: "wpkh([abcd1234/84'/0'/0']xpubExample/0/0)" },
    ]);
  });

  it("scopes transaction/UTXO rows by the underlying blockTime, not updatedAt", async () => {
    await db.blockchainTransactions.clear();
    const now = Date.now();
    const inWindowTxid = TXID(100);
    const outOfWindowTxid = TXID(101);
    const unsyncedTxid = TXID(102);

    const txs: Omit<BlockchainTransaction, "id">[] = [
      { txid: inWindowTxid, blockHeight: 800000, blockTime: 1_650_000_000, fee: 0, feeRate: 0, syncedAt: now },
      { txid: outOfWindowTxid, blockHeight: 800001, blockTime: 1_600_000_000, fee: 0, feeRate: 0, syncedAt: now },
    ];
    await db.blockchainTransactions.bulkAdd(txs as BlockchainTransaction[]);

    const rows: Omit<DbRecord, "id">[] = [
      {
        // Last-edited timestamps are set INSIDE the date window, but the
        // on-chain blockTime is what should decide this row's fate.
        type: "transaction",
        inputString: inWindowTxid,
        label: "In-window on-chain, but edited long ago",
        tags: [],
        categories: [],
        createdAt: 1_650_000_000_000,
        updatedAt: 1_650_000_000_000,
      },
      {
        // Same fresh updatedAt as the previous row, but its blockTime falls
        // outside the window — must be excluded despite the recent edit.
        type: "transaction",
        inputString: `${outOfWindowTxid}:0`,
        label: "Out-of-window on-chain, edited recently",
        notes: "BIP-329 output at index 0",
        tags: [],
        categories: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        // No blockchainTransactions row at all (unsynced) — no fallback to
        // updatedAt/createdAt even though they're inside the window.
        type: "transaction",
        inputString: unsyncedTxid,
        label: "Unsynced tx, edited recently",
        tags: [],
        categories: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        // Address rows have no associated transaction — they fall back to
        // updatedAt/createdAt as before, so an edit inside the window keeps
        // them in (regardless of on-chain timing, which doesn't apply here).
        type: "address",
        inputString: ADDR(1),
        label: "Address edited inside the window",
        tags: [],
        categories: [],
        createdAt: 1_650_500_000_000,
        updatedAt: 1_650_500_000_000,
      },
    ];
    await db.records.bulkAdd(rows as DbRecord[]);

    const dateRange = { start: 1_649_000_000, end: 1_651_000_000 };
    const result = await exportBip329LabelParts({ batchSize: 10, filter: { dateRange } });

    expect(result.scannedCount).toBe(4);
    const parsed = parseJsonLines(result.parts.join(""));
    expect(parsed.map((p) => p.label).sort()).toEqual([
      "Address edited inside the window",
      "In-window on-chain, but edited long ago",
    ]);

    await db.blockchainTransactions.clear();
  });

  it("reports progress cumulatively per batch", async () => {
    await seedRecords(2500);
    const calls: Array<[number, number]> = [];
    await exportBip329LabelParts({
      batchSize: 1000,
      onProgress: (scanned, exported) => calls.push([scanned, exported]),
    });
    expect(calls.map(([scanned]) => scanned)).toEqual([1000, 2000, 2500]);
    expect(calls[calls.length - 1][1]).toBe(1875); // 3/4 of 2500 labeled
  });
});
