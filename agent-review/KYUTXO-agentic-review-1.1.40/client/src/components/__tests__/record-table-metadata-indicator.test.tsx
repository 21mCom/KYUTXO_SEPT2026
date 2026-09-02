// @vitest-environment jsdom
//
// Regression coverage for the migrated Records screen (RecordTable.tsx). The
// table renders an AddressLink for address records and a TxidLink for
// transaction records, wiring only `recordId` (no `hasMetadata`). The metadata
// indicator (the orange FileText icon) is therefore HIDDEN until the hover
// tooltip opens and resolves the record's metadata via getRecordsByInputString.
// These tests lock in that both the address path and the txid path actually
// surface the indicator (and expose the link testid) for a record that has
// metadata. A regression that dropped the recordId/showMetadataIndicator wiring
// or stopped resolving metadata would fail here.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// metadata-hover resolves identifiers two ways: the single-hover path uses
// getRecordsByInputString, while the table's mount-time batch preload
// (batchPreloadIdentifiers) fans out to getRecordsByInputStrings. Stub BOTH so
// a metadata-rich record comes back for whatever identifier is resolved — if the
// plural path is left unmocked it queries the empty fake-IndexedDB, caches a
// "no metadata" result, and the later hover short-circuits on that cached miss.
const getRecordsByInputString = vi.fn();
const getRecordsByInputStrings = vi.fn();
vi.mock("@/lib/data/record-crud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/record-crud")>()),
  getRecordsByInputString: (...args: unknown[]) => getRecordsByInputString(...args),
  getRecordsByInputStrings: (...args: unknown[]) => getRecordsByInputStrings(...args),
}));

import { renderWithProviders } from "@/test/testProviders";
import { invalidateCachedRecord } from "@/lib/metadata-hover";
import { RecordTable } from "../RecordTable";
import type { Record as DbRecord } from "@/lib/database";

const ADDRESS = "bc1qmetaaddr00000000000000000000000000q0zz";
const TXID = "a".repeat(64);

function metaRecord(inputString: string): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "Cold Storage",
    owner: "Treasury",
    tags: [],
    categories: [],
    addressImportance: "verified",
  } as unknown as DbRecord;
}

const records: DbRecord[] = [
  {
    id: 11,
    type: "address",
    inputString: ADDRESS,
    label: "My Address",
    tags: [],
    categories: [],
  } as unknown as DbRecord,
  {
    id: 22,
    type: "transaction",
    inputString: TXID,
    label: "My Tx",
    tags: [],
    categories: [],
  } as unknown as DbRecord,
];

beforeEach(() => {
  getRecordsByInputString.mockImplementation((id: string) =>
    Promise.resolve([metaRecord(id)]),
  );
  getRecordsByInputStrings.mockImplementation((ids: string[]) =>
    Promise.resolve(ids.map((id) => metaRecord(id))),
  );
  // The metadata-hover cache is module-level and survives across test cases, so
  // a prior resolution would let the indicator show before the hover. Clear it.
  invalidateCachedRecord(ADDRESS);
  invalidateCachedRecord(TXID);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  invalidateCachedRecord(ADDRESS);
  invalidateCachedRecord(TXID);
});

describe("RecordTable metadata indicator", () => {
  it("renders the AddressLink and shows the FileText indicator after the tooltip resolves metadata", async () => {
    renderWithProviders(
      <RecordTable records={records} onEdit={vi.fn()} onDelete={vi.fn()} onRowClick={vi.fn()} />,
    );

    const link = screen.getByTestId(`link-address-${ADDRESS.slice(0, 8)}`);
    // Indicator is hidden until the tooltip resolves metadata.
    expect(link.querySelector(".lucide-file-text")).toBeNull();

    fireEvent.focus(link);

    await waitFor(() => {
      expect(
        screen
          .getByTestId(`link-address-${ADDRESS.slice(0, 8)}`)
          .querySelector(".lucide-file-text"),
      ).toBeTruthy();
    });
  });

  it("renders the TxidLink and shows the FileText indicator after the tooltip resolves metadata", async () => {
    renderWithProviders(
      <RecordTable records={records} onEdit={vi.fn()} onDelete={vi.fn()} onRowClick={vi.fn()} />,
    );

    const link = screen.getByTestId(`link-txid-${TXID.slice(0, 8)}`);
    expect(link.querySelector(".lucide-file-text")).toBeNull();

    fireEvent.focus(link);

    await waitFor(() => {
      expect(
        screen
          .getByTestId(`link-txid-${TXID.slice(0, 8)}`)
          .querySelector(".lucide-file-text"),
      ).toBeTruthy();
    });
  });
});
