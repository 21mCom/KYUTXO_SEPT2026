// @vitest-environment jsdom
//
// Coverage for the one-click "Re-sync affected addresses" action on the UTXOs
// page's Standard-mode coverage warning. When some input rows are missing
// outpoint data (legacy pre-migration vaults), the warning must surface a
// button that re-syncs exactly the owned addresses whose transactions carry
// outpoint-less input rows — no manual hunting on the Transaction Sync page.
//
// The full page renders against real Dexie (fake-indexeddb) seeded via the
// real CRUD modules; the sync service, node settings, and provider probe are
// mocked so the click path is observable without a network.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// jsdom has no layout: render every row instead of a measured window.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 56,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 56,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));

// ScrollPositionIndicator uses window.matchMedia, which jsdom lacks.
vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

// Force the Dexie path: the engine is never available in jsdom.
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: false }),
}));
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountOwnedUtxos: vi.fn().mockResolvedValue(0),
  engineGetHeuristicOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountHeuristicOwnedUtxos: vi.fn().mockResolvedValue(0),
}));

// Capture toasts so completion/guard messaging is assertable.
interface ToastCall {
  title?: string;
  description?: string;
  variant?: string;
}
const toastCalls: ToastCall[] = [];
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: (args: ToastCall) => {
      toastCalls.push(args);
    },
    dismiss: vi.fn(),
    toasts: [],
  }),
}));

// Sync service + provider plumbing: the action must check settings, probe the
// provider, hand the settings to the service, then sync each affected address.
const syncSingleAddress = vi.fn(async (_address: string) => ({ success: true }));
const updateProvider = vi.fn();
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: {
    get syncSingleAddress() {
      return syncSingleAddress;
    },
    get updateProvider() {
      return updateProvider;
    },
  },
}));

let nodeSettings: object | null = { useElectrum: false };
vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: vi.fn(async () => nodeSettings),
}));
vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: vi.fn(() => ({
    getBlockHeight: async () => 800_000,
  })),
}));

import { renderWithProviders } from "@/test/testProviders";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import UTXOs from "./UTXOs";

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});

const TX1 = "a".repeat(64);
const TX2 = "b".repeat(64);
const TX3 = "c".repeat(64);
const ADDR_LEGACY_1 = "bc1qlegacyaddressone0000000000000000000001";
const ADDR_LEGACY_2 = "bc1qlegacyaddresstwo0000000000000000000002";
const ADDR_EXACT = "bc1qexactaddress000000000000000000000000003";

async function seed() {
  for (const [addr, label] of [
    [ADDR_LEGACY_1, "Legacy 1"],
    [ADDR_LEGACY_2, "Legacy 2"],
    [ADDR_EXACT, "Exact"],
  ] as const) {
    await createRecord({
      type: "address",
      inputString: addr,
      label,
      tags: [],
      categories: [],
    });
  }
  await bulkAddTransactions(
    [TX1, TX2, TX3].map((txid, i) => ({
      txid,
      blockHeight: 800_000 + i,
      blockTime: 1_700_000_000 + i * 600,
      fee: 100,
      feeRate: 1,
      syncedAt: Date.now(),
    })),
  );
  await bulkAddParticipants([
    // Legacy (pre-migration) spends: input rows WITHOUT prevTxid/prevVout.
    { txid: TX1, role: "input", address: ADDR_LEGACY_1, amount: 10_000 },
    { txid: TX2, role: "input", address: ADDR_LEGACY_2, amount: 20_000 },
    // A migrated input WITH outpoint data, so coverage is >0% and <100%.
    { txid: TX3, role: "input", address: ADDR_EXACT, amount: 30_000, prevTxid: TX1, prevVout: 0 },
    // Outputs so the page has UTXOs to show.
    { txid: TX1, role: "output", address: ADDR_EXACT, amount: 9_000, vout: 0 },
    { txid: TX2, role: "output", address: ADDR_EXACT, amount: 19_000, vout: 0 },
  ]);
}

describe("UTXOs coverage-warning one-click re-sync", () => {
  beforeEach(async () => {
    localStorage.clear();
    toastCalls.length = 0;
    nodeSettings = { useElectrum: false };
    await clearAllRecords();
    await clearTransactions();
    await clearParticipants();
    await seed();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the warning with a button naming the affected-address count and re-syncs exactly those addresses", async () => {
    renderWithProviders(<UTXOs />);

    await waitFor(
      () => {
        expect(screen.getByTestId("text-heuristic-coverage-warning")).toBeTruthy();
      },
      { timeout: 10000 },
    );

    const button = await screen.findByTestId("button-resync-affected", {}, { timeout: 10000 });
    expect(button.textContent).toContain("Re-sync 2 affected addresses");

    fireEvent.click(button);

    await waitFor(
      () => {
        expect(toastCalls.some((t) => t.title === "Re-synced")).toBe(true);
      },
      { timeout: 10000 },
    );

    // Exactly the two legacy addresses — never the already-exact one.
    const synced = syncSingleAddress.mock.calls.map((c) => c[0]).sort();
    expect(synced).toEqual([ADDR_LEGACY_1, ADDR_LEGACY_2].sort());
    expect(updateProvider).toHaveBeenCalledTimes(1);
    const doneToast = toastCalls.find((t) => t.title === "Re-synced");
    expect(doneToast?.description).toContain("2 affected addresses");
  });

  it("fails non-destructively with a toast when no provider is configured", async () => {
    nodeSettings = null;

    renderWithProviders(<UTXOs />);

    const button = await screen.findByTestId("button-resync-affected", {}, { timeout: 10000 });
    fireEvent.click(button);

    await waitFor(
      () => {
        expect(
          toastCalls.some((t) => t.title === "No blockchain provider configured" && t.variant === "destructive"),
        ).toBe(true);
      },
      { timeout: 10000 },
    );
    expect(syncSingleAddress).not.toHaveBeenCalled();
  });
});
