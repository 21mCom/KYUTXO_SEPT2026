// @vitest-environment jsdom
//
// Action coverage for the peel-chain graph nodes (Task: "Add tests for the
// peel-chain graph node actions").
//
// Beyond plain navigation (covered in PrivacyAudit.peelGraph.test.tsx), the
// peel-chain graph nodes now expose two affordances:
//   • payment/change address nodes carry a "copy address" badge that writes the
//     full address to the clipboard and shows a confirmation toast, and
//   • transaction nodes carry a "deep-dive" badge that opens the forensic
//     Transaction Deep-Dive dialog for that exact txid.
// These badges must be both mouse- and keyboard-operable, must copy/open the
// correct value, and must not appear at all for placeholder "—" address nodes.
//
// We back the real Dexie database with fake-indexeddb and seed real records +
// transaction participants, then render the real PeelChainView through the real
// RecordPreviewProvider and Toaster so the whole click → copy → toast path and
// the click → deep-dive dialog path are exercised end to end.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { createRecord } from "@/lib/dataFacade";
import { clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  addParticipant,
  clearAllTransactionData,
} from "@/lib/data/transaction-crud";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import { PeelChainView } from "./PrivacyAudit";

// A fully-seeded hop and a second hop with no participant data (placeholder).
const HOP1_TXID =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const HOP2_TXID =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

const INPUT_ADDR = "bc1qpeelinput00000000000000000000000000000aa";
const PAYMENT_ADDR = "bc1qpeelpayment0000000000000000000000000000bb";
const CHANGE_ADDR = "bc1qpeelchange00000000000000000000000000000cc";

const TX_LABEL = "Hop One Transaction Record";
const PAYMENT_LABEL = "External Payment Address Record";

async function seedPeelChain() {
  // Records the nodes resolve to if (and only if) a node click bubbles through.
  await createRecord(
    { type: "transaction", inputString: HOP1_TXID, label: TX_LABEL, source: "manual", tags: [], categories: [] },
    { skipVocabularySync: true },
  );
  await createRecord(
    { type: "address", inputString: PAYMENT_ADDR, label: PAYMENT_LABEL, source: "manual", tags: [], categories: [] },
    { skipVocabularySync: true },
  );

  await addTransaction(
    { txid: HOP1_TXID, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: HOP1_TXID, role: "input", address: INPUT_ADDR, amount: 100_000, vout: 0 },
    { skipNotification: true },
  );
  // Change output (smaller, matches changeAddresses) and the external payment output.
  await addParticipant(
    { txid: HOP1_TXID, role: "output", address: CHANGE_ADDR, amount: 30_000, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: HOP1_TXID, role: "output", address: PAYMENT_ADDR, amount: 69_000, vout: 1 },
    { skipNotification: true },
  );
  // HOP2_TXID intentionally has no participants → its address nodes render "—".
}

function renderGraph() {
  const { hook } = memoryLocation({ path: "/privacy-audit" });
  return render(
    <Router hook={hook}>
      <TooltipProvider>
        <RecordPreviewProvider>
          <PeelChainView
            txids={[HOP1_TXID, HOP2_TXID]}
            changeAddresses={[CHANGE_ADDR]}
            coinjoinTxids={new Set<string>()}
          />
          <Toaster />
        </RecordPreviewProvider>
      </TooltipProvider>
    </Router>,
  );
}

async function waitForGraph(getByTestId: (id: string) => HTMLElement) {
  await waitFor(() => {
    expect(getByTestId("container-peel-graph")).toBeTruthy();
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
  await seedPeelChain();
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });
});

describe("PeelChainGraph copy-address badges", () => {
  it("copies the full payment address and shows a confirmation toast on click", async () => {
    const { getByTestId, findAllByText } = renderGraph();
    await waitForGraph(getByTestId);

    fireEvent.click(getByTestId("button-graph-copy-payment-0"));

    expect(writeText).toHaveBeenCalledTimes(1);
    // The full address is copied, not the truncated "bc1qpe…0000bb" label.
    expect(writeText).toHaveBeenCalledWith(PAYMENT_ADDR);

    // Confirmation toast surfaces.
    expect((await findAllByText("Address copied")).length).toBeGreaterThan(0);
  });

  it("copies the full change address on click", async () => {
    const { getByTestId, findAllByText } = renderGraph();
    await waitForGraph(getByTestId);

    fireEvent.click(getByTestId("button-graph-copy-change-0"));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(CHANGE_ADDR);
    expect((await findAllByText("Address copied")).length).toBeGreaterThan(0);
  });

  it("copies via keyboard activation (Enter and Space)", async () => {
    const { getByTestId } = renderGraph();
    await waitForGraph(getByTestId);

    const paymentBadge = getByTestId("button-graph-copy-payment-0");
    expect(paymentBadge.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(paymentBadge, { key: "Enter" });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith(PAYMENT_ADDR);

    fireEvent.keyDown(paymentBadge, { key: " " });
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(PAYMENT_ADDR);

    // Change badge is keyboard-operable too.
    fireEvent.keyDown(getByTestId("button-graph-copy-change-0"), { key: "Enter" });
    expect(writeText).toHaveBeenCalledTimes(3);
    expect(writeText).toHaveBeenLastCalledWith(CHANGE_ADDR);
  });

  it("does not open the record preview when the copy badge is used (stopPropagation)", async () => {
    const { getByTestId, queryByText } = renderGraph();
    await waitForGraph(getByTestId);

    fireEvent.click(getByTestId("button-graph-copy-payment-0"));
    expect(writeText).toHaveBeenCalledWith(PAYMENT_ADDR);

    // The copy click must not bubble to the payment node and open its record
    // preview — if it did, the panel would surface PAYMENT_LABEL.
    await new Promise((r) => setTimeout(r, 50));
    expect(queryByText(PAYMENT_LABEL)).toBeNull();
  });

  it("renders no copy badge for a placeholder '—' address node", async () => {
    const { getByTestId, queryByTestId } = renderGraph();
    await waitForGraph(getByTestId);

    // Hop 2 has no participant data, so both of its address nodes are "—".
    expect(within(getByTestId("graph-payment-1")).getByText("—")).toBeTruthy();
    expect(within(getByTestId("graph-change-1")).getByText("—")).toBeTruthy();

    // No copy affordance should be rendered for placeholder nodes.
    expect(queryByTestId("button-graph-copy-payment-1")).toBeNull();
    expect(queryByTestId("button-graph-copy-change-1")).toBeNull();

    // The fully-seeded hop 1 still has its copy badges.
    expect(queryByTestId("button-graph-copy-payment-0")).toBeTruthy();
    expect(queryByTestId("button-graph-copy-change-0")).toBeTruthy();
  });
});

describe("PeelChainGraph copy-address failure branch", () => {
  it("shows a destructive 'Copy failed' toast when the clipboard write is rejected", async () => {
    // Simulate a denied/unavailable clipboard (e.g. permission denied).
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));

    const { getByTestId, findAllByText } = renderGraph();
    await waitForGraph(getByTestId);

    fireEvent.click(getByTestId("button-graph-copy-payment-0"));

    // The write was still attempted with the full address...
    expect(writeText).toHaveBeenCalledWith(PAYMENT_ADDR);
    // ...but it rejected, so the destructive failure toast surfaces (and the
    // happy-path "Address copied" toast must NOT).
    expect((await findAllByText("Copy failed")).length).toBeGreaterThan(0);
    expect(
      (await findAllByText("Could not copy the address to your clipboard.")).length,
    ).toBeGreaterThan(0);
  });

  it("does not switch the badge to its copied (Check) state when the write fails", async () => {
    writeText.mockRejectedValue(new Error("clipboard blocked"));

    const { getByTestId, findAllByText } = renderGraph();
    await waitForGraph(getByTestId);

    const badge = getByTestId("button-graph-copy-change-0");
    // Pre-condition: the badge starts showing the Copy icon, not the Check icon.
    expect(badge.querySelector(".lucide-copy")).toBeTruthy();
    expect(badge.querySelector(".lucide-check")).toBeNull();

    fireEvent.click(badge);

    // Wait for the failure path to actually run (toast confirms the catch fired).
    await findAllByText("Copy failed");

    // The badge must remain in its un-copied (Copy) state and never flip to the
    // Check confirmation icon, since nothing was actually copied.
    expect(badge.querySelector(".lucide-check")).toBeNull();
    expect(badge.querySelector(".lucide-copy")).toBeTruthy();
  });
});

describe("PeelChainGraph deep-dive badge", () => {
  it("opens the deep-dive dialog for the right transaction on click", async () => {
    const { getByTestId, findByTestId } = renderGraph();
    await waitForGraph(getByTestId);

    fireEvent.click(getByTestId("button-graph-deep-dive-0"));

    const dialog = await findByTestId("dialog-deep-dive");
    // The dialog's description carries the full txid being analysed.
    expect(within(dialog).getByText(HOP1_TXID)).toBeTruthy();
  });

  it("opens the deep-dive dialog via Enter key activation", async () => {
    const { getByTestId, findByTestId } = renderGraph();
    await waitForGraph(getByTestId);

    const badge = getByTestId("button-graph-deep-dive-0");
    expect(badge.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(badge, { key: "Enter" });
    const dialog = await findByTestId("dialog-deep-dive");
    expect(within(dialog).getByText(HOP1_TXID)).toBeTruthy();
  });

  it("opens the deep-dive for the right txid via Space key on a later hop", async () => {
    const { getByTestId, findByTestId } = renderGraph();
    await waitForGraph(getByTestId);

    // A placeholder hop still exposes a deep-dive badge (the txid is known even
    // without participants); activating it with Space must target HOP2_TXID.
    const badge = getByTestId("button-graph-deep-dive-1");
    expect(badge.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(badge, { key: " " });
    const dialog = await findByTestId("dialog-deep-dive");
    expect(within(dialog).getByText(HOP2_TXID)).toBeTruthy();
  });

  it("does not open the record preview when the deep-dive badge is used (stopPropagation)", async () => {
    const { getByTestId, findByTestId, queryByText } = renderGraph();
    await waitForGraph(getByTestId);

    fireEvent.click(getByTestId("button-graph-deep-dive-0"));
    await findByTestId("dialog-deep-dive");

    // The deep-dive click must not bubble to the tx node and open its record
    // preview — if it did, the panel would surface TX_LABEL.
    expect(queryByText(TX_LABEL)).toBeNull();
  });
});
