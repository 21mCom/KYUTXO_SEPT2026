// Locks in the restore-success toast suffix wording produced by
// runPostRestoreTxidBackfill. The helper is intentionally never-throwing, so
// without these tests a regression could silently drop the
// "N transactions need on-chain data…" / "Transaction data: …" wording.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPostRestoreTxidBackfill } from "./post-restore-backfill";
import { detectOrphanedTxRecords, runTxidBackfill } from "@/lib/txid-backfill";
import { getNodeSettings } from "@/lib/data/node-settings-crud";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import type { BackfillResult } from "@/lib/txid-backfill";

vi.mock("@/lib/txid-backfill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/txid-backfill")>();
  return {
    ...actual, // keep the real formatSkippedReasons wording
    detectOrphanedTxRecords: vi.fn(),
    runTxidBackfill: vi.fn(),
  };
});

vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: vi.fn(),
}));

vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: vi.fn(),
}));

const mockDetect = vi.mocked(detectOrphanedTxRecords);
const mockRunBackfill = vi.mocked(runTxidBackfill);
const mockGetNodeSettings = vi.mocked(getNodeSettings);
const mockCreateProvider = vi.mocked(createProviderFromSettings);

function makeCallbacks() {
  return { onMessage: vi.fn(), onPercent: vi.fn() };
}

function backfillResult(overrides: Partial<BackfillResult> = {}): BackfillResult {
  return {
    orphansFound: 0,
    rebuilt: 0,
    skipped: 0,
    skippedReasons: {},
    failed: 0,
    prevoutsResolved: 0,
    deferred: false,
    errors: [],
    ...overrides,
  };
}

const TXIDS = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runPostRestoreTxidBackfill", () => {
  it("returns an empty suffix and orphansFound=false when there are no orphans", async () => {
    mockDetect.mockResolvedValue({ txids: [], recordIds: new Map() });
    const cb = makeCallbacks();

    const result = await runPostRestoreTxidBackfill(cb);

    expect(result).toEqual({ suffix: "", orphansFound: false });
    expect(cb.onMessage).not.toHaveBeenCalled();
    expect(mockGetNodeSettings).not.toHaveBeenCalled();
    expect(mockRunBackfill).not.toHaveBeenCalled();
  });

  it("defers with the plain-language suffix when there are no node settings", async () => {
    mockDetect.mockResolvedValue({ txids: TXIDS, recordIds: new Map() });
    mockGetNodeSettings.mockResolvedValue(undefined as any);
    const cb = makeCallbacks();

    const result = await runPostRestoreTxidBackfill(cb);

    expect(result.orphansFound).toBe(true);
    expect(result.suffix).toBe(
      ' 3 transactions need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.',
    );
    expect(cb.onMessage).toHaveBeenCalledWith(
      "Rebuilding on-chain data for 3 transactions…",
    );
    expect(mockRunBackfill).not.toHaveBeenCalled();
  });

  it("uses singular wording for a single orphan", async () => {
    mockDetect.mockResolvedValue({ txids: [TXIDS[0]], recordIds: new Map() });
    mockGetNodeSettings.mockResolvedValue(undefined as any);

    const result = await runPostRestoreTxidBackfill(makeCallbacks());

    expect(result.suffix).toBe(
      ` 1 transaction (${"a".repeat(8)}…${"a".repeat(6)}) needs on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`,
    );
    expect(result.orphansFound).toBe(true);
  });

  it("defers with the same suffix when the provider is unreachable", async () => {
    mockDetect.mockResolvedValue({ txids: TXIDS, recordIds: new Map() });
    mockGetNodeSettings.mockResolvedValue({ id: "default" } as any);
    mockCreateProvider.mockReturnValue({
      getBlockHeight: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as any);

    const result = await runPostRestoreTxidBackfill(makeCallbacks());

    expect(result.orphansFound).toBe(true);
    expect(result.suffix).toBe(
      ' 3 transactions need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.',
    );
    expect(mockRunBackfill).not.toHaveBeenCalled();
  });

  it("builds the 'Transaction data:' summary suffix on a successful backfill", async () => {
    mockDetect.mockResolvedValue({ txids: TXIDS, recordIds: new Map() });
    mockGetNodeSettings.mockResolvedValue({ id: "default" } as any);
    mockCreateProvider.mockReturnValue({
      getBlockHeight: vi.fn().mockResolvedValue(850000),
    } as any);
    mockRunBackfill.mockResolvedValue(
      backfillResult({
        orphansFound: 3,
        rebuilt: 2,
        skipped: 1,
        skippedReasons: { "not-found": 1 },
        prevoutsResolved: 4,
      }),
    );

    const result = await runPostRestoreTxidBackfill(makeCallbacks());

    expect(result.orphansFound).toBe(true);
    expect(result.suffix).toBe(
      " Transaction data: 2 rebuilt; 1 not found on your connected provider; 4 input addresses resolved.",
    );
  });

  it("includes failed counts and falls back to 'N skipped' when reasons are empty", async () => {
    mockDetect.mockResolvedValue({ txids: TXIDS, recordIds: new Map() });
    mockGetNodeSettings.mockResolvedValue({ id: "default" } as any);
    mockCreateProvider.mockReturnValue({
      getBlockHeight: vi.fn().mockResolvedValue(850000),
    } as any);
    mockRunBackfill.mockResolvedValue(
      backfillResult({ orphansFound: 3, skipped: 2, skippedReasons: {}, failed: 1 }),
    );

    const result = await runPostRestoreTxidBackfill(makeCallbacks());

    expect(result.suffix).toBe(" Transaction data: 2 skipped; 1 failed.");
    expect(result.orphansFound).toBe(true);
  });

  it("returns an empty suffix (orphansFound=true) when the backfill has nothing to report", async () => {
    mockDetect.mockResolvedValue({ txids: TXIDS, recordIds: new Map() });
    mockGetNodeSettings.mockResolvedValue({ id: "default" } as any);
    mockCreateProvider.mockReturnValue({
      getBlockHeight: vi.fn().mockResolvedValue(850000),
    } as any);
    mockRunBackfill.mockResolvedValue(backfillResult({ orphansFound: 3 }));

    const result = await runPostRestoreTxidBackfill(makeCallbacks());

    expect(result).toEqual({ suffix: "", orphansFound: true });
  });

  it("forwards progress messages and percent from the backfill onProgress", async () => {
    mockDetect.mockResolvedValue({ txids: TXIDS, recordIds: new Map() });
    mockGetNodeSettings.mockResolvedValue({ id: "default" } as any);
    mockCreateProvider.mockReturnValue({
      getBlockHeight: vi.fn().mockResolvedValue(850000),
    } as any);
    mockRunBackfill.mockImplementation(async (_provider, _txids, options) => {
      options?.onProgress?.({
        phase: "fetching",
        orphansFound: 3,
        processed: 1,
        rebuilt: 1,
        skipped: 0,
        failed: 0,
      });
      return backfillResult({ orphansFound: 3, rebuilt: 3 });
    });
    const cb = makeCallbacks();

    await runPostRestoreTxidBackfill(cb);

    expect(cb.onMessage).toHaveBeenCalledWith("Rebuilding 1 of 3 transactions…");
    expect(cb.onPercent).toHaveBeenCalledWith(33);
  });

  it("returns an empty suffix and orphansFound=false when detection itself throws", async () => {
    mockDetect.mockRejectedValue(new Error("db closed"));

    const result = await runPostRestoreTxidBackfill(makeCallbacks());

    expect(result).toEqual({ suffix: "", orphansFound: false });
  });
});
