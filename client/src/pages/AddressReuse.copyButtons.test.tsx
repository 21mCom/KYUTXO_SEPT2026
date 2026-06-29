// @vitest-environment jsdom
//
// Guard test for the AddressReuse page's inline copy buttons (wired by Task
// #538). The page exposes two inline copy affordances inside each expanded
// reused-address row:
//   • a "copy address" button that writes the full address to the clipboard, and
//   • a per-transaction "copy txid" button that writes the full txid.
// Both run through the page's inline `copyToClipboard(text, type)` helper, which
// now delegates to the shared useCopyToClipboard hook. It must BOTH call
// navigator.clipboard.writeText AND fire the correct toast:
//   - success: { description: "<type> copied" }
//   - failure: { title: "Copy failed", description: "Could not copy the <type>
//     to your clipboard.", variant: "destructive" }
//
// We back the real Dexie database with fake-indexeddb and seed a user-curated
// address record plus transaction participants that make the address "reused"
// (received funds across two distinct output txids → multi-receive). We then
// render the real page through the full provider stack + a real <Toaster/>,
// expand the address group, and exercise the click → writeText → toast paths.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { ActivityBusProvider } from "@/lib/activity-bus";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import { Toaster } from "@/components/ui/toaster";
import { createRecord } from "@/lib/dataFacade";
import { clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  addParticipant,
  clearAllTransactionData,
} from "@/lib/data/transaction-crud";
import AddressReuse from "./AddressReuse";

const ADDRESS = "bc1qreuseaddr000000000000000000000000000000xy";
const TXID1 =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TXID2 =
  "2222222222222222222222222222222222222222222222222222222222222222";

async function seedReusedAddress() {
  // A user-curated address record so the page treats it as one of YOUR
  // addresses (records branch, not counterparty).
  await createRecord(
    {
      type: "address",
      inputString: ADDRESS,
      label: "Reused Address Record",
      source: "manual",
      addressImportance: "manual",
      tags: [],
      categories: [],
    },
    { skipVocabularySync: true },
  );

  // Two distinct OUTPUT txids for the same address → multi-receive reuse.
  await addTransaction(
    { txid: TXID1, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addTransaction(
    { txid: TXID2, blockHeight: 800100, blockTime: 1_700_100_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TXID1, role: "output", address: ADDRESS, amount: 50_000, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TXID2, role: "output", address: ADDRESS, amount: 70_000, vout: 0 },
    { skipNotification: true },
  );
}

function renderPage() {
  const { hook } = memoryLocation({ path: "/address-reuse" });
  return render(
    <Router hook={hook}>
      <ActivityBusProvider>
        <TooltipProvider>
          <RecordPreviewProvider>
            <AddressReuse />
            <Toaster />
          </RecordPreviewProvider>
        </TooltipProvider>
      </ActivityBusProvider>
    </Router>,
  );
}

async function expandGroup(
  getAllByTestId: (id: string) => HTMLElement[],
  findByTestId: (id: string) => Promise<HTMLElement>,
) {
  const trigger = await findByTestId(`button-expand-address-${ADDRESS.slice(0, 8)}`);
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(getAllByTestId(`button-copy-address-${ADDRESS.slice(0, 8)}`).length).toBeGreaterThan(0);
  });
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });
  await seedReusedAddress();
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });
});

describe("AddressReuse copy buttons", () => {
  it("copies the full address and shows the success toast", async () => {
    const { getAllByTestId, findByTestId, findAllByText } = renderPage();
    await expandGroup(getAllByTestId, findByTestId);

    fireEvent.click(getAllByTestId(`button-copy-address-${ADDRESS.slice(0, 8)}`)[0]);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect((await findAllByText("Address copied")).length).toBeGreaterThan(0);
  });

  it("copies the full transaction id and shows the success toast", async () => {
    const { getAllByTestId, findByTestId, findAllByText } = renderPage();
    await expandGroup(getAllByTestId, findByTestId);

    fireEvent.click(getAllByTestId(`button-copy-txid-${TXID1.slice(0, 8)}`)[0]);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(TXID1);
    expect((await findAllByText("Transaction ID copied")).length).toBeGreaterThan(0);
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    writeText.mockRejectedValue(new Error("clipboard blocked"));

    const { getAllByTestId, findByTestId, findAllByText } = renderPage();
    await expandGroup(getAllByTestId, findByTestId);

    fireEvent.click(getAllByTestId(`button-copy-address-${ADDRESS.slice(0, 8)}`)[0]);

    // The write was still attempted with the full address...
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    // ...but it rejected, so the destructive failure toast surfaces.
    expect((await findAllByText("Copy failed")).length).toBeGreaterThan(0);
    expect((await findAllByText("Could not copy the address to your clipboard.")).length).toBeGreaterThan(0);
  });
});
