// @vitest-environment jsdom
//
// Scale + correctness test for the Records CSV export walk
// (client/src/lib/csv-export.ts exportRecordsCsvParts) against the real Dexie
// schema via fake-indexeddb — mirrors the BIP-329 100k scale test in
// bip329-export.test.ts.
//
// Regression guarded here: a monolithic export (walk the whole records table,
// then join every row into ONE giant string on the main thread) freezes the
// page at huge scale. The batched helper must (a) yield to the event loop
// between keyset batches, (b) never build one giant string (parts stay
// bounded), and (c) produce CSV that round-trips row-for-row.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/lib/database";
import { exportRecordsCsvParts, CSV_EXPORT_HEADER } from "@/lib/csv-export";
import type { Record as DbRecord } from "@/lib/db-types";

const TXID = (n: number) => n.toString(16).padStart(64, "0");
const ADDR = (n: number) => `bc1qcsvscale${n.toString(36).padStart(26, "0")}`;

function makeRecord(n: number): Omit<DbRecord, "id"> {
  const kind = n % 4;
  if (kind === 0) {
    return {
      type: "address",
      inputString: ADDR(n),
      label: `Addr label ${n}`,
      walletName: "Cold",
      tags: ["kyc", "scale"],
      categories: ["savings"],
      notes: `note, with comma ${n}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  if (kind === 1) {
    return {
      type: "transaction",
      inputString: TXID(n),
      label: `Tx label ${n}`,
      tags: [],
      categories: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  if (kind === 2) {
    // Hostile cell: formula sigil must be neutralized in the output.
    return {
      type: "address",
      inputString: ADDR(n),
      label: `=HYPERLINK("evil${n}")`,
      tags: [],
      categories: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  return {
    type: "transaction",
    inputString: `${TXID(n)}:1`,
    label: "",
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

// Minimal RFC 4180 parser (handles quoted fields with embedded commas,
// quotes, and line breaks) used as the round-trip oracle.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("exportRecordsCsvParts at scale", () => {
  beforeEach(async () => {
    await db.records.clear();
  });

  it("round-trips a huge vault with bounded parts and a responsive event loop", async () => {
    const TOTAL = 100_000;
    const BATCH = 1000;
    await seedRecords(TOTAL);

    const yieldControl = vi.fn(() => Promise.resolve());
    const mon = lagMonitor();
    const result = await exportRecordsCsvParts({ batchSize: BATCH, yieldControl });
    mon.stop();

    // Correctness: every record scanned, every record exported (no filter),
    // and the CSV round-trips row-for-row through an RFC 4180 parser.
    expect(result.scannedCount).toBe(TOTAL);
    expect(result.rowCount).toBe(TOTAL);
    const rows = parseCsv(result.parts.join(""));
    expect(rows).toHaveLength(TOTAL + 1); // header + data rows
    expect(rows[0]).toEqual([...CSV_EXPORT_HEADER]);
    for (const row of [rows[1], rows[rows.length - 1]]) {
      expect(row).toHaveLength(CSV_EXPORT_HEADER.length);
    }
    // Spot checks: id 1 → record n=0 (comma-laden note survives quoting),
    // hostile formula cell (n=2) is apostrophe-neutralized after parsing.
    expect(rows[1][0]).toBe("address");
    expect(rows[1][1]).toBe(ADDR(0));
    expect(rows[1][2]).toBe("Addr label 0");
    expect(rows[1][5]).toBe("kyc; scale");
    expect(rows[1][7]).toBe("note, with comma 0");
    expect(rows[3][2]).toBe(`'=HYPERLINK("evil2")`);

    // Batching: header part + one part per batch, each ending in CRLF, none
    // large enough to stall on join/copy.
    expect(result.parts.length).toBe(1 + TOTAL / BATCH);
    for (const part of result.parts) {
      expect(part.endsWith("\r\n")).toBe(true);
      expect(part.length).toBeLessThan(1024 * 1024);
    }

    // Event loop: a yield between every batch (the final full batch cannot
    // know it is last, so it yields once more before the empty read ends the
    // walk), and the longest starved stretch stays far below a page-freeze
    // cliff. fake-indexeddb structured-clones each batch synchronously on the
    // JS thread (real browsers clone off the main thread), so the lag bound is
    // generous — the precise guards against a monolithic-join regression are
    // the yield count and per-part size bounds above.
    expect(yieldControl).toHaveBeenCalledTimes(TOTAL / BATCH);
    expect(mon.maxGap()).toBeLessThan(400);
  }, 300_000);
});
