// @vitest-environment jsdom
//
// Regression coverage for the migrated Transactions screen. TransactionCard
// renders a TxidLink in its header (no recordId) and an AddressLink for every
// linked input/output participant (recordId from the addressToRecord map).
// Neither passes `hasMetadata`, so the orange FileText indicator only appears
// once the hover tooltip resolves the record's metadata. These tests lock in
// that both the txid path (header) and the address path (output participant)
// surface the indicator and expose their link testids.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const getRecordsByInputString = vi.fn();
vi.mock("@/lib/data/record-crud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/record-crud")>()),
  getRecordsByInputString: (...args: unknown[]) => getRecordsByInputString(...args),
}));

import { renderWithProviders } from "@/test/testProviders";
import { TransactionCard } from "./Transactions";
import type {
  BlockchainTransaction,
  TransactionParticipant,
  Record as DbRecord,
} from "@/lib/database";

const TXID = "b".repeat(64);
const OUT_ADDRESS = "bc1qoutputaddr0000000000000000000000000q1zz";

function metaRecord(inputString: string): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString,
    label: "Exchange Hot Wallet",
    owner: "Acme Exchange",
    tags: [],
    categories: [],
    addressImportance: "verified",
  } as unknown as DbRecord;
}

const tx = {
  id: 1,
  txid: TXID,
  blockTime: 1_600_000_000,
  blockHeight: 600_000,
  fee: 1_000,
  feeRate: 5,
  vsize: 200,
  hasOpReturn: false,
} as unknown as BlockchainTransaction;

const outputs = [
  {
    id: 1,
    txid: TXID,
    address: OUT_ADDRESS,
    amount: 100_000_000,
    role: "output",
    vout: 0,
  } as unknown as TransactionParticipant,
];

const addressToRecord = new Map<string, DbRecord>([
  [
    OUT_ADDRESS,
    {
      id: 99,
      type: "address",
      inputString: OUT_ADDRESS,
      label: "Exchange Hot Wallet",
      tags: [],
      categories: [],
    } as unknown as DbRecord,
  ],
]);

function renderCard() {
  return renderWithProviders(
    <TransactionCard
      tx={tx}
      inputs={[]}
      outputs={outputs}
      totalOutputValue={100_000_000}
      isExpanded={true}
      onToggleExpand={vi.fn()}
      addressToRecord={addressToRecord}
      participantsLoaded={true}
    />,
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

describe("Transactions TransactionCard metadata indicator", () => {
  it("renders the header TxidLink and shows the FileText indicator after the tooltip resolves metadata", async () => {
    renderCard();

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

  it("renders the output AddressLink and shows the FileText indicator after the tooltip resolves metadata", async () => {
    renderCard();

    const link = screen.getByTestId(`link-address-${OUT_ADDRESS.slice(0, 8)}`);
    expect(link.querySelector(".lucide-file-text")).toBeNull();

    fireEvent.focus(link);

    await waitFor(() => {
      expect(
        screen
          .getByTestId(`link-address-${OUT_ADDRESS.slice(0, 8)}`)
          .querySelector(".lucide-file-text"),
      ).toBeTruthy();
    });
  });
});
