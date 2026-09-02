// @vitest-environment jsdom
//
// End-to-end regression that the Fund Trail From/To date filter actually
// NARROWS the computed trail — not just that the "Showing <range>" badge
// appears (that indicator is covered separately in
// FundTrail.dateRangeBadge.test.tsx).
//
// The badge warns users their totals are filtered, so the underlying filtering
// must genuinely happen: computeOneHop(..., dateRange) must include only
// transactions whose blockTime falls inside the From/To window. A regression in
// the date-window logic could silently return all-time results while the badge
// still claims "filtered". Nothing pinned that behavior down through the page
// before.
//
// This renders the REAL FundTrail page on a real Dexie database (fake-indexeddb)
// seeded with one center wallet plus incoming/outgoing transactions whose
// blockTimes straddle a chosen window (some before, one inside, some after). It
// drives the native <input type="date"> controls (via the same native-<select>
// mock the badge test uses) and asserts that:
//   - both bounds  → only the in-window source/destination cards render
//   - start-only   → before-window cards drop, in/after stay
//   - end-only     → after-window cards drop, before/in stay
//   - "All time"   → every card returns and the per-column totals are restored
//
// The flow cards carry data-testid="fund-trail-flow-card-<Label>-d0" and the
// Sources/Destinations columns show a "<btc> in"/"<btc> out" total badge, both
// of which we assert against the in-window subset.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. The trigger's data-testid is forwarded onto the
// native <select> so the existing test ids keep working.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = (props: any) => {
    void props;
    return null;
  };
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children, disabled }: any) => {
      let testid: string | undefined;
      React.Children.forEach(children, (child: any) => {
        if (child && child.type && child.type.__isTrigger) {
          testid = child.props["data-testid"];
        }
      });
      return React.createElement(
        "select",
        {
          "data-testid": testid,
          value: value ?? "",
          disabled,
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) =>
      React.createElement("option", { value }, children),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import FundTrail from "./FundTrail";
import { formatBtc } from "@/lib/data/fund-trail-engine";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  bulkAddParticipants,
  clearAllTransactionData,
} from "@/lib/data/transaction-crud";
import type { TransactionParticipant } from "@/lib/database";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const WALLET_GROUP = "Trail Filter Wallet";
const CENTER_ADDR = "bc1qcenteraddr00000000000000000000000000000aa";

// Window the test selects in the UI.
const FROM = "2023-10-01";
const TO = "2023-12-31";

// Unix-seconds blockTimes straddling that window. Margins are large enough that
// local-timezone offsets can't push any of them across a boundary.
const t = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const BEFORE = t("2023-01-01T12:00:00Z"); // before FROM
const INSIDE = t("2023-11-15T12:00:00Z"); // inside [FROM, TO]
const AFTER = t("2024-06-01T12:00:00Z"); // after TO

// Distinct amounts (sats) so per-card / per-column totals are unambiguous.
const AMT = {
  srcBefore: 100_000_000,
  srcInside: 200_000_000,
  srcAfter: 300_000_000,
  dstBefore: 400_000_000,
  dstInside: 500_000_000,
  dstAfter: 600_000_000,
};

let txCounter = 0;

/**
 * Seed one external group (its own address record so it resolves to a wallet
 * label) plus a single transaction connecting it to the center wallet, dated
 * `time`, via the participant fallback path (needs a blockchainTransactions row
 * so the engine can resolve the txid's blockTime).
 */
async function seedFlow(opts: {
  direction: "in" | "out";
  label: string;
  time: number;
  amount: number;
}): Promise<void> {
  const { direction, label, time, amount } = opts;
  const ext = `bc1qext${label.replace(/\s/g, "").toLowerCase()}00000000000000aa`;

  await createRecord({
    type: "address",
    inputString: ext,
    label: `${label} seed`,
    walletName: label,
    tags: [],
    categories: [],
  });

  const txid = `tx${++txCounter}${"0".repeat(60)}`.slice(0, 64);

  await addTransaction(
    {
      txid,
      blockHeight: 1,
      blockTime: time,
      fee: 0,
      feeRate: 0,
      syncedAt: 1,
    },
    { skipNotification: true },
  );

  // Incoming: center is an output, external is an input (funds came FROM ext).
  // Outgoing: center is an input, external is an output (funds went TO ext).
  const centerRole = direction === "in" ? "output" : "input";
  const extRole = direction === "in" ? "input" : "output";
  await bulkAddParticipants(
    [
      {
        txid,
        role: centerRole,
        address: CENTER_ADDR,
        amount,
        vout: 0,
      } as TransactionParticipant,
      {
        txid,
        role: extRole,
        address: ext,
        amount,
        vout: 1,
      } as TransactionParticipant,
    ],
    { skipNotification: true },
  );
}

function cardId(label: string): string {
  return `fund-trail-flow-card-${label.replace(/\s/g, "-")}-d0`;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FundTrail />
    </QueryClientProvider>,
  );
}

// Select the seeded wallet group through the (mocked native) select so the
// TrailLayout mounts and renders the flow cards.
async function selectSeededGroup() {
  const groupSelect = await screen.findByTestId("fund-trail-group-select");
  await waitFor(() => {
    expect(
      Array.from(groupSelect.querySelectorAll("option")).some(
        (o) => (o as HTMLOptionElement).value === WALLET_GROUP,
      ),
    ).toBe(true);
  });
  fireEvent.change(groupSelect, { target: { value: WALLET_GROUP } });
  // Wait until the trail has computed and the center node is on screen.
  await screen.findByTestId("fund-trail-center-node");
}

function applyWindow(from: string, to: string) {
  if (from) {
    fireEvent.change(screen.getByTestId("input-fund-trail-date-range-from"), {
      target: { value: from },
    });
  }
  if (to) {
    fireEvent.change(screen.getByTestId("input-fund-trail-date-range-to"), {
      target: { value: to },
    });
  }
}

beforeEach(async () => {
  txCounter = 0;
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });

  // Center wallet (one address) so the group becomes selectable.
  await createRecord({
    type: "address",
    inputString: CENTER_ADDR,
    label: "Center seed",
    walletName: WALLET_GROUP,
    tags: [],
    categories: [],
  });

  // Three sources and three destinations straddling the window.
  await seedFlow({ direction: "in", label: "Source Before", time: BEFORE, amount: AMT.srcBefore });
  await seedFlow({ direction: "in", label: "Source Inside", time: INSIDE, amount: AMT.srcInside });
  await seedFlow({ direction: "in", label: "Source After", time: AFTER, amount: AMT.srcAfter });
  await seedFlow({ direction: "out", label: "Dest Before", time: BEFORE, amount: AMT.dstBefore });
  await seedFlow({ direction: "out", label: "Dest Inside", time: INSIDE, amount: AMT.dstInside });
  await seedFlow({ direction: "out", label: "Dest After", time: AFTER, amount: AMT.dstAfter });
});

afterEach(async () => {
  cleanup();
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });
  vi.clearAllMocks();
});

describe("Fund Trail date filter narrows results", () => {
  it("shows all sources and destinations before any filter is applied", async () => {
    renderPage();
    await selectSeededGroup();

    for (const label of ["Source Before", "Source Inside", "Source After"]) {
      expect(await screen.findByTestId(cardId(label))).toBeTruthy();
    }
    for (const label of ["Dest Before", "Dest Inside", "Dest After"]) {
      expect(await screen.findByTestId(cardId(label))).toBeTruthy();
    }
  });

  it("with a From+To window, renders only the in-window source and destination", async () => {
    renderPage();
    await selectSeededGroup();
    applyWindow(FROM, TO);

    // In-window cards appear...
    await waitFor(() => {
      expect(screen.getByTestId(cardId("Source Inside"))).toBeTruthy();
      expect(screen.getByTestId(cardId("Dest Inside"))).toBeTruthy();
    });
    // ...and out-of-window cards are gone.
    await waitFor(() => {
      expect(screen.queryByTestId(cardId("Source Before"))).toBeNull();
      expect(screen.queryByTestId(cardId("Source After"))).toBeNull();
      expect(screen.queryByTestId(cardId("Dest Before"))).toBeNull();
      expect(screen.queryByTestId(cardId("Dest After"))).toBeNull();
    });

    // The in-window card totals reflect ONLY the in-window transaction amounts.
    expect(
      within(screen.getByTestId(cardId("Source Inside"))).getByText(
        formatBtc(AMT.srcInside),
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId(cardId("Dest Inside"))).getByText(
        formatBtc(AMT.dstInside),
      ),
    ).toBeTruthy();

    // Column totals collapse to the single in-window amounts, proving the
    // all-time totals (which would sum all three) were not used.
    expect(screen.getByText(`${formatBtc(AMT.srcInside)} in`)).toBeTruthy();
    expect(screen.getByText(`${formatBtc(AMT.dstInside)} out`)).toBeTruthy();
  });

  it("with only a From date, drops before-window flows but keeps the rest", async () => {
    renderPage();
    await selectSeededGroup();
    applyWindow(FROM, "");

    await waitFor(() => {
      expect(screen.getByTestId(cardId("Source Inside"))).toBeTruthy();
      expect(screen.getByTestId(cardId("Source After"))).toBeTruthy();
      expect(screen.getByTestId(cardId("Dest Inside"))).toBeTruthy();
      expect(screen.getByTestId(cardId("Dest After"))).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByTestId(cardId("Source Before"))).toBeNull();
      expect(screen.queryByTestId(cardId("Dest Before"))).toBeNull();
    });
  });

  it("with only a To date, drops after-window flows but keeps the rest", async () => {
    renderPage();
    await selectSeededGroup();
    applyWindow("", TO);

    await waitFor(() => {
      expect(screen.getByTestId(cardId("Source Before"))).toBeTruthy();
      expect(screen.getByTestId(cardId("Source Inside"))).toBeTruthy();
      expect(screen.getByTestId(cardId("Dest Before"))).toBeTruthy();
      expect(screen.getByTestId(cardId("Dest Inside"))).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByTestId(cardId("Source After"))).toBeNull();
      expect(screen.queryByTestId(cardId("Dest After"))).toBeNull();
    });
  });

  it("clearing the dates ('All time') restores the full set and totals", async () => {
    renderPage();
    await selectSeededGroup();
    applyWindow(FROM, TO);

    // Wait for the filter to take effect first.
    await waitFor(() => {
      expect(screen.queryByTestId(cardId("Source Before"))).toBeNull();
    });

    fireEvent.click(screen.getByTestId("fund-trail-clear-dates"));

    // Every card returns.
    await waitFor(() => {
      for (const label of [
        "Source Before",
        "Source Inside",
        "Source After",
        "Dest Before",
        "Dest Inside",
        "Dest After",
      ]) {
        expect(screen.getByTestId(cardId(label))).toBeTruthy();
      }
    });

    // Column totals sum all three transactions again.
    const totalIn = AMT.srcBefore + AMT.srcInside + AMT.srcAfter;
    const totalOut = AMT.dstBefore + AMT.dstInside + AMT.dstAfter;
    expect(screen.getByText(`${formatBtc(totalIn)} in`)).toBeTruthy();
    expect(screen.getByText(`${formatBtc(totalOut)} out`)).toBeTruthy();
  });
});
