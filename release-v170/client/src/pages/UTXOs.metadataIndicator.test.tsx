// @vitest-environment jsdom
//
// Regression coverage for the migrated UTXOs screen. A full-page render of
// UTXOs hangs/OOMs in the test environment (it pulls in the engine read path,
// a virtualized flattened-row table, and peripheral components), so instead we
// test the extracted presentational row renderer (UtxoTableRow) in isolation.
// The group row renders an AddressLink and the per-UTXO row renders a TxidLink,
// both wired only with `recordId` (no `hasMetadata`). The orange FileText
// indicator is therefore HIDDEN until the hover tooltip resolves the record's
// metadata via getRecordsByInputString. These tests lock in that both the
// address path and the txid path actually surface the indicator (and expose
// their link testids) for a record that has metadata. A regression that dropped
// the recordId/showMetadataIndicator wiring would fail here.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// metadata-hover resolves identifiers through getRecordsByInputString; stub it
// so a metadata-rich record comes back for whatever identifier is resolved.
const getRecordsByInputString = vi.fn();
vi.mock("@/lib/data/record-crud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/record-crud")>()),
  getRecordsByInputString: (...args: unknown[]) => getRecordsByInputString(...args),
}));

import { renderWithProviders } from "@/test/testProviders";
import { UtxoTableRow, type AddressGroup, type UTXO, type FlatUtxoRow } from "./UTXOs";
import type { Record as DbRecord } from "@/lib/database";

const ADDRESS = "bc1qmetaaddr00000000000000000000000000q0zz";
const TXID = "c".repeat(64);

function metaRecord(inputString: string): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString,
    label: "Cold Storage",
    owner: "Treasury",
    tags: [],
    categories: [],
    addressImportance: "verified",
  } as unknown as DbRecord;
}

const utxo: UTXO = {
  id: `${TXID}:0`,
  txid: TXID,
  vout: 0,
  address: ADDRESS,
  amountSats: 100_000_000,
  blockTime: 1_600_000_000,
  blockHeight: 600_000,
  recordId: 11,
  valueAtReceipt: 1234,
};

const group: AddressGroup = {
  address: ADDRESS,
  totalSats: 100_000_000,
  utxos: [utxo],
  earliestDate: 1_600_000_000,
  latestDate: 1_600_000_000,
  recordId: 11,
  totalValueAtReceipt: 1234,
  totalCurrentValue: 2345,
  gain: 1111,
  gainPercent: 90,
};

const groupRow: FlatUtxoRow = { kind: "group", group };
const utxoRow: FlatUtxoRow = { kind: "utxo", utxo, index: 0 };

function renderRow(row: FlatUtxoRow) {
  return renderWithProviders(
    <table>
      <tbody>
        <UtxoTableRow
          row={row}
          isExpanded={row.kind === "group"}
          displayUnit="btc"
          onToggleGroup={vi.fn()}
          onOpenUtxo={vi.fn()}
        />
      </tbody>
    </table>,
  );
}

beforeEach(() => {
  getRecordsByInputString.mockImplementation((id: string) =>
    Promise.resolve([metaRecord(id)]),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UTXOs UtxoTableRow metadata indicator", () => {
  it("renders the group AddressLink and shows the FileText indicator after the tooltip resolves metadata", async () => {
    renderRow(groupRow);

    const link = screen.getByTestId(`link-address-${ADDRESS.slice(0, 8)}`);
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

  it("renders the per-UTXO TxidLink and shows the FileText indicator after the tooltip resolves metadata", async () => {
    renderRow(utxoRow);

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
