// @vitest-environment jsdom
//
// Navigation coverage for the peel-chain graph nodes (Task: "Verify graph nodes
// open the right records when scanning real data").
//
// The peel-chain graph (PeelChainGraph, rendered inside PeelChainView) draws a
// transaction node, a payment-address node and a change-address node per hop.
// Clicking a transaction or address node must open the RecordDetailPanel for the
// record that owns that txid/address, while placeholder "—" nodes (drawn when a
// hop has no participant data) must stay non-interactive and trigger nothing.
//
// We back the real Dexie database with fake-indexeddb and seed real records +
// transaction participants, then render the real PeelChainView through the real
// RecordPreviewProvider so the whole click → DB lookup → RecordDetailPanel path
// is exercised end to end.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { db } from "@/lib/database";
import { createRecord } from "@/lib/dataFacade";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
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
const CHANGE_LABEL = "My Change Address Record";

async function seedPeelChain() {
  // Records the nodes should resolve to when clicked.
  await createRecord(
    { type: "transaction", inputString: HOP1_TXID, label: TX_LABEL, source: "manual", tags: [], categories: [] },
    { skipVocabularySync: true },
  );
  await createRecord(
    { type: "address", inputString: PAYMENT_ADDR, label: PAYMENT_LABEL, source: "manual", tags: [], categories: [] },
    { skipVocabularySync: true },
  );
  await createRecord(
    { type: "address", inputString: CHANGE_ADDR, label: CHANGE_LABEL, source: "manual", tags: [], categories: [] },
    { skipVocabularySync: true },
  );

  // Real transaction + participants so PeelChainView builds a proper step.
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

beforeEach(async () => {
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await seedPeelChain();
});

afterEach(async () => {
  cleanup();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

describe("PeelChainGraph node navigation", () => {
  it("opens the transaction record when its node is clicked", async () => {
    const { getByTestId, findByText } = renderGraph();
    await waitForGraph(getByTestId);

    fireEvent.click(getByTestId("graph-tx-0"));

    // RecordDetailPanel surfaces the record label as its title.
    expect(await findByText(TX_LABEL)).toBeTruthy();
  });

  it("opens the correct address record for payment and change nodes", async () => {
    const { getByTestId, findByText, queryByText } = renderGraph();
    await waitForGraph(getByTestId);

    fireEvent.click(getByTestId("graph-payment-0"));
    expect(await findByText(PAYMENT_LABEL)).toBeTruthy();

    // Clicking the change node swaps the panel to that record.
    fireEvent.click(getByTestId("graph-change-0"));
    expect(await findByText(CHANGE_LABEL)).toBeTruthy();
    await waitFor(() => {
      expect(queryByText(PAYMENT_LABEL)).toBeNull();
    });
  });

  it("opens the forensic deep-dive dialog (not the record panel) from the node badge", async () => {
    const { getByTestId, findByTestId, findByText, queryByText } = renderGraph();
    await waitForGraph(getByTestId);

    // The badge calls e.stopPropagation() so it must not bubble into the
    // transaction node's record-preview navigation.
    fireEvent.click(getByTestId("button-graph-deep-dive-0"));

    // The DeepDiveDialog opens — its content and title are rendered.
    expect(await findByTestId("dialog-deep-dive")).toBeTruthy();
    expect(await findByText("Transaction Deep-Dive")).toBeTruthy();

    // The record-preview panel for the txid must NOT have opened (stopPropagation
    // honored). The dialog surfaces the raw txid, but never the record's label.
    await new Promise((r) => setTimeout(r, 50));
    expect(queryByText(TX_LABEL)).toBeNull();
  });

  it("does not open any record for a placeholder '—' node", async () => {
    const { getByTestId, queryByText } = renderGraph();
    await waitForGraph(getByTestId);

    // Hop 2 has no participant data, so its address nodes are placeholders.
    const placeholder = getByTestId("graph-payment-1");
    expect(placeholder.getAttribute("tabindex")).toBe("-1");
    expect(within(placeholder).getByText("—")).toBeTruthy();

    fireEvent.click(placeholder);
    fireEvent.click(getByTestId("graph-change-1"));

    // Nothing should have opened — no record panel, no navigation away.
    await new Promise((r) => setTimeout(r, 50));
    expect(queryByText(TX_LABEL)).toBeNull();
    expect(queryByText(PAYMENT_LABEL)).toBeNull();
    expect(queryByText(CHANGE_LABEL)).toBeNull();
    expect(getByTestId("container-peel-graph")).toBeTruthy();
  });
});
