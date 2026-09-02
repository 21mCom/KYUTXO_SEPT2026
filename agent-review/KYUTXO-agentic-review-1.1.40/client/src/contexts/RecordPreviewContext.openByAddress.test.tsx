// @vitest-environment jsdom
//
// Guard tests for the "click to add metadata" address flow (openRecordPreviewByAddress).
//
// - Clicking an identifier with an EXISTING record must open the detail panel
//   and prominently show the clicked identifier in the panel header.
// - Clicking an identifier with NO record must open the record-creation dialog
//   prefilled with that exact identifier (with the input type auto-detected) —
//   never dump the user on the Records page with a dropped search.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

import { vi } from "vitest";

// Mock the blockchain provider so the create dialog's "Fetch Data" resolves
// deterministically (no network), letting us test the tx-import save contract.
const TX_INPUT_ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const TX_OUTPUT_ADDR = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
vi.mock("@/lib/blockchain-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    createProviderFromSettings: () => ({
      getBlockHeight: async () => 1000,
      getTransaction: async () => ({ status: { confirmed: true, block_height: 900 } }),
    }),
    parseTransaction: () => ({
      txid: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
      blockHeight: 900,
      blockTime: 1600000000,
      fee: 100,
      feeRate: 1,
      inputs: [{ address: TX_INPUT_ADDR, amount: 100000 }],
      outputs: [{ address: TX_OUTPUT_ADDR, amount: 99900, vout: 0 }],
    }),
  };
});

import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { clickSaveButton } from "@/test/clickSave";
import { getRecordsByInputString } from "@/lib/data/record-crud";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { invalidateCachedRecord } from "@/lib/metadata-hover";
import { renderWithProviders } from "@/test/testProviders";

// Valid mainnet identifiers. First-8 chars differ so testids can't collide.
const KNOWN_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const UNKNOWN_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const UNKNOWN_TXID =
  "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

// Radix primitives inside the form dialog (Select, etc.) need ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

function Trigger({ identifier }: { identifier: string }) {
  const { openRecordPreviewByAddress } = useRecordPreview();
  return (
    <button
      data-testid="button-open-by-address"
      onClick={() => void openRecordPreviewByAddress(identifier)}
    >
      open
    </button>
  );
}

beforeEach(async () => {
  await clearAllRecords();
  invalidateCachedRecord(KNOWN_ADDRESS);
  invalidateCachedRecord(UNKNOWN_ADDRESS);
  invalidateCachedRecord(UNKNOWN_TXID);
});

afterEach(() => {
  cleanup();
});

describe("openRecordPreviewByAddress", () => {
  it("opens the detail panel showing the clicked identifier when a record exists", async () => {
    await createRecord({
      type: "address",
      inputString: KNOWN_ADDRESS,
      label: "Known Address",
      notes: "",
      tags: [],
      categories: [],
      source: "manual",
    } as any);

    renderWithProviders(<Trigger identifier={KNOWN_ADDRESS} />);
    fireEvent.click(screen.getByTestId("button-open-by-address"));

    await waitFor(() => {
      const header = screen.getByTestId("text-panel-identifier");
      expect(header.textContent).toBe(KNOWN_ADDRESS);
    });
    // The panel (not the create dialog) is what opened.
    expect(screen.queryByText("Create New Record")).toBeNull();
  });

  it("opens a prefilled CREATE dialog when no record exists for an address", async () => {
    renderWithProviders(<Trigger identifier={UNKNOWN_ADDRESS} />);
    fireEvent.click(screen.getByTestId("button-open-by-address"));

    // Create mode, not edit mode, despite the prefilled initial data.
    await waitFor(() => {
      expect(screen.getByText("Create New Record")).toBeTruthy();
    });

    const input = screen.getByTestId("input-address") as HTMLInputElement;
    expect(input.value).toBe(UNKNOWN_ADDRESS);
  });

  it("detects the transaction type when the clicked identifier is a txid", async () => {
    renderWithProviders(<Trigger identifier={UNKNOWN_TXID} />);
    fireEvent.click(screen.getByTestId("button-open-by-address"));

    await waitFor(() => {
      expect(screen.getByText("Create New Record")).toBeTruthy();
    });

    const input = screen.getByTestId("input-address") as HTMLInputElement;
    expect(input.value).toBe(UNKNOWN_TXID);
    // The "Fetch Data" button only renders for type === "transaction" in
    // create mode, so its presence proves the detected type carried through.
    expect(screen.getByTestId("button-fetch-tx")).toBeTruthy();
  });

  it("creates the tx record AND the promised input/output address records after Fetch Data + Save", async () => {
    renderWithProviders(<Trigger identifier={UNKNOWN_TXID} />);
    fireEvent.click(screen.getByTestId("button-open-by-address"));

    await waitFor(() => {
      expect(screen.getByText("Create New Record")).toBeTruthy();
    });

    // Fetch tx data — the dialog then promises input/output address records.
    fireEvent.click(screen.getByTestId("button-fetch-tx"));
    await waitFor(() => {
      // Save button copy switches to "Create 3 Records" once tx data loads.
      expect(screen.getByText(/Create 3 Records/)).toBeTruthy();
    });

    clickSaveButton();

    // The transaction record itself is persisted…
    await waitFor(async () => {
      const txRecords = await getRecordsByInputString(UNKNOWN_TXID);
      expect(txRecords.length).toBe(1);
      expect(txRecords[0].type).toBe("transaction");
    });
    // …and so are the promised pending-review address records.
    await waitFor(async () => {
      const inputRecs = await getRecordsByInputString(TX_INPUT_ADDR);
      const outputRecs = await getRecordsByInputString(TX_OUTPUT_ADDR);
      expect(inputRecs.length).toBe(1);
      expect(outputRecs.length).toBe(1);
      expect(inputRecs[0].addressImportance).toBe("pending-review");
      expect(outputRecs[0].addressImportance).toBe("pending-review");
    });
  });
});
