// @vitest-environment jsdom
//
// Component-level coverage for BalanceOverview's "Import missing history" HAPPY
// path (button-import-missing-history). Task #839 covered the cancel path; this
// is the complementary "let it run to completion" path. When a history import
// finishes without being cancelled, the contract is:
//   1. Every fetched source transaction is written to the vault (the
//      blockchainTransactions rows persist).
//   2. The follow-up "Resolve & Recompute" pass DOES run — resolvePrevouts is
//      called with recomputeOrigin "user" — so the imported source outputs get
//      linked to the spends that reference them and overstated balances drop.
//   3. A "History imported" toast appears reporting the imported count.
//
// The REAL runTxidBackfill drives the import against a fake provider whose
// getTransaction resolves immediately, so the run completes on its own. Writes
// go through the genuine transaction-crud against fake-indexeddb, so the
// persisted blockchainTransactions rows are real. Fully offline — no network.
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
import type { ApiTransaction } from "@/lib/blockchain-api";

// ── Toast capture ────────────────────────────────────────────────────────────
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// Keep the db-change signal constant so the spend-health effects run once and
// don't re-fire on writes (the import handler updates state directly).
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

// The crux of assertion #2: the post-import resolve pass MUST run when the
// import completes. Spy on it so we can assert it was called with the right
// recomputeOrigin. The spy also flips `importResolved` so the stateful
// spend-health mocks below report zero unattributable spends afterward — i.e.
// the imported history fixed the balances.
const { resolvePrevoutsSpy, state } = vi.hoisted(() => ({
  resolvePrevoutsSpy: vi.fn(),
  state: { importResolved: false },
}));
resolvePrevoutsSpy.mockImplementation(async () => {
  state.importResolved = true;
  return { resolved: 0, total: 0 };
});
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts: resolvePrevoutsSpy },
}));

// A configured provider always exists; createProviderFromSettings returns our
// fake regardless of what this hands back.
vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: vi.fn(async () => ({ providerType: "mempool" })),
}));

// Spend-health numbers that surface the warning banner + import button. Before
// the import resolves, getUnresolvedSpendBreakdown reports unattributable
// spends (so the import button shows); after the resolve pass runs they drop to
// zero, mirroring real attribution fixing the balances. The import handler
// pulls the missing source txids from getMissingSourceTxids; the REAL backfill
// engine + CRUD writes do the rest.
const { MISSING_TXIDS } = vi.hoisted(() => {
  const ids: string[] = [];
  for (let i = 1; i <= 12; i++) ids.push(i.toString(16).padStart(64, "0"));
  return { MISSING_TXIDS: ids };
});
vi.mock("@/lib/data/transaction-crud", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/data/transaction-crud")>();
  return {
    ...actual,
    countUnresolvedPrevoutInputs: vi.fn(async () =>
      state.importResolved ? 0 : MISSING_TXIDS.length,
    ),
    getUnresolvedSpendBreakdown: vi.fn(async () => ({
      byRecordId: new Map<number, number>(),
      unattributable: state.importResolved ? 0 : MISSING_TXIDS.length,
    })),
    getMissingSourceTxids: vi.fn(async () => [...MISSING_TXIDS]),
    getMissingSourceTxidDetails: vi.fn(async () => []),
  };
});

// ── Fake provider (resolves immediately so the run completes on its own) ──────
let requestedTxids: string[] = [];

function fakeRawTx(txid: string): ApiTransaction {
  return {
    txid,
    version: 2,
    locktime: 0,
    status: { confirmed: true, block_height: 700000, block_time: 1_600_000_000 },
    fee: 200,
    size: 200,
    weight: 800,
    vin: [],
    vout: [
      {
        scriptpubkey: "0014abcdef",
        scriptpubkey_asm: "",
        scriptpubkey_type: "v0_p2wpkh",
        scriptpubkey_address: `bc1qfake${txid.slice(-6)}`,
        value: 100000,
        n: 0,
      },
    ],
  };
}

const fakeProvider = {
  name: "fake",
  getBlockHeight: vi.fn(async () => 800000),
  getAddressTransactions: vi.fn(async () => []),
  getTransaction: vi.fn(async (txid: string) => {
    requestedTxids.push(txid);
    return fakeRawTx(txid);
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

beforeEach(async () => {
  toastSpy.mockClear();
  resolvePrevoutsSpy.mockClear();
  fakeProvider.getTransaction.mockClear();
  fakeProvider.getBlockHeight.mockClear();
  state.importResolved = false;
  requestedTxids = [];
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await db.records.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBalanceOverview() {
  return renderWithProviders(<BalanceOverview />);
}

describe("BalanceOverview — completing a history import", () => {
  it("writes every fetched source transaction, runs the resolve+recompute pass, and toasts the imported count", async () => {
    renderBalanceOverview();

    // The warning banner's import action appears once the spend-health effects
    // report unattributable spends.
    const importBtn = await screen.findByTestId("button-import-missing-history");
    fireEvent.click(importBtn);

    // Let the import run to completion (no cancel) and toast its success.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "History imported" }),
      ),
    );

    // 1) Every fetched source transaction is persisted to the vault.
    expect(await db.blockchainTransactions.count()).toBe(MISSING_TXIDS.length);
    // All txids were requested from the provider (nothing skipped/stopped early).
    for (const txid of MISSING_TXIDS) {
      expect(requestedTxids).toContain(txid);
    }

    // 2) The follow-up Resolve & Recompute pass DID run, with recomputeOrigin
    //    "user" — this is what links the imported source outputs to the spends
    //    and corrects the overstated balances.
    expect(resolvePrevoutsSpy).toHaveBeenCalledTimes(1);
    expect(resolvePrevoutsSpy).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ recomputeOrigin: "user" }),
    );

    // 3) The success toast reports how many source transactions were imported.
    const importedCall = toastSpy.mock.calls.find(
      ([arg]) => arg?.title === "History imported",
    );
    expect(importedCall?.[0].description).toContain(
      `Imported ${MISSING_TXIDS.length.toLocaleString()} source transaction`,
    );
  });
});
