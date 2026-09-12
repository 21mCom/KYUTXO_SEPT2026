// @vitest-environment jsdom
//
// Task: let users jump from a backup-diff row to the matching live record.
// The Compare Backups drill-down resolves identifier keys (record
// inputStrings, txids, sync-state addresses, dust-flag outpoints) against the
// LIVE vault read-only, batched + debounced, and renders the app's standard
// AddressLink only when a live record actually matches — plain text otherwise
// (compared backups may come from another device).
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, cleanup, waitFor } from "@testing-library/react";

// jsdom has no layout: render every row instead of a measured window.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 42,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 42,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));

import { renderWithProviders } from "@/test/testProviders";
import { TableDrillDown } from "./BackupCompareDialog";
import type { TableDiff } from "@/lib/backup/compare";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { invalidateCachedRecord } from "@/lib/metadata-hover";

// Distinct first-8 chars everywhere (AddressLink testids use slice(0,8)).
const LIVE_ADDR = "bc1qlivematch000000000000000000000aaaa11";
const MISSING_ADDR = "bc1qnomatch11111111111111111111111bbbb22";
const LIVE_TXID = "c0ffee11" + "a".repeat(56);
const MISSING_TXID = "deadbeef" + "b".repeat(56);

function diffOf(table: string, keys: string[]): TableDiff {
  return {
    table,
    label: table,
    added: keys.length,
    removed: 0,
    changed: 0,
    suppressed: 0,
    entries: keys.map((key) => ({ key, change: "added" as const })),
  };
}

describe("BackupCompareDialog diff-row live-record links", () => {
  beforeEach(async () => {
    await clearAllRecords();
    for (const id of [LIVE_ADDR, MISSING_ADDR, LIVE_TXID, MISSING_TXID]) {
      invalidateCachedRecord(id);
    }
  });

  afterEach(async () => {
    cleanup();
    await clearAllRecords();
  });

  it("renders an AddressLink for a records key that matches a live record, plain text otherwise", async () => {
    const recordId = await createRecord(
      { inputString: LIVE_ADDR, type: "address", label: "Cold storage" },
      { skipVocabularySync: true },
    );
    expect(recordId).toBeGreaterThan(0);

    renderWithProviders(<TableDrillDown diff={diffOf("records", [LIVE_ADDR, MISSING_ADDR])} />);

    // Both keys render immediately (plain text) before resolution.
    expect(screen.getByText(MISSING_ADDR)).toBeTruthy();

    // After the debounced batch resolution, the matching key becomes the
    // standard AddressLink; the unmatched one stays plain text.
    await waitFor(() => {
      expect(screen.getByTestId(`link-address-${LIVE_ADDR.slice(0, 8)}`)).toBeTruthy();
    });
    expect(screen.queryByTestId(`link-address-${MISSING_ADDR.slice(0, 8)}`)).toBeNull();
    expect(screen.getByText(MISSING_ADDR)).toBeTruthy();
  });

  it("links txid identifiers in other tables (blockchainTransactions, dustFlags outpoints)", async () => {
    await createRecord(
      { inputString: LIVE_TXID, type: "txid", label: "Known tx" },
      { skipVocabularySync: true },
    );

    renderWithProviders(
      <>
        <TableDrillDown diff={diffOf("blockchainTransactions", [LIVE_TXID, MISSING_TXID])} />
        <TableDrillDown diff={diffOf("dustFlags", [`${LIVE_TXID}:0`])} />
      </>,
    );

    await waitFor(() => {
      // Both the raw txid key and the outpoint's txid part link.
      expect(screen.getAllByTestId(`link-address-${LIVE_TXID.slice(0, 8)}`).length).toBe(2);
    });
    expect(screen.queryByTestId(`link-address-${MISSING_TXID.slice(0, 8)}`)).toBeNull();
    // The outpoint suffix stays visible as plain text next to the link.
    expect(screen.getByTestId("compare-key-link-dustFlags").textContent).toContain(":0");
  });

  it("never links keys of non-identifier tables or synthetic keys", async () => {
    await createRecord(
      { inputString: LIVE_ADDR, type: "address", label: "Cold storage" },
      { skipVocabularySync: true },
    );

    renderWithProviders(
      <>
        <TableDrillDown diff={diffOf("tags", [LIVE_ADDR])} />
        <TableDrillDown diff={diffOf("records", ["#id:42"])} />
      </>,
    );

    // Give the (never-scheduled) debounce a chance to have fired if wired wrong.
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByTestId(`link-address-${LIVE_ADDR.slice(0, 8)}`)).toBeNull();
    expect(screen.getByText("#id:42")).toBeTruthy();
  });
});
