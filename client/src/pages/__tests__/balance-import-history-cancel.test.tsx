// @vitest-environment jsdom
//
// Component-level coverage for BalanceOverview's "Import missing history" cancel
// path (button-import-missing-history / button-cancel-import-history). When a
// long history import is cancelled mid-run, the contract is:
//   1. Any source transactions already fetched + written to the vault REMAIN
//      (cancelling only stops further fetches; it never rolls back work done).
//   2. No further provider fetches happen for txids that hadn't started yet.
//   3. An "Import cancelled" toast appears reporting how many were kept.
//   4. The follow-up resolvePrevouts ("Resolve & Recompute") pass does NOT run
//      when cancelled — we don't kick off another long pass the user just asked
//      to stop.
//
// The REAL runTxidBackfill drives the import against a fake provider whose
// getTransaction calls are resolved chunk-by-chunk under the test's control, so
// the cancel can land deterministically while a batch is in flight. Writes go
// through the genuine transaction-crud against fake-indexeddb, so the persisted
// blockchainTransactions rows are real. Fully offline — no network.
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
}));

// The whole point of assertion #4: the post-import resolve pass must NOT run on
// cancel. Spy on it so we can assert it was never called.
const { resolvePrevoutsSpy } = vi.hoisted(() => ({
  resolvePrevoutsSpy: vi.fn(async () => ({ resolved: 0, total: 0 })),
}));
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts: resolvePrevoutsSpy },
}));

// A configured provider always exists; createProviderFromSettings returns our
// controllable fake regardless of what this hands back.
vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: vi.fn(async () => ({ providerType: "mempool" })),
}));

// Spend-health numbers that surface the warning banner + import button. The
// import handler pulls the missing source txids from getMissingSourceTxids; the
// REAL backfill engine + CRUD writes do the rest. byRecordId is empty so the
// per-group attribution effect short-circuits.
const { MISSING_TXIDS } = vi.hoisted(() => {
  const ids: string[] = [];
  for (let i = 1; i <= 12; i++) ids.push((i).toString(16).padStart(64, "0"));
  return { MISSING_TXIDS: ids };
});
vi.mock("@/lib/data/transaction-crud", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/data/transaction-crud")>();
  return {
    ...actual,
    countUnresolvedPrevoutInputs: vi.fn(async () => MISSING_TXIDS.length),
    getUnresolvedSpendBreakdown: vi.fn(async () => ({
      byRecordId: new Map<number, number>(),
      unattributable: MISSING_TXIDS.length,
    })),
    getMissingSourceTxids: vi.fn(async () => [...MISSING_TXIDS]),
    getMissingSourceTxidDetails: vi.fn(async () => []),
  };
});

// ── Controllable fake provider ───────────────────────────────────────────────
// getTransaction parks each call's resolver so the test releases fetches one
// chunk at a time (runTxidBackfill's default concurrency is 4). This lets the
// cancel land deterministically with one batch written and another in flight.
interface PendingCall {
  txid: string;
  resolve: (tx: ApiTransaction | null) => void;
}
let pending: PendingCall[] = [];
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
  getTransaction: vi.fn((txid: string) => {
    requestedTxids.push(txid);
    return new Promise<ApiTransaction | null>((resolve) => {
      pending.push({ txid, resolve });
    });
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

// Resolve every currently-parked getTransaction call (one chunk) and clear the
// queue so the next chunk's calls can be observed distinctly.
function drainPending() {
  const batch = pending;
  pending = [];
  for (const c of batch) c.resolve(fakeRawTx(c.txid));
}

beforeEach(async () => {
  toastSpy.mockClear();
  resolvePrevoutsSpy.mockClear();
  fakeProvider.getTransaction.mockClear();
  fakeProvider.getBlockHeight.mockClear();
  pending = [];
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

describe("BalanceOverview — cancelling an in-progress history import", () => {
  it("keeps already-imported transactions, stops further fetches, toasts the kept count, and skips the resolve pass", async () => {
    renderBalanceOverview();

    // The warning banner's import action appears once the spend-health effects
    // report unattributable spends.
    const importBtn = await screen.findByTestId("button-import-missing-history");
    fireEvent.click(importBtn);

    // First chunk of 4 fetches is now in flight (parked, under our control).
    await waitFor(() => expect(pending.length).toBe(4));
    expect(await db.blockchainTransactions.count()).toBe(0);

    // Release chunk 1 → its 4 rows get written, and chunk 2's fetches start.
    drainPending();
    await waitFor(async () => {
      expect(await db.blockchainTransactions.count()).toBe(4);
      expect(pending.length).toBe(4);
    });

    // Cancel now, while chunk 2 is in flight. The 4 already-imported source
    // transactions must remain in the vault right at the moment of cancel.
    fireEvent.click(screen.getByTestId("button-cancel-import-history"));
    expect(await db.blockchainTransactions.count()).toBe(4);

    const requestedAtCancel = [...requestedTxids];

    // Let the in-flight chunk 2 settle so the run can finish and toast. The
    // backfill loop sees the abort at the next chunk boundary and stops; chunk 3
    // is never fetched.
    drainPending();

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Import cancelled" }),
      ),
    );

    // 1) Imported-before-cancel rows persisted (nothing was rolled back); the
    //    in-flight batch that resolved is kept too, but never more than fetched.
    const finalCount = await db.blockchainTransactions.count();
    expect(finalCount).toBeGreaterThanOrEqual(4);
    expect(finalCount).toBe(requestedAtCancel.length);

    // 2) No further fetches after cancel: the not-yet-started chunk(s) — the
    //    last group of txids — were never requested from the provider.
    const neverFetched = MISSING_TXIDS.slice(requestedAtCancel.length);
    expect(neverFetched.length).toBeGreaterThan(0);
    for (const txid of neverFetched) {
      expect(requestedTxids).not.toContain(txid);
    }

    // 3) The cancel toast reports how many were kept.
    const cancelCall = toastSpy.mock.calls.find(
      ([arg]) => arg?.title === "Import cancelled",
    );
    expect(cancelCall?.[0].description).toContain(
      `Kept ${finalCount.toLocaleString()} source transaction`,
    );

    // 4) The follow-up resolvePrevouts ("Resolve & Recompute") pass did NOT run.
    expect(resolvePrevoutsSpy).not.toHaveBeenCalled();
  });
});
