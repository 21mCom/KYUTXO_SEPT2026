// @vitest-environment jsdom
//
// Coverage for the CoinJoin (mixing) highlight in the peel-chain graph
// (Task: "Test the CoinJoin highlighting in the peel-chain graph").
//
// PeelChainGraph (rendered inside PeelChainView) draws a transaction node per
// hop. Hops whose txid is in the `coinjoinTxids` set get a highlight ring, a
// "⇄" marker (data-testid="graph-coinjoin-{i}") and a data-coinjoin="true"
// attribute on their node, while ordinary hops get none of these. A legend
// entry (data-testid="legend-peel-coinjoin") explains the marker.
//
// We seed two real hops in the Dexie database (backed by fake-indexeddb) and
// render the real PeelChainView so the highlight is driven by the same
// coinjoinTxids → node-rendering path the app uses.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { TooltipProvider } from "@/components/ui/tooltip";
import { db } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import { PeelChainView } from "./PrivacyAudit";

// Hop 0 is a CoinJoin (mixing) hop, hop 1 is an ordinary peel hop.
const COINJOIN_TXID =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const PLAIN_TXID =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

const INPUT_ADDR = "bc1qpeelinput00000000000000000000000000000aa";
const PAYMENT_ADDR = "bc1qpeelpayment0000000000000000000000000000bb";
const CHANGE_ADDR = "bc1qpeelchange00000000000000000000000000000cc";

async function seedHop(txid: string, blockTime: number) {
  await addTransaction(
    { txid, blockHeight: 800000, blockTime, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid, role: "input", address: INPUT_ADDR, amount: 100_000, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid, role: "output", address: CHANGE_ADDR, amount: 30_000, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid, role: "output", address: PAYMENT_ADDR, amount: 69_000, vout: 1 },
    { skipNotification: true },
  );
}

function renderGraph() {
  const { hook } = memoryLocation({ path: "/privacy-audit" });
  return render(
    <Router hook={hook}>
      <TooltipProvider>
        <RecordPreviewProvider>
          <PeelChainView
            txids={[COINJOIN_TXID, PLAIN_TXID]}
            changeAddresses={[CHANGE_ADDR]}
            coinjoinTxids={new Set<string>([COINJOIN_TXID])}
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
  await seedHop(COINJOIN_TXID, 1_700_000_000);
  await seedHop(PLAIN_TXID, 1_700_000_100);
});

afterEach(async () => {
  cleanup();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

describe("PeelChainGraph CoinJoin highlighting", () => {
  it("shows the CoinJoin marker only on hops in the coinjoinTxids set", async () => {
    const { getByTestId, queryByTestId } = renderGraph();
    await waitForGraph(getByTestId);

    // Hop 0 is a CoinJoin hop → marker present.
    expect(queryByTestId("graph-coinjoin-0")).toBeTruthy();
    // Hop 1 is an ordinary hop → no marker.
    expect(queryByTestId("graph-coinjoin-1")).toBeNull();
  });

  it("sets data-coinjoin only on the CoinJoin hop's node", async () => {
    const { getByTestId } = renderGraph();
    await waitForGraph(getByTestId);

    expect(getByTestId("graph-tx-0").getAttribute("data-coinjoin")).toBe("true");
    expect(getByTestId("graph-tx-1").getAttribute("data-coinjoin")).toBeNull();
  });

  it("renders the CoinJoin legend entry", async () => {
    const { getByTestId } = renderGraph();
    await waitForGraph(getByTestId);

    expect(getByTestId("legend-peel-coinjoin")).toBeTruthy();
  });

  it("shows no CoinJoin markers when the set is empty", async () => {
    const { hook } = memoryLocation({ path: "/privacy-audit" });
    const { getByTestId, queryByTestId } = render(
      <Router hook={hook}>
        <TooltipProvider>
          <RecordPreviewProvider>
            <PeelChainView
              txids={[COINJOIN_TXID, PLAIN_TXID]}
              changeAddresses={[CHANGE_ADDR]}
              coinjoinTxids={new Set<string>()}
            />
          </RecordPreviewProvider>
        </TooltipProvider>
      </Router>,
    );
    await waitForGraph(getByTestId);

    expect(queryByTestId("graph-coinjoin-0")).toBeNull();
    expect(queryByTestId("graph-coinjoin-1")).toBeNull();
    // Legend remains regardless so users learn what the marker means.
    expect(getByTestId("legend-peel-coinjoin")).toBeTruthy();
  });
});
