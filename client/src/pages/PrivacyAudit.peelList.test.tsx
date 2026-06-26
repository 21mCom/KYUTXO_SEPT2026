// @vitest-environment jsdom
//
// Coverage for the peel-chain *list* view (Task: "Test the list view of the
// peel-chain graph").
//
// PeelChainView (rendered inside PrivacyAudit) toggles between a graph and a
// list mode via `button-peel-view-graph` / `button-peel-view-list`. The chosen
// mode is persisted to the settings store under `peelChainViewMode` (via
// updatePeelChainViewMode) so it survives reopening a finding / reloading.
//
// Existing peel-chain tests only exercise graph mode. These tests cover the
// list branch:
//   - Switching to list renders one card per hop (`card-peel-step-{i}`) with the
//     correct carriedIn / payment / change amounts and the payment + change
//     addresses.
//   - Toggling the mode persists `peelChainViewMode` to the settings store and a
//     freshly mounted view opens straight into the persisted mode.
//   - CoinJoin hops are surfaced in the list as ordinary hop rows whose values
//     render normally and which expose the per-hop deep-dive entry point (the
//     list carries the coinjoin context through to that dialog; the dialog's own
//     CoinJoin diagram is covered by a separate deep-dive test).
//
// Backed by the real Dexie database (fake-indexeddb) and real settings store so
// the click -> settings write -> useLiveQuery -> re-render path is exercised end
// to end.

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
import { db, type Settings } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { getSettings } from "@/lib/data/settings-crud";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import { PeelChainView } from "./PrivacyAudit";

// Hop 0 is a CoinJoin (mixing) hop, hop 1 is an ordinary peel hop. Both are
// fully seeded so the list rows carry real carriedIn / payment / change values.
const COINJOIN_TXID =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const PLAIN_TXID =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

const INPUT_ADDR = "bc1qpeelinput00000000000000000000000000000aa";
const PAYMENT_ADDR = "bc1qpeelpayment0000000000000000000000000000bb";
const CHANGE_ADDR = "bc1qpeelchange00000000000000000000000000000cc";

// 100_000 in, 30_000 change (matches CHANGE_ADDR), 69_000 peeled to payment.
const CARRIED_IN_BTC = "0.001000";
const PAYMENT_BTC = "0.000690";
const CHANGE_BTC = "0.000300";

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

function renderView(coinjoinTxids = new Set<string>([COINJOIN_TXID])) {
  const { hook } = memoryLocation({ path: "/privacy-audit" });
  return render(
    <Router hook={hook}>
      <TooltipProvider>
        <RecordPreviewProvider>
          <PeelChainView
            txids={[COINJOIN_TXID, PLAIN_TXID]}
            changeAddresses={[CHANGE_ADDR]}
            coinjoinTxids={coinjoinTxids}
          />
        </RecordPreviewProvider>
      </TooltipProvider>
    </Router>,
  );
}

// Wait for the loading spinner to clear and the toggle controls to mount.
async function waitForToggle(getByTestId: (id: string) => HTMLElement) {
  await waitFor(() => {
    expect(getByTestId("button-peel-view-list")).toBeTruthy();
  });
}

beforeEach(async () => {
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await db.settings.clear();
  // A default settings row must exist or updatePeelChainViewMode is a no-op.
  // It starts in the default "graph" mode (peelChainViewMode unset).
  await db.settings.put({ id: "default" } as Settings);
  await seedHop(COINJOIN_TXID, 1_700_000_000);
  await seedHop(PLAIN_TXID, 1_700_000_100);
});

afterEach(async () => {
  cleanup();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await db.settings.clear();
});

describe("PeelChainView list mode", () => {
  it("renders one row per hop with the expected amounts and addresses", async () => {
    const { getByTestId, queryByTestId } = renderView();
    await waitForToggle(getByTestId);

    // Defaults to graph mode → no list cards yet.
    expect(queryByTestId("card-peel-step-0")).toBeNull();

    fireEvent.click(getByTestId("button-peel-view-list"));

    // Both hops render as list cards once the mode flips.
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
      expect(getByTestId("card-peel-step-1")).toBeTruthy();
    });
    // No third hop.
    expect(queryByTestId("card-peel-step-2")).toBeNull();

    // Hop 0 payment / change amounts.
    expect(getByTestId("text-peel-payment-0").textContent).toContain(PAYMENT_BTC);
    expect(getByTestId("text-peel-change-0").textContent).toContain(CHANGE_BTC);

    // The carried-in amount and both addresses appear on the first card.
    const card0 = getByTestId("card-peel-step-0");
    expect(card0.textContent).toContain(CARRIED_IN_BTC);
    expect(within(card0).getByText(PAYMENT_ADDR)).toBeTruthy();
    expect(within(card0).getByText(CHANGE_ADDR)).toBeTruthy();

    // The second hop carries the same seeded values.
    expect(getByTestId("text-peel-payment-1").textContent).toContain(PAYMENT_BTC);
    expect(getByTestId("text-peel-change-1").textContent).toContain(CHANGE_BTC);
  });

  it("persists the selected view mode to the settings store", async () => {
    const { getByTestId } = renderView();
    await waitForToggle(getByTestId);

    fireEvent.click(getByTestId("button-peel-view-list"));
    await waitFor(async () => {
      expect((await getSettings("default"))?.peelChainViewMode).toBe("list");
    });

    // Switching back persists the new value too.
    fireEvent.click(getByTestId("button-peel-view-graph"));
    await waitFor(async () => {
      expect((await getSettings("default"))?.peelChainViewMode).toBe("graph");
    });
  });

  it("opens straight into list mode when it was the persisted choice", async () => {
    // Persist "list" before the view ever mounts.
    await db.settings.update("default", { peelChainViewMode: "list" });

    const { getByTestId, queryByTestId } = renderView();

    // The view should land directly on the list rows — no graph container, no
    // user click required.
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });
    expect(queryByTestId("container-peel-graph")).toBeNull();
  });

  it("surfaces a CoinJoin hop as a normal list row with a deep-dive entry point", async () => {
    const { getByTestId } = renderView(new Set<string>([COINJOIN_TXID]));
    await waitForToggle(getByTestId);

    fireEvent.click(getByTestId("button-peel-view-list"));

    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });

    // The CoinJoin hop is rendered like any other hop (the list does not draw a
    // distinct mixing highlight — that is a graph-only affordance) and its
    // amounts are intact.
    const coinjoinCard = getByTestId("card-peel-step-0");
    expect(coinjoinCard.textContent).toContain(CARRIED_IN_BTC);
    expect(getByTestId("text-peel-payment-0").textContent).toContain(PAYMENT_BTC);
    expect(getByTestId("text-peel-change-0").textContent).toContain(CHANGE_BTC);

    // The per-hop deep-dive button is the list's path into the CoinJoin context.
    expect(
      within(coinjoinCard).getByTestId(
        `button-deep-dive-${COINJOIN_TXID.slice(0, 8)}`,
      ),
    ).toBeTruthy();
  });
});
