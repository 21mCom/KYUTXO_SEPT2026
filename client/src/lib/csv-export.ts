// Records CSV export (spreadsheet-friendly) at scale.
//
// Mirrors the BIP-329 label export (bip329-export.ts): records are walked in
// keyset batches (id cursor) with event-loop yields between batches, and the
// output is returned as Blob-ready string PARTS so no single giant string join
// ever runs. Filtering goes through the SAME shared predicate as the BIP-329
// export (matchesExportFilter via matchesRecordExportFilter), so narrowing the
// CSV by search/type/tag/wallet behaves identically to narrowing the label
// export.

import { getRecordsAfterId } from "@/lib/data/record-crud";
import {
  matchesRecordExportFilter,
  recordExportKind,
  type Bip329ExportFilter,
  type Bip329FilterableRecord,
} from "@/lib/bip329";

// Records fetched per keyset batch (same rationale as the BIP-329 export).
export const CSV_EXPORT_BATCH_SIZE = 2000;

// The record fields one CSV row needs. Full records-table rows satisfy this
// directly; tests can use minimal rows.
export interface CsvExportableRecord extends Bip329FilterableRecord {
  owner?: string;
  categories?: string[];
  amount?: number;
  date?: string;
}

export const CSV_EXPORT_HEADER = [
  "Type",
  "Identifier",
  "Label",
  "Wallet",
  "Owner",
  "Tags",
  "Categories",
  "Notes",
  "Amount",
  "Date",
] as const;

// RFC 4180 field escaping: quote when the value contains a comma, quote, or
// line break; double embedded quotes.
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Spreadsheet formula-injection guard: cells beginning with = + - @ (or a
// tab/CR, including after leading whitespace) are interpreted as formulas by
// Excel/LibreOffice/Google Sheets. User- and import-controlled text must never
// reach the spreadsheet executable — prefix a literal apostrophe so the cell
// is rendered as text. Applied BEFORE RFC 4180 quoting.
export function csvSanitizeCell(value: string): string {
  return /^\s*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// Full treatment for a user-controlled string cell: neutralize formula sigils,
// then apply RFC 4180 escaping.
export function csvField(value: string): string {
  return csvEscape(csvSanitizeCell(value));
}

export function recordToCsvRow(record: CsvExportableRecord): string {
  // Every string cell is user- or import-controlled → sanitize + escape. The
  // amount cell is serialized from a number (a bare numeric literal like -1.5
  // is a number, not a formula, in every spreadsheet app), so it is escaped
  // but not apostrophe-prefixed — prefixing would corrupt negative amounts.
  const userCells = [
    record.inputString || "",
    record.label || "",
    record.walletName || "",
    record.owner || "",
    (record.tags ?? []).join("; "),
    (record.categories ?? []).join("; "),
    record.notes || "",
  ];
  const amountCell =
    record.amount !== undefined && record.amount !== null ? String(record.amount) : "";
  return [
    csvEscape(recordExportKind(record)),
    ...userCells.map(csvField),
    csvEscape(amountCell),
    csvField(record.date || ""),
  ].join(",");
}

export interface RecordsCsvExportResult {
  // CSV chunks in key order: parts[0] begins with the header row; every part
  // ends in "\r\n". Pass straight to `new Blob(parts, { type: "text/csv" })`.
  parts: string[];
  // Number of data rows written (excludes the header).
  rowCount: number;
  // Total records scanned (including rows the filter removed).
  scannedCount: number;
}

export interface RecordsCsvExportOptions {
  // Records per keyset batch (default CSV_EXPORT_BATCH_SIZE).
  batchSize?: number;
  // Optional filter (search/kind/tag/wallet); only matching records become
  // rows. Undefined exports every record.
  filter?: Bip329ExportFilter;
  // Called after each batch with (records scanned so far, rows written so far).
  onProgress?: (scanned: number, exported: number) => void;
  // How to yield to the event loop between batches. Injectable for tests.
  yieldControl?: () => Promise<void>;
}

export async function exportRecordsCsvParts(
  options: RecordsCsvExportOptions = {},
): Promise<RecordsCsvExportResult> {
  const batchSize = options.batchSize ?? CSV_EXPORT_BATCH_SIZE;
  const yieldControl =
    options.yieldControl ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  const parts: string[] = [CSV_EXPORT_HEADER.join(",") + "\r\n"];
  let rowCount = 0;
  let scannedCount = 0;
  let lastId = 0;

  for (;;) {
    const chunk = await getRecordsAfterId(lastId, batchSize);
    if (chunk.length === 0) break;
    lastId = chunk[chunk.length - 1].id ?? lastId;
    scannedCount += chunk.length;

    const batchRows: string[] = [];
    for (const record of chunk) {
      if (matchesRecordExportFilter(record, options.filter)) {
        batchRows.push(recordToCsvRow(record));
      }
    }
    if (batchRows.length > 0) {
      parts.push(batchRows.join("\r\n") + "\r\n");
      rowCount += batchRows.length;
    }

    options.onProgress?.(scannedCount, rowCount);
    if (chunk.length < batchSize) break;
    // Yield to the event loop between batches so a huge vault never freezes
    // the page while the export runs.
    await yieldControl();
  }

  return { parts, rowCount, scannedCount };
}
