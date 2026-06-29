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
import { clearCachedRecords } from "@/lib/metadata-hover";

import { TooltipProvider } from "@/components/ui/tooltip";
import { db, type Settings } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { getSettings } from "@/lib/data/settings-crud";
import { createRecord } from "@/lib/dataFacade";
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
  // AddressLink/TxidLink read a module-level resolve cache; clear it so a prior
  // test's resolved record can't leak in as a stale hit and suppress navigation.
  clearCachedRecords();
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
  clearCachedRecords();
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

// Both list addresses share the same `link-address-{slice}` testid prefix
// (PAYMENT_ADDR and CHANGE_ADDR both start with "bc1qpeel"), so we locate each
// AddressLink by its full address text inside the hop card and click that
// element directly. (AddressLink is rendered with truncate={false} here so the
// full address text is present in the DOM.)
describe("PeelChainView list mode address navigation", () => {
  const PAYMENT_LABEL = "External Payment Address Record";

  function renderViewWithHistory() {
    const { hook, history } = memoryLocation({
      path: "/privacy-audit",
      record: true,
    });
    const utils = render(
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
    return { ...utils, history: history! };
  }

  it("opens the RecordDetailPanel for a list address that has a record", async () => {
    // Seed a record for the peel-chain payment address (beforeEach left
    // db.records empty after seeding the hops).
    await createRecord(
      {
        type: "address",
        inputString: PAYMENT_ADDR,
        label: PAYMENT_LABEL,
        source: "manual",
        tags: [],
        categories: [],
      },
      { skipVocabularySync: true },
    );

    const { getByTestId, findByText } = renderViewWithHistory();
    await waitForToggle(getByTestId);

    fireEvent.click(getByTestId("button-peel-view-list"));
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });

    // Click the payment address span within the first hop card.
    const card0 = getByTestId("card-peel-step-0");
    fireEvent.click(within(card0).getByText(PAYMENT_ADDR));

    // RecordDetailPanel surfaces the matched record's label as its title.
    expect(await findByText(PAYMENT_LABEL)).toBeTruthy();
  });

  it("navigates to /records?search=<address> when the address has no record", async () => {
    // No record seeded for any peel-chain address, so the click should fall
    // through to navigation instead of opening the panel.
    const { getByTestId, history } = renderViewWithHistory();
    await waitForToggle(getByTestId);

    fireEvent.click(getByTestId("button-peel-view-list"));
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });

    const card0 = getByTestId("card-peel-step-0");
    fireEvent.click(within(card0).getByText(PAYMENT_ADDR));

    const expectedPath = `/records?search=${encodeURIComponent(PAYMENT_ADDR)}`;
    await waitFor(() => {
      expect(history).toContain(expectedPath);
    });
  });
});

// The list view renders each hop's transaction id via TxidLink. Clicking that
// link should resolve the txid to its transaction record and open the
// RecordDetailPanel, or fall through to /records?search=<txid> navigation when
// no record exists. (The graph view's tx-node navigation is covered separately
// in PrivacyAudit.peelGraph.test.tsx.) TxidLink exposes a stable testid keyed
// on the first 8 chars of the txid (`link-txid-{slice}`).
describe("PeelChainView list mode transaction navigation", () => {
  const TX_LABEL = "Hop One Transaction Record";

  function renderViewWithHistory() {
    const { hook, history } = memoryLocation({
      path: "/privacy-audit",
      record: true,
    });
    const utils = render(
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
    return { ...utils, history: history! };
  }

  it("opens the RecordDetailPanel for a list hop txid that has a record", async () => {
    // Seed a transaction-type record for the first hop's txid.
    await createRecord(
      {
        type: "transaction",
        inputString: COINJOIN_TXID,
        label: TX_LABEL,
        source: "manual",
        tags: [],
        categories: [],
      },
      { skipVocabularySync: true },
    );

    const { getByTestId, findByText } = renderViewWithHistory();
    await waitForToggle(getByTestId);

    fireEvent.click(getByTestId("button-peel-view-list"));
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });

    // Click the txid link inside the first hop card.
    const card0 = getByTestId("card-peel-step-0");
    fireEvent.click(
      within(card0).getByTestId(`link-txid-${COINJOIN_TXID.slice(0, 8)}`),
    );

    // RecordDetailPanel surfaces the matched record's label as its title.
    expect(await findByText(TX_LABEL)).toBeTruthy();
  });

  it("navigates to /records?search=<txid> when the hop txid has no record", async () => {
    // No record seeded for any hop txid, so the click should fall through to
    // navigation instead of opening the panel.
    const { getByTestId, history } = renderViewWithHistory();
    await waitForToggle(getByTestId);

    fireEvent.click(getByTestId("button-peel-view-list"));
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });

    const card0 = getByTestId("card-peel-step-0");
    fireEvent.click(
      within(card0).getByTestId(`link-txid-${COINJOIN_TXID.slice(0, 8)}`),
    );

    const expectedPath = `/records?search=${encodeURIComponent(COINJOIN_TXID)}`;
    await waitFor(() => {
      expect(history).toContain(expectedPath);
    });
  });
});

// Each list hop exposes a forensic deep-dive entry point (DeepDiveDialog,
// testid `button-deep-dive-{slice}`) next to its TxidLink. The existing list
// tests only assert the button is *present*; these click it to confirm the
// dialog actually opens with the right transaction, and that a CoinJoin hop's
// coinjoin context is carried through into the dialog (so its CoinJoin
// Fund-Flow diagram is rendered). The graph view's deep-dive open path is
// covered separately in PrivacyAudit.peelGraph.test.tsx.
describe("PeelChainView list mode deep-dive", () => {
  // Switch to list mode and wait for the hop cards to render.
  async function openList(getByTestId: (id: string) => HTMLElement) {
    await waitForToggle(getByTestId);
    fireEvent.click(getByTestId("button-peel-view-list"));
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });
  }

  it("opens the deep-dive dialog when a hop's deep-dive button is clicked", async () => {
    const { getByTestId, findByTestId, findByText } = renderView();
    await openList(getByTestId);

    // The plain (non-CoinJoin) hop's deep-dive button lives in its hop card.
    const card1 = getByTestId("card-peel-step-1");
    fireEvent.click(
      within(card1).getByTestId(`button-deep-dive-${PLAIN_TXID.slice(0, 8)}`),
    );

    // The DeepDiveDialog opens with its content and title rendered.
    expect(await findByTestId("dialog-deep-dive")).toBeTruthy();
    expect(await findByText("Transaction Deep-Dive")).toBeTruthy();

    // The dialog is scoped to the hop's transaction — its description echoes the
    // full txid the button belongs to.
    const dialog = await findByTestId("dialog-deep-dive");
    expect(dialog.textContent).toContain(PLAIN_TXID);
  });

  it("carries a CoinJoin hop's coinjoin context through into the dialog", async () => {
    // Hop 0 is the CoinJoin hop; the list passes coinjoinTxids into its dialog.
    const { getByTestId, findByTestId } = renderView(
      new Set<string>([COINJOIN_TXID]),
    );
    await openList(getByTestId);

    const card0 = getByTestId("card-peel-step-0");
    fireEvent.click(
      within(card0).getByTestId(`button-deep-dive-${COINJOIN_TXID.slice(0, 8)}`),
    );

    expect(await findByTestId("dialog-deep-dive")).toBeTruthy();

    // Because the hop is a known CoinJoin, the deep-dive renders its CoinJoin
    // Fund-Flow Sankey — proof the coinjoin context reached the dialog. (Plain
    // hops never get this section.)
    const dialog = await findByTestId("dialog-deep-dive");
    await waitFor(() => {
      expect(
        within(dialog).getByTestId("container-coinjoin-sankey"),
      ).toBeTruthy();
    });
    expect(dialog.textContent).toContain("CoinJoin Fund-Flow");
  });

  it("does not render the CoinJoin Fund-Flow for a non-CoinJoin hop's deep-dive", async () => {
    // With no txid marked as a CoinJoin, even hop 0's deep-dive must omit the
    // Sankey — confirming the section is gated on the carried coinjoin context.
    const { getByTestId, findByTestId, queryByTestId } = renderView(
      new Set<string>(),
    );
    await openList(getByTestId);

    const card0 = getByTestId("card-peel-step-0");
    fireEvent.click(
      within(card0).getByTestId(`button-deep-dive-${COINJOIN_TXID.slice(0, 8)}`),
    );

    const dialog = await findByTestId("dialog-deep-dive");
    // Wait for the analysis summary to populate so we know the dialog finished
    // building its body before asserting the Sankey is absent.
    await waitFor(() => {
      expect(
        within(dialog).getByTestId("container-deep-dive-summary"),
      ).toBeTruthy();
    });
    expect(queryByTestId("container-coinjoin-sankey")).toBeNull();
  });
});
