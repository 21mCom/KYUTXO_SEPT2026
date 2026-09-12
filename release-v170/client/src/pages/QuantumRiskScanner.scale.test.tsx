// @vitest-environment jsdom
//
// Scale coverage for the Quantum Risk Scanner's tagging phase (Task #1737):
// on a large vault where (almost) every record needs a tag write, the phase
// must go through the chunked bulk write path (bulkPut on the records table)
// instead of one serial put per record — the serial path takes minutes
// at 10k+ records while the bulk path finishes in seconds.
//
// This test runs at moderate scale and asserts the WRITE SHAPE (zero
// per-record puts, chunk-count bulkPuts, correct resulting tags) rather than
// wall-clock time: fake-indexeddb's synchronous structured-clone plus the
// multiEntry tags index make bulkPut pathologically slow here (~22s per 500
// rows), so any timing assertion would measure the harness, not the app. The
// 10k-records-in-seconds guarantee is verified against real IndexedDB by
// scripts/check-quantum-scan-scale-browser.mjs instead.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// jsdom gives the page scroll element a 0-height rect, so the real
// @tanstack/react-virtual renders zero rows. Stub it to render every item
// (matching the UTXOs test pattern) — virtualization itself is verified in a
// real browser by scripts/check-quantum-scan-scale-browser.mjs.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 56,
      end: (index + 1) * 56,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 56,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));


import { db } from "@/lib/database";
import { bulkCreateRecords, clearAllRecords } from "@/lib/data/record-crud";
import { clearSettings } from "@/lib/data/settings-crud";
import QuantumRiskScanner from "./QuantumRiskScanner";

// Must stay in sync with the CHUNK_SIZE used by the page's tagging phase.
const CHUNK_SIZE = 500;

function makeAddressSeeds(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: "address" as const,
    // 66 hex chars → detected as p2pk → critical.
    inputString: "02" + i.toString(16).padStart(64, "0"),
    label: `Scale record ${i}`,
    source: "manual",
    addressImportance: "manual" as const,
    tags: [] as string[],
    categories: [] as string[],
  }));
}

beforeEach(async () => {
  await clearAllRecords();
  await clearSettings();
  await db.tags.clear();
}, 60_000);

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await clearAllRecords();
  await clearSettings();
  await db.tags.clear();
}, 60_000);

describe("QuantumRiskScanner — tagging phase at scale", () => {
  it(
    "tags changed records via chunked bulk writes (no per-record puts)",
    async () => {
      // Every record is a p2pk (critical) address with no quantum tag yet, so
      // under the default selection (critical + high) ALL of them need a write.
      const RECORD_COUNT = 1_200; // 3 chunks
      await bulkCreateRecords(makeAddressSeeds(RECORD_COUNT), { skipVocabularySync: true });

      // CRUD now goes through the repository adapter, which addresses the
      // table via Dexie's dynamic table() API.  Spy on that same table object
      // rather than the legacy typed property so the assertion observes the
      // actual write boundary.
      const recordsTable = db.table("records");
      const putSpy = vi.spyOn(recordsTable, "put");
      const bulkPutSpy = vi.spyOn(recordsTable, "bulkPut");

      render(<QuantumRiskScanner />);
      await waitFor(() => {
        expect(
          (screen.getByTestId("button-scan-records") as HTMLButtonElement).disabled,
        ).toBe(false);
      });

      fireEvent.click(screen.getByTestId("button-scan-records"));
      await waitFor(
        () => {
          expect(screen.getByTestId("text-status-message").textContent).toBe(
            `Scan complete. ${RECORD_COUNT} addresses classified, ${RECORD_COUNT} tagged.`,
          );
        },
        { timeout: 60_000, interval: 250 },
      );

      // Write shape: chunked bulk writes only — never a per-record put.
      expect(putSpy).not.toHaveBeenCalled();
      expect(bulkPutSpy).toHaveBeenCalledTimes(Math.ceil(RECORD_COUNT / CHUNK_SIZE));

      // Correctness: every record now carries exactly its quantum tag.
      const taggedCount = await db.records
        .where("tags")
        .equals("quantum:critical")
        .count();
      expect(taggedCount).toBe(RECORD_COUNT);
    },
    120_000,
  );
});
