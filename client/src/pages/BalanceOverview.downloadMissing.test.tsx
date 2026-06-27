// @vitest-environment jsdom
//
// Component-level coverage for the "Missing source transactions" download
// wiring in BalanceOverview.tsx. The pure serialisers (buildMissingSourceJson /
// buildMissingSourceCsv) are unit-tested in lib; this file guards the page-level
// glue: the downloadMissing() click handler that turns the in-memory list into a
// Blob, drives an object-URL anchor download with a dated filename, and fires a
// success toast.
//
// We render the real BalanceOverview, mock its data-fetching seams so the
// spend-warning banner shows the "View missing transactions" button, and mock
// getMissingSourceTxidDetails to return a fixed non-empty list. The two
// serialisers are left REAL so the produced Blob carries the actual production
// content.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

// @tanstack/react-virtual needs ResizeObserver + real dimensions; jsdom has
// neither. The component mounts the virtualized list even before rows load, so
// supply the same shims the sibling BalanceOverview tests use.
const FAKE_RECT: DOMRect = {
  width: 600,
  height: 384,
  top: 0,
  left: 0,
  right: 600,
  bottom: 384,
  x: 0,
  y: 0,
  toJSON() {},
};

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 600;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 384;
    },
  });
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return FAKE_RECT;
  };
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  if (!(navigator as any).clipboard) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn() },
    });
  }
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));

const ENGINE_SUMMARY = {
  summaries: [
    { groupKey: "Wallet A", totalSats: 500_000, addressCount: 2, utxoCount: 2 },
  ],
  totals: { totalSats: 500_000, totalAddresses: 2, totalUtxos: 2 },
  staleAddressCount: 0,
};
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetBalanceGroupSummaries: vi.fn(() => Promise.resolve(ENGINE_SUMMARY)),
  subscribeEngineReadiness: () => () => {},
}));
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn(() => Promise.resolve({ useEngine: true })),
}));

vi.mock("@/lib/data/address-stats", () => ({
  recomputeAddressStats: vi.fn(() => Promise.resolve({ cancelled: false })),
}));

vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn(() => Promise.resolve(2)),
  getRecordsPageByTypeIdReverseKeyset: vi.fn(() => Promise.resolve([])),
  getAddressBalanceRowsForGroup: vi.fn(() => Promise.resolve([])),
  getRecordsByIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/balance-grouping", () => ({
  getGroupKeys: () => [],
}));

// The fixed missing list the dialog renders and the download serialises. One
// entry references multiple spends (to exercise the joined CSV cell) and one is
// standalone.
const MISSING_DETAILS = [
  { sourceTxid: "aaa111", spendingTxids: ["spend1", "spend2"] },
  { sourceTxid: "bbb222", spendingTxids: ["spend3"] },
];

// Spend-health seam: a non-zero unattributable count is what renders the
// "View missing transactions" button that opens the dialog. The serialisers are
// kept REAL so the Blob carries the genuine production output.
vi.mock("@/lib/data/transaction-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/transaction-crud")>();
  return {
    ...actual,
    countUnresolvedPrevoutInputs: vi.fn(() => Promise.resolve(2)),
    getUnresolvedSpendBreakdown: vi.fn(() =>
      Promise.resolve({ byRecordId: new Map(), unattributable: 2 }),
    ),
    getMissingSourceTxids: vi.fn(() =>
      Promise.resolve(MISSING_DETAILS.map((d) => d.sourceTxid)),
    ),
    getMissingSourceTxidDetails: vi.fn(() => Promise.resolve(MISSING_DETAILS)),
  };
});

vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts: vi.fn() },
}));

const { buildMissingSourceJson, buildMissingSourceCsv } = await import(
  "@/lib/data/transaction-crud"
);
const BalanceOverview = (await import("./BalanceOverview")).default;

// jsdom doesn't implement URL.createObjectURL or anchor navigation. Capture the
// Blob and the anchor download attribute instead of letting jsdom attempt a real
// navigation.
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clickedDownloads: string[];
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  toastSpy.mockClear();
  clickedDownloads = [];
  createObjectURL = vi.fn(() => "blob:mock-url");
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownloads.push(this.download);
    });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  void clickSpy;
});

// Render the page, open the missing-transactions dialog, and wait for the
// non-empty list to populate the download buttons.
async function openDialog() {
  render(<BalanceOverview />);
  fireEvent.click(await screen.findByTestId("button-view-missing-transactions"));
  await screen.findByTestId("button-download-missing-json");
  await screen.findByTestId("button-download-missing-csv");
}

const DATED_JSON = /^kyutxo-missing-transactions-\d{4}-\d{2}-\d{2}\.json$/;
const DATED_CSV = /^kyutxo-missing-transactions-\d{4}-\d{2}-\d{2}\.csv$/;

describe("BalanceOverview — Download JSON", () => {
  it("produces an application/json Blob whose contents match buildMissingSourceJson", async () => {
    await openDialog();

    fireEvent.click(screen.getByTestId("button-download-missing-json"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json;charset=utf-8");
    expect(await blob.text()).toBe(buildMissingSourceJson(MISSING_DETAILS));
  });

  it("downloads with a dated .json filename, fires a success toast, and revokes the URL", async () => {
    await openDialog();

    fireEvent.click(screen.getByTestId("button-download-missing-json"));

    await waitFor(() => expect(clickedDownloads).toHaveLength(1));
    expect(clickedDownloads[0]).toMatch(DATED_JSON);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

    const success = toastSpy.mock.calls.find(
      (c) => typeof c[0]?.description === "string" && c[0].description.includes(".json"),
    );
    expect(success).toBeTruthy();
    expect(success![0].variant).not.toBe("destructive");
  });
});

describe("BalanceOverview — Download CSV", () => {
  it("produces a text/csv Blob whose contents match buildMissingSourceCsv", async () => {
    await openDialog();

    fireEvent.click(screen.getByTestId("button-download-missing-csv"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/csv;charset=utf-8");
    expect(await blob.text()).toBe(buildMissingSourceCsv(MISSING_DETAILS));
  });

  it("downloads with a dated .csv filename, fires a success toast, and revokes the URL", async () => {
    await openDialog();

    fireEvent.click(screen.getByTestId("button-download-missing-csv"));

    await waitFor(() => expect(clickedDownloads).toHaveLength(1));
    expect(clickedDownloads[0]).toMatch(DATED_CSV);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

    const success = toastSpy.mock.calls.find(
      (c) => typeof c[0]?.description === "string" && c[0].description.includes(".csv"),
    );
    expect(success).toBeTruthy();
    expect(success![0].variant).not.toBe("destructive");
  });
});
