// BIP-329 label export at scale.
//
// Walking the whole records table with a single Dexie `.each` cursor and then
// joining every line into one giant string stalls the renderer on huge vaults
// (measured: ~150ms join + ~330ms Blob copy for 100k records, growing linearly
// — a visible page freeze at hundreds of thousands). This helper instead:
//
//   1. Iterates records in keyset batches (id cursor), yielding to the event
//      loop between batches so the page keeps painting and stays interactive.
//   2. Returns the JSONL as Blob-ready string PARTS (one per batch) instead of
//      one concatenated string, so no single giant join/copy ever runs and
//      peak transient memory stays bounded. `new Blob(parts)` concatenates the
//      parts lazily in the browser without a main-thread string copy.
//
// The joined parts are byte-identical to `lines.join("\n") + "\n"` from the
// old implementation (every part ends in a newline).

import { getRecordsAfterId } from "@/lib/data/record-crud";
import {
  recordToBip329Line,
  matchesBip329ExportFilter,
  type Bip329ExportFilter,
} from "@/lib/bip329";

// Records fetched per keyset batch. Large enough that IndexedDB round-trips
// stay cheap, small enough that one batch of convert+stringify is ~1ms.
export const BIP329_EXPORT_BATCH_SIZE = 2000;

export interface Bip329LabelExportResult {
  // JSONL chunks in key order, each ending in "\n". Pass straight to
  // `new Blob(parts, { type: "application/jsonl" })`.
  parts: string[];
  // Number of BIP-329 lines written (labeled, exportable records only).
  lineCount: number;
  // Total records scanned (including unlabeled/unexportable rows).
  scannedCount: number;
}

export interface Bip329LabelExportOptions {
  // Records per keyset batch (default BIP329_EXPORT_BATCH_SIZE).
  batchSize?: number;
  // Optional filter (search/kind/tag/wallet); only matching lines are
  // exported. Undefined exports every labeled, exportable record.
  filter?: Bip329ExportFilter;
  // Called after each batch with (records scanned so far, lines exported so far).
  onProgress?: (scanned: number, exported: number) => void;
  // How to yield to the event loop between batches. Injectable for tests.
  yieldControl?: () => Promise<void>;
}

export async function exportBip329LabelParts(
  options: Bip329LabelExportOptions = {},
): Promise<Bip329LabelExportResult> {
  const batchSize = options.batchSize ?? BIP329_EXPORT_BATCH_SIZE;
  const yieldControl =
    options.yieldControl ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  const parts: string[] = [];
  let lineCount = 0;
  let scannedCount = 0;
  let lastId = 0;

  for (;;) {
    const chunk = await getRecordsAfterId(lastId, batchSize);
    if (chunk.length === 0) break;
    lastId = chunk[chunk.length - 1].id ?? lastId;
    scannedCount += chunk.length;

    const batchLines: string[] = [];
    for (const record of chunk) {
      const line = recordToBip329Line(record);
      if (line && matchesBip329ExportFilter(record, line, options.filter)) {
        batchLines.push(JSON.stringify(line));
      }
    }
    if (batchLines.length > 0) {
      parts.push(batchLines.join("\n") + "\n");
      lineCount += batchLines.length;
    }

    options.onProgress?.(scannedCount, lineCount);
    if (chunk.length < batchSize) break;
    // Yield to the event loop between batches so a huge vault never freezes
    // the page while the export runs.
    await yieldControl();
  }

  return { parts, lineCount, scannedCount };
}
