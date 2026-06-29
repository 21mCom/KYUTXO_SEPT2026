// @vitest-environment jsdom
//
// Component-level coverage for BalanceOverview's "Import missing history"
// EARLY-EXIT failure paths (button-import-missing-history). The happy path lives
// in balance-import-history-complete.test.tsx; this file is the complementary
// "the import can't even start" coverage.
//
// handleImportMissingHistory bails out (before any backfill runs) in three
// distinct ways, each with its own actionable toast:
//   1. getMissingSourceTxids returns [] → "Nothing to import" (the spends'
//      source addresses aren't tracked, so more history can't help).
//   2. getNodeSettings returns null → "No blockchain provider configured"
//      (the user needs to set a provider in Settings first).
//   3. provider.getBlockHeight throws → "Can't reach the blockchain provider"
//      (the provider is configured but unreachable — connection/settings issue).
//
// In every one of these branches the run must abort BEFORE the resolve+recompute
// pass, so transactionSyncService.resolvePrevouts is never called. The mocks
// keep the spend-warning banner's import button on screen (unresolved +
// unattributable spends > 0) and then steer each branch via the controllable
// spies below. Fully offline — no network.
import "fake-indexeddb/auto";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

// ── Toast capture ────────────────────────────────────────────────────────────
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// Keep the db-change signal constant so the spend-health effects run once.
vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
}));

// Native read-engine off → component takes the Dexie aggregate path, which we
// keep empty (no address records) so it settles immediately into "ready".
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetBalanceGroupSummaries: vi.fn(async () => ({
    summaries: [],
    totals: { totalSats: 0, totalAddresses: 0, totalUtxos: 0 },
    staleAddressCount: 0,
  })),
  subscribeEngineReadiness: vi.fn(() => () => {}),
}));
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn(async () => ({ useEngine: false })),
}));

vi.mock("@/lib/data/price-data-crud", () => ({
  getBtcUsdPriceData: vi.fn(async () => []),
}));

// No address records → the aggregate scan is empty and the per-group spend
// breakdown has nothing to map.
vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn(async () => 0),
  getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => []),
  getAddressBalanceRowsForGroup: vi.fn(async () => []),
  getRecordsByIds: vi.fn(async () => []),
}));

vi.mock("@/lib/data/address-stats", () => ({
  recomputeAddressStats: vi.fn(async () => ({ cancelled: false })),
  countHeuristicMatchedAddresses: vi.fn(() => Promise.resolve(0)),
}));

// The resolve+recompute pass must NEVER run on an early-exit branch — the import
// never got far enough to import anything. Spy so we can assert it stayed put.
const { resolvePrevoutsSpy } = vi.hoisted(() => ({
  resolvePrevoutsSpy: vi.fn(async () => ({ resolved: 0, total: 0 })),
}));
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts: resolvePrevoutsSpy },
}));

// Per-test controllable node settings. Defaults to a configured provider; the
// "no provider" branch overrides this to null.
const { getNodeSettingsSpy } = vi.hoisted(() => ({
  getNodeSettingsSpy: vi.fn(async () => ({ providerType: "mempool" })),
}));
vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: getNodeSettingsSpy,
}));

// Spend-health numbers that surface the warning banner + import button. These
// stay positive in every branch so the button is always on screen; the import
// itself bails out before touching them again. getMissingSourceTxids is the
// per-test lever for the "Nothing to import" branch.
const { getMissingSourceTxidsSpy, UNATTRIBUTABLE } = vi.hoisted(() => ({
  getMissingSourceTxidsSpy: vi.fn<[], Promise<string[]>>(async () => []),
  UNATTRIBUTABLE: 5,
}));
vi.mock("@/lib/data/transaction-crud", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/data/transaction-crud")>();
  return {
    ...actual,
    countUnresolvedPrevoutInputs: vi.fn(async () => UNATTRIBUTABLE),
    getUnresolvedSpendBreakdown: vi.fn(async () => ({
      byRecordId: new Map<number, number>(),
      unattributable: UNATTRIBUTABLE,
    })),
    getMissingSourceTxids: getMissingSourceTxidsSpy,
    getMissingSourceTxidDetails: vi.fn(async () => []),
  };
});

// Fake provider. getBlockHeight is the per-test lever for the "unreachable"
// branch; getTransaction must never fire on an early-exit.
const { getBlockHeightSpy } = vi.hoisted(() => ({
  getBlockHeightSpy: vi.fn(async () => 800000),
}));
const fakeProvider = {
  name: "fake",
  getBlockHeight: getBlockHeightSpy,
  getAddressTransactions: vi.fn(async () => []),
  getTransaction: vi.fn(async () => {
    throw new Error("getTransaction must not be called on an early-exit branch");
  }),
  testConnection: vi.fn(async () => ({ success: true })),
};
vi.mock("@/lib/blockchain-api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    createProviderFromSettings: vi.fn(() => fakeProvider),
  };
});

import { db } from "@/lib/database";
import BalanceOverview from "@/pages/BalanceOverview";

// A non-empty set of "missing" source txids for the branches that need to get
// past the first early exit.
const SOME_TXIDS: string[] = [];
for (let i = 1; i <= 4; i++) SOME_TXIDS.push(i.toString(16).padStart(64, "0"));

beforeEach(async () => {
  toastSpy.mockClear();
  resolvePrevoutsSpy.mockClear();
  getBlockHeightSpy.mockClear();
  getBlockHeightSpy.mockResolvedValue(800000);
  getNodeSettingsSpy.mockClear();
  getNodeSettingsSpy.mockResolvedValue({ providerType: "mempool" });
  getMissingSourceTxidsSpy.mockClear();
  getMissingSourceTxidsSpy.mockResolvedValue([...SOME_TXIDS]);
  fakeProvider.getTransaction.mockClear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await db.records.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function clickImport() {
  renderWithProviders(<BalanceOverview />);
  const importBtn = await screen.findByTestId("button-import-missing-history");
  fireEvent.click(importBtn);
  return importBtn;
}

describe("BalanceOverview — history import early-exit failures", () => {
  it("toasts \"Nothing to import\" when there are no missing source txids", async () => {
    getMissingSourceTxidsSpy.mockResolvedValue([]);

    await clickImport();

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Nothing to import" }),
      ),
    );

    // Bailed out before checking the provider or running any backfill.
    expect(getNodeSettingsSpy).not.toHaveBeenCalled();
    expect(fakeProvider.getTransaction).not.toHaveBeenCalled();
    expect(resolvePrevoutsSpy).not.toHaveBeenCalled();
    // No blockchain rows were written.
    expect(await db.blockchainTransactions.count()).toBe(0);
  });

  it("toasts \"No blockchain provider configured\" when no provider is set", async () => {
    getNodeSettingsSpy.mockResolvedValue(null as never);

    await clickImport();

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "No blockchain provider configured",
          variant: "destructive",
        }),
      ),
    );

    // Got past the txid check but bailed before reaching the provider.
    expect(getMissingSourceTxidsSpy).toHaveBeenCalled();
    expect(getBlockHeightSpy).not.toHaveBeenCalled();
    expect(fakeProvider.getTransaction).not.toHaveBeenCalled();
    expect(resolvePrevoutsSpy).not.toHaveBeenCalled();
    expect(await db.blockchainTransactions.count()).toBe(0);
  });

  it("toasts \"Can't reach the blockchain provider\" when the provider is unreachable", async () => {
    getBlockHeightSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    await clickImport();

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Can't reach the blockchain provider",
          variant: "destructive",
        }),
      ),
    );

    // Reached the provider and tried to ping it, then bailed before backfill.
    expect(getNodeSettingsSpy).toHaveBeenCalled();
    expect(getBlockHeightSpy).toHaveBeenCalled();
    expect(fakeProvider.getTransaction).not.toHaveBeenCalled();
    expect(resolvePrevoutsSpy).not.toHaveBeenCalled();
    expect(await db.blockchainTransactions.count()).toBe(0);
  });
});
