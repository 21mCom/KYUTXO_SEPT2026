// @vitest-environment jsdom
//
// Guard tests for the inline copy buttons on the Balance page
// (BalanceOverview.tsx). These assert that each copy affordance BOTH writes the
// correct value to navigator.clipboard AND fires the matching success /
// destructive "Copy failed" toast:
//   • the missing-source-txid dialog rows (button-copy-missing-*) → copyText
//     writes the source txid and toasts "Transaction id copied",
//   • the dialog footer "Copy all source ids" (button-copy-all-missing) →
//     copyAllMissing writes the newline-joined ids and toasts
//     "Copied N source transaction id(s)", and
//   • an expanded group's address row copy button (button-copy-<address>) →
//     copyAddress writes the full address and toasts "Address copied".
// Each path also has a failure case: when navigator.clipboard.writeText
// rejects, a destructive { title: "Copy failed", variant: "destructive" } toast
// is shown instead of the success toast.
//
// The page is engine/Dexie heavy, so (mirroring the sibling
// BalanceOverview.import-history.test.tsx) we mock the data/engine layer so just
// enough renders to drive the relevant copy buttons.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// ── Toast capture ───────────────────────────────────────────────────────────
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
  toast: toastSpy,
}));

// ── DB change signal / live query: stable, inert values ─────────────────────
vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
}));
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));

// ── Heavy data/engine paths ─────────────────────────────────────────────────
vi.mock("@/lib/data/price-data-crud", () => ({
  getBtcUsdPriceData: vi.fn().mockResolvedValue(undefined),
}));

const GROUP_NAME = "Wallet A";
const ADDRESS = "bc1qbalancecopyaddress00000000000000000000aa";

const getAddressBalanceRowsForGroup = vi.fn();
vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn().mockResolvedValue(1),
  getRecordsPageByTypeIdReverseKeyset: vi.fn().mockResolvedValue([]),
  getAddressBalanceRowsForGroup: (...a: unknown[]) => getAddressBalanceRowsForGroup(...a),
  getRecordsByIds: vi.fn().mockResolvedValue([]),
}));

// Engine fast path: surface a single group so the address rows are reachable.
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetBalanceGroupSummaries: vi.fn().mockResolvedValue({
    summaries: [
      { groupKey: GROUP_NAME, totalSats: 50_000, addressCount: 1, utxoCount: 1 },
    ],
    totals: { totalSats: 50_000, totalAddresses: 1, totalUtxos: 1 },
    staleAddressCount: 0,
  }),
  subscribeEngineReadiness: vi.fn().mockReturnValue(() => {}),
}));
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: true }),
}));
vi.mock("@/lib/data/address-stats", () => ({
  recomputeAddressStats: vi.fn().mockResolvedValue({ cancelled: false }),
  countHeuristicMatchedAddresses: vi.fn(() => Promise.resolve(0)),
}));

// ── Spend-health + missing-source data layer ────────────────────────────────
const getMissingSourceTxidDetails = vi.fn();
const getUnresolvedSpendBreakdown = vi.fn();
const countUnresolvedPrevoutInputs = vi.fn();
vi.mock("@/lib/data/transaction-crud", () => ({
  getMissingSourceTxids: vi.fn().mockResolvedValue([]),
  getUnresolvedSpendBreakdown: (...a: unknown[]) => getUnresolvedSpendBreakdown(...a),
  countUnresolvedPrevoutInputs: (...a: unknown[]) => countUnresolvedPrevoutInputs(...a),
  getMissingSourceTxidDetails: (...a: unknown[]) => getMissingSourceTxidDetails(...a),
  buildMissingSourceJson: vi.fn().mockReturnValue("{}"),
  buildMissingSourceCsv: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: vi.fn(() => ({ getBlockHeight: vi.fn() })),
}));
vi.mock("@/lib/txid-backfill", () => ({
  runTxidBackfill: vi.fn(),
}));
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: {
    resolvePrevouts: vi.fn().mockResolvedValue(undefined),
  },
}));

// The expanded group's address list is virtualized; jsdom's zero-size scroll
// element makes the real virtualizer render no items. Stub it to render every
// row so the per-address copy button is reachable.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: index,
        start: index * 34,
        size: 34,
      })),
    getTotalSize: () => opts.count * 34,
    measureElement: () => {},
  }),
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

// ── Clipboard stub ──────────────────────────────────────────────────────────
let writeText: ReturnType<typeof vi.fn>;

// Two missing source transactions so "Copy all" exercises the plural label.
const TXID_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const TXID_2 = "2222222222222222222222222222222222222222222222222222222222222222";
const MISSING_DETAILS = [
  { sourceTxid: TXID_1, spendingTxids: ["spendA"] },
  { sourceTxid: TXID_2, spendingTxids: ["spendB"] },
];

function primeBanner() {
  countUnresolvedPrevoutInputs.mockResolvedValue(3);
  getUnresolvedSpendBreakdown.mockResolvedValue({
    byRecordId: new Map<number, number>(),
    unattributable: 3,
  });
}

async function openMissingDialog() {
  render(<BalanceOverview />);
  await waitFor(() =>
    expect(screen.getByTestId("button-view-missing-transactions")).toBeTruthy(),
  );
  fireEvent.click(screen.getByTestId("button-view-missing-transactions"));
  await waitFor(() =>
    expect(screen.getByTestId(`button-copy-missing-${TXID_1}`)).toBeTruthy(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  toastSpy.mockReset();
  primeBanner();
  getMissingSourceTxidDetails.mockResolvedValue(MISSING_DETAILS);
  getAddressBalanceRowsForGroup.mockResolvedValue([
    { id: 1, address: ADDRESS, label: "", sats: 50_000, utxoCount: 1 },
  ]);
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview · missing-transaction copy buttons", () => {
  it("copies a single missing source txid and toasts 'Transaction id copied'", async () => {
    await openMissingDialog();

    fireEvent.click(screen.getByTestId(`button-copy-missing-${TXID_1}`));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TXID_1));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Transaction id copied" }),
      ),
    );
  });

  it("shows a destructive 'Copy failed' toast when the txid write rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));
    await openMissingDialog();

    fireEvent.click(screen.getByTestId(`button-copy-missing-${TXID_1}`));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TXID_1));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
      ),
    );
    // The happy-path toast must NOT have fired.
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: "Transaction id copied" }),
    );
  });

  it("copies ALL missing source ids (newline-joined) and toasts the count", async () => {
    await openMissingDialog();

    fireEvent.click(screen.getByTestId("button-copy-all-missing"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${TXID_1}\n${TXID_2}`),
    );
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Copied 2 source transaction ids",
        }),
      ),
    );
  });

  it("shows a destructive 'Copy failed' toast when the copy-all write rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));
    await openMissingDialog();

    fireEvent.click(screen.getByTestId("button-copy-all-missing"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${TXID_1}\n${TXID_2}`),
    );
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
      ),
    );
  });
});

describe("BalanceOverview · address-row copy button", () => {
  async function expandGroup() {
    render(<BalanceOverview />);
    await waitFor(() =>
      expect(screen.getByTestId(`button-expand-${GROUP_NAME}`)).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId(`button-expand-${GROUP_NAME}`));
    await waitFor(() =>
      expect(screen.getByTestId(`button-copy-${ADDRESS}`)).toBeTruthy(),
    );
  }

  it("copies the full address and toasts 'Address copied'", async () => {
    await expandGroup();

    fireEvent.click(screen.getByTestId(`button-copy-${ADDRESS}`));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Address copied" }),
      ),
    );
  });

  it("shows a destructive 'Copy failed' toast when the address write rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));
    await expandGroup();

    fireEvent.click(screen.getByTestId(`button-copy-${ADDRESS}`));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
      ),
    );
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: "Address copied" }),
    );
  });
});
