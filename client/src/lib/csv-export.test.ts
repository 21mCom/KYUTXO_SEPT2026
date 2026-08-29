// Records CSV export: shared-predicate filtering, RFC 4180 escaping, batched
// Blob-parts output, and header handling.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsAfterId: vi.fn(),
}));

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsByTxids: vi.fn(async () => []),
}));

import { getRecordsAfterId } from "@/lib/data/record-crud";
import { getTransactionsByTxids } from "@/lib/data/transaction-crud";
import {
  csvEscape,
  csvSanitizeCell,
  csvField,
  recordToCsvRow,
  exportRecordsCsvParts,
  CSV_EXPORT_HEADER,
  type CsvExportableRecord,
} from "@/lib/csv-export";
import { recordExportKind, matchesRecordExportFilter } from "@/lib/bip329";

const getRecordsAfterIdMock = vi.mocked(getRecordsAfterId);
const getTransactionsByTxidsMock = vi.mocked(getTransactionsByTxids);

const ADDR = "bc1qcsvexporttestaddressxxxxxxxxxxxxxxxxxx";
const TXID = "a".repeat(64);
const OUTPOINT = `${"b".repeat(64)}:0`;

type Row = CsvExportableRecord & { id: number };

const FIXTURE: Row[] = [
  {
    id: 1,
    type: "address",
    inputString: ADDR,
    label: "Savings address",
    walletName: "Cold",
    owner: "Alice",
    tags: ["kyc"],
    categories: ["savings"],
    notes: "long, term",
    amount: 1.5,
    date: "2024-01-02",
  },
  { id: 2, type: "transaction", inputString: TXID, label: "Coffee tx", walletName: "Hot", tags: [] },
  { id: 3, type: "transaction", inputString: OUTPOINT, label: "Frozen output", walletName: "Cold", tags: ["kyc"] },
  { id: 4, type: "other", inputString: "seed-phrase-note", label: "", tags: [] },
];

function seed(rows: Row[]) {
  getRecordsAfterIdMock.mockImplementation(async (afterId: number, limit: number) =>
    rows.filter((r) => r.id > afterId).slice(0, limit) as never
  );
}

function parseCsv(parts: string[]): string[] {
  return parts.join("").split("\r\n").filter((l) => l !== "");
}

describe("csvEscape", () => {
  it("quotes commas, quotes, and newlines per RFC 4180", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
  });
});

describe("recordExportKind", () => {
  it("buckets records the same way the BIP-329 line kinds do", () => {
    expect(recordExportKind(FIXTURE[0])).toBe("address");
    expect(recordExportKind(FIXTURE[1])).toBe("transaction");
    expect(recordExportKind(FIXTURE[2])).toBe("utxo");
    expect(recordExportKind(FIXTURE[3])).toBe("other");
  });
});

describe("matchesRecordExportFilter", () => {
  it("matches everything with no filter, and 'other' rows only under kind=all", () => {
    for (const r of FIXTURE) expect(matchesRecordExportFilter(r)).toBe(true);
    expect(matchesRecordExportFilter(FIXTURE[3], { kind: "all" })).toBe(true);
    expect(matchesRecordExportFilter(FIXTURE[3], { kind: "transaction" })).toBe(false);
  });

  it("filters by kind, tag, wallet, and case-insensitive search over label/ref/notes", () => {
    expect(matchesRecordExportFilter(FIXTURE[0], { kind: "address" })).toBe(true);
    expect(matchesRecordExportFilter(FIXTURE[1], { kind: "address" })).toBe(false);
    expect(matchesRecordExportFilter(FIXTURE[0], { tag: "kyc" })).toBe(true);
    expect(matchesRecordExportFilter(FIXTURE[1], { tag: "kyc" })).toBe(false);
    expect(matchesRecordExportFilter(FIXTURE[1], { walletName: "Hot" })).toBe(true);
    expect(matchesRecordExportFilter(FIXTURE[2], { walletName: "Hot" })).toBe(false);
    expect(matchesRecordExportFilter(FIXTURE[0], { search: "LONG, TERM" })).toBe(true);
    expect(matchesRecordExportFilter(FIXTURE[1], { search: TXID.slice(0, 10) })).toBe(true);
    expect(matchesRecordExportFilter(FIXTURE[2], { search: "frozen" })).toBe(true);
    expect(matchesRecordExportFilter(FIXTURE[2], { search: "no-match" })).toBe(false);
  });

  it("scopes transaction/UTXO rows by an explicitly passed blockTime, not their timestamps", () => {
    const txRecord = { ...FIXTURE[1], createdAt: 9_999_999_999_000, updatedAt: 9_999_999_999_000 };
    // Timestamps are miles outside the window, but the caller-supplied
    // blockTime (Unix seconds) is what the predicate consults for this kind.
    expect(
      matchesRecordExportFilter(txRecord, { dateRange: { start: 1000, end: 2000 } }, 1500)
    ).toBe(true);
    expect(
      matchesRecordExportFilter(txRecord, { dateRange: { start: 1000, end: 2000 } }, 5000)
    ).toBe(false);
    // No blockTime supplied at all -> excluded, even inside a window that
    // would otherwise match its timestamps.
    expect(
      matchesRecordExportFilter(txRecord, { dateRange: { start: 0, end: 9_999_999_999_999 } })
    ).toBe(false);
  });
});

describe("exportRecordsCsvParts", () => {
  it("exports every record with a header row and escaped fields", async () => {
    seed(FIXTURE);
    const { parts, rowCount, scannedCount } = await exportRecordsCsvParts();
    expect(rowCount).toBe(4);
    expect(scannedCount).toBe(4);
    const lines = parseCsv(parts);
    expect(lines[0]).toBe(CSV_EXPORT_HEADER.join(","));
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe(
      `address,${ADDR},Savings address,Cold,Alice,kyc,savings,"long, term",1.5,2024-01-02`
    );
    expect(lines[4]).toBe("other,seed-phrase-note,,,,,,,,");
  });

  it("keeps only rows matching the shared filter predicate", async () => {
    seed(FIXTURE);
    const { parts, rowCount } = await exportRecordsCsvParts({
      filter: { kind: "all", tag: "kyc", walletName: "Cold" },
    });
    expect(rowCount).toBe(2);
    const lines = parseCsv(parts);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(ADDR);
    expect(lines[2]).toContain("Frozen output");
  });

  it("walks in keyset batches, yields between batches, and reports progress", async () => {
    seed(FIXTURE);
    const yields: number[] = [];
    const progress: Array<[number, number]> = [];
    const { rowCount, scannedCount, parts } = await exportRecordsCsvParts({
      batchSize: 2,
      yieldControl: async () => { yields.push(1); },
      onProgress: (scanned, exported) => progress.push([scanned, exported]),
    });
    expect(scannedCount).toBe(4);
    expect(rowCount).toBe(4);
    expect(yields.length).toBeGreaterThanOrEqual(1);
    expect(progress[progress.length - 1]).toEqual([4, 4]);
    // Parts joined are identical to the single-batch output.
    seed(FIXTURE);
    const single = await exportRecordsCsvParts();
    expect(parts.join("")).toBe(single.parts.join(""));
  });

  it("returns just the header when nothing matches", async () => {
    seed(FIXTURE);
    const { parts, rowCount } = await exportRecordsCsvParts({ filter: { search: "zzz-no-match" } });
    expect(rowCount).toBe(0);
    expect(parseCsv(parts)).toEqual([CSV_EXPORT_HEADER.join(",")]);
  });

  it("scopes a date filter by the underlying transaction's blockTime via a bulk per-batch lookup", async () => {
    seed(FIXTURE);
    getTransactionsByTxidsMock.mockImplementation(async (txids: string[]) =>
      txids
        .filter((txid) => txid === TXID)
        .map((txid) => ({
          txid,
          blockTime: 1500,
          blockHeight: 1,
          fee: 0,
          feeRate: 0,
          syncedAt: 0,
        })) as never
    );

    // FIXTURE[1] (bare txid) resolves to blockTime 1500 -> inside the window.
    // FIXTURE[2] (outpoint on a different txid) has no matching row -> no
    // fallback to its (unset) timestamps, so it's excluded.
    // FIXTURE[0] (address) and FIXTURE[3] (other) fall back to their (unset)
    // timestamps, which are undefined -> also excluded.
    const { rowCount, parts } = await exportRecordsCsvParts({
      filter: { dateRange: { start: 1000, end: 2000 } },
    });
    expect(getTransactionsByTxidsMock).toHaveBeenCalled();
    expect(rowCount).toBe(1);
    const lines = parseCsv(parts);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Coffee tx");

    getTransactionsByTxidsMock.mockReset();
    getTransactionsByTxidsMock.mockImplementation(async () => []);
  });
});

describe("recordToCsvRow", () => {
  it("serializes each column in header order", () => {
    const row = recordToCsvRow(FIXTURE[2]);
    expect(row.split(",")[0]).toBe("utxo");
    expect(row).toContain(OUTPOINT);
  });
});

describe("spreadsheet formula-injection guard", () => {
  it("neutralizes formula sigils, including after leading whitespace", () => {
    expect(csvSanitizeCell("=1+1")).toBe("'=1+1");
    expect(csvSanitizeCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvSanitizeCell("-2+3")).toBe("'-2+3");
    expect(csvSanitizeCell("@cmd")).toBe("'@cmd");
    expect(csvSanitizeCell("  =HYPERLINK()")).toBe("'  =HYPERLINK()");
    expect(csvSanitizeCell("\t=x")).toBe("'\t=x");
    expect(csvSanitizeCell("safe")).toBe("safe");
    expect(csvSanitizeCell("")).toBe("");
  });

  it("csvField sanitizes then escapes", () => {
    expect(csvField('=cmd|"payload"')).toBe(`"'=cmd|""payload"""`);
  });

  it("sanitizes every user-controlled column but keeps numeric amounts intact", () => {
    const hostile: CsvExportableRecord = {
      type: "other",
      inputString: "=id()",
      label: "+label",
      walletName: "-wallet",
      owner: "@owner",
      tags: ["=tag"],
      categories: ["+cat"],
      notes: "=2+5",
      amount: -1.5,
      date: "=TODAY()",
    };
    const cells = recordToCsvRow(hostile).split(",");
    expect(cells).toEqual([
      "other",
      "'=id()",
      "'+label",
      "'-wallet",
      "'@owner",
      "'=tag",
      "'+cat",
      "'=2+5",
      "-1.5",
      "'=TODAY()",
    ]);
  });
});
