// @vitest-environment jsdom
//
// Regression coverage for UTXODetailPanel. Clicking a UTXO row opens this
// panel, which surfaces the UTXO's address and funding transaction id through
// the shared AddressLink / TxidLink components. Those links pass only the
// address/txid (AddressLink additionally passes the address `recordId`, no
// `hasMetadata`), so the orange FileText metadata indicator stays HIDDEN until
// the hover tooltip resolves a metadata-rich record via getRecordsByInputString.
// These tests lock in that both the address path and the txid path actually
// surface that indicator. A regression that dropped the AddressLink/TxidLink
// metadata wiring (e.g. reverting to plain text spans) would fail here.
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

// The panel's funding-transaction effect reaches into the data facade on mount.
// Stub those reads so the test stays fast and isolated from IndexedDB state.
// Hoist the mocks so individual tests can override the funding reads.
const facadeMocks = vi.hoisted(() => ({
  getTransactionByTxid: vi.fn(),
  getParticipantsByTxid: vi.fn(),
  getRecordsByType: vi.fn(),
}));
vi.mock("@/lib/dataFacade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dataFacade")>()),
  getTransactionByTxid: facadeMocks.getTransactionByTxid,
  getParticipantsByTxid: facadeMocks.getParticipantsByTxid,
  getRecordsByType: facadeMocks.getRecordsByType,
}));

import { renderWithProviders } from "@/test/testProviders";
import { UTXODetailPanel } from "./UTXODetailPanel";
import { invalidateCachedRecord } from "@/lib/metadata-hover";
import type { Record as DbRecord } from "@/lib/database";

const ADDRESS = "bc1qmetaaddr00000000000000000000000000q0zz";
const TXID = "c".repeat(64);
const FUNDING_ADDRESS = "bc1qfundinput0000000000000000000000000q9aa";

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

const utxo = {
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

beforeEach(() => {
  getRecordsByInputString.mockImplementation((id: string) =>
    Promise.resolve([metaRecord(id)]),
  );
  // Default funding reads: no transaction / inputs / records. Individual tests
  // override getParticipantsByTxid to exercise the funding-input render path.
  facadeMocks.getTransactionByTxid.mockResolvedValue(null);
  facadeMocks.getParticipantsByTxid.mockResolvedValue([]);
  facadeMocks.getRecordsByType.mockResolvedValue([]);
  // The metadata-hover cache is module-level and survives across test cases;
  // clear identifiers so each test starts with the indicator hidden.
  invalidateCachedRecord(ADDRESS);
  invalidateCachedRecord(TXID);
  invalidateCachedRecord(FUNDING_ADDRESS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  invalidateCachedRecord(ADDRESS);
  invalidateCachedRecord(TXID);
  invalidateCachedRecord(FUNDING_ADDRESS);
});

describe("UTXODetailPanel metadata indicator", () => {
  it("renders the address AddressLink and shows the FileText indicator after the tooltip resolves metadata", async () => {
    renderWithProviders(
      <UTXODetailPanel open={true} onClose={vi.fn()} utxo={utxo} />,
    );

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

  it("renders the transaction TxidLink and shows the FileText indicator after the tooltip resolves metadata", async () => {
    renderWithProviders(
      <UTXODetailPanel open={true} onClose={vi.fn()} utxo={utxo} />,
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

  it("renders each funding-input address as an AddressLink that surfaces the FileText indicator after hover", async () => {
    facadeMocks.getParticipantsByTxid.mockResolvedValue([
      { txid: TXID, address: FUNDING_ADDRESS, role: "input", amount: 50_000_000 },
    ]);

    renderWithProviders(
      <UTXODetailPanel open={true} onClose={vi.fn()} utxo={utxo} />,
    );

    const link = await screen.findByTestId(
      `link-address-${FUNDING_ADDRESS.slice(0, 8)}`,
    );
    expect(link.querySelector(".lucide-file-text")).toBeNull();

    fireEvent.focus(link);

    await waitFor(() => {
      expect(
        screen
          .getByTestId(`link-address-${FUNDING_ADDRESS.slice(0, 8)}`)
          .querySelector(".lucide-file-text"),
      ).toBeTruthy();
    });
  });
});
