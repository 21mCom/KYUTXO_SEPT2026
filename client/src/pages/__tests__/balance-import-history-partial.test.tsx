// @vitest-environment jsdom
//
// Component-level coverage for BalanceOverview's "Import missing history"
// PARTIAL-attribution outcome (button-import-missing-history). The fully-
// attributed completion path ("All spends are now attributed and balances
// corrected") is covered in balance-import-history-complete.test.tsx. This is
// the complementary outcome: the import runs to completion, the Resolve &
// Recompute pass runs, but SOME spends remain unattributable because their
// source addresses aren't tracked. The contract is:
//   1. Every fetched source transaction is still written to the vault.
//   2. The follow-up "Resolve & Recompute" pass still runs.
//   3. The "History imported" toast accurately reports the leftover
//      unattributable count and uses the "still can't be attributed (their
//      source addresses aren't tracked)" wording — so users know the balance
//      is still incomplete instead of being told everything is fixed.
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
  getRecordsByInputStrings: vi.fn(async () => []),
}));

vi.mock("@/lib/data/address-stats", () => ({
  recomputeAddressStats: vi.fn(async () => ({ cancelled: false })),
  countHeuristicMatchedAddresses: vi.fn(() => Promise.resolve(0)),
}));

// The post-import resolve pass MUST run when the import completes. Spy on it so
// we can assert it was called with the right recomputeOrigin. The spy flips
// `importResolved` so the stateful spend-health mocks below transition from
// "all spends unattributable" (before import) to "only some attributable"
// (after) — modelling imported history that partially, but not fully, fixed
// the balances.
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
vi.mock("@/lib/tor-proxy-settings-sync", () => ({
  syncTorProxySettings: vi.fn(async () => {}),
  torProxySettingsFromNodeSettings: vi.fn(() => ({})),
}));

// Spend-health numbers that surface the warning banner + import button. Before
// the import resolves, getUnresolvedSpendBreakdown reports EVERY spend as
// unattributable (so the import button shows). After the resolve pass runs the
// count drops — but NOT to zero: REMAINING_UNATTRIBUTABLE spends are still
// unattributable because their source addresses aren't tracked. The import
// handler pulls the missing source txids from getMissingSourceTxids; the REAL
// backfill engine + CRUD writes do the rest.
const { MISSING_TXIDS, REMAINING_UNATTRIBUTABLE } = vi.hoisted(() => {
  const ids: string[] = [];
  for (let i = 1; i <= 12; i++) ids.push(i.toString(16).padStart(64, "0"));
  return { MISSING_TXIDS: ids, REMAINING_UNATTRIBUTABLE: 5 };
});
vi.mock("@/lib/data/transaction-crud", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/data/transaction-crud")>();
  return {
    ...actual,
    countUnresolvedPrevoutInputs: vi.fn(async () =>
      state.importResolved ? REMAINING_UNATTRIBUTABLE : MISSING_TXIDS.length,
    ),
    getUnresolvedSpendBreakdown: vi.fn(async () => ({
      byRecordId: new Map<number, number>(),
      unattributable: state.importResolved
        ? REMAINING_UNATTRIBUTABLE
        : MISSING_TXIDS.length,
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

vi.mock("@/lib/blockchain-api", () => ({
  MINIMUM_CONFIRMATIONS: 5,
  createProviderFromSettings: vi.fn(() => fakeProvider),
  parseTransaction: vi.fn((tx: ApiTransaction) => {
    if (!tx.status.confirmed || !tx.status.block_height || !tx.status.block_time) {
      return null;
    }
    return {
      txid: tx.txid,
      blockHeight: tx.status.block_height,
      blockTime: tx.status.block_time,
      fee: tx.fee,
      feeRate: tx.weight > 0 ? Math.round((tx.fee / tx.weight) * 4) : 0,
      size: tx.size,
      weight: tx.weight,
      vsize: tx.weight > 0 ? Math.ceil(tx.weight / 4) : tx.size,
      inputs: [],
      outputs: tx.vout
        .filter((output) => output.scriptpubkey_address)
        .map((output) => ({
          address: output.scriptpubkey_address!,
          amount: output.value,
          vout: output.n,
          scriptType: "p2wpkh",
        })),
      hasOpReturn: false,
      opReturnData: [],
      nVersion: tx.version,
      nLockTime: tx.locktime,
      hasCoinbaseInput: false,
      rawFingerprintCaptured: true,
    };
  }),
}));

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

describe("BalanceOverview — completing a history import that only partially attributes", () => {
  it("still writes + resolves, then toasts the leftover unattributable count with the right wording", async () => {
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

    // 1) Every fetched source transaction is still persisted to the vault, and
    //    every txid was requested (nothing skipped/stopped early).
    expect(await db.blockchainTransactions.count()).toBe(MISSING_TXIDS.length);
    for (const txid of MISSING_TXIDS) {
      expect(requestedTxids).toContain(txid);
    }

    // 2) The follow-up Resolve & Recompute pass still ran, with recomputeOrigin
    //    "user" — partial attribution does not skip the recompute.
    expect(resolvePrevoutsSpy).toHaveBeenCalledTimes(1);
    expect(resolvePrevoutsSpy).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ recomputeOrigin: "user" }),
    );

    // 3) The success toast accurately reports the leftover unattributable count
    //    and uses the "still can't be attributed" wording — it must NOT claim
    //    everything was fixed.
    const importedCall = toastSpy.mock.calls.find(
      ([arg]) => arg?.title === "History imported",
    );
    const description: string = importedCall?.[0].description ?? "";
    expect(description).toContain(
      `Imported ${MISSING_TXIDS.length.toLocaleString()} source transaction`,
    );
    expect(description).toContain(
      `${REMAINING_UNATTRIBUTABLE.toLocaleString()} spends still can't be attributed (their source addresses aren't tracked).`,
    );
    // Must not falsely claim a full fix.
    expect(description).not.toContain("All spends are now attributed");
  });
});
