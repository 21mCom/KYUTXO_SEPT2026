// Engine read-gate regression tests (Task #308).
//
// The native read-engine worker is single-threaded: while it runs the long
// SYNCHRONOUS seed `finalize` step (build indexes -> materialize UTXOs ->
// integrity_check) it cannot answer status/schema/fingerprint IPC. The gate must
// NEVER hang a page's first paint on that — it must degrade to Dexie. These tests
// pin the two guards that guarantee it:
//   1. an in-flight seed short-circuits to Dexie WITHOUT touching the worker, and
//   2. a worker probe that does not answer promptly times out to Dexie (no hang).
//
// Every engine/Dexie dependency is mocked, so this runs in the default node env
// with no better-sqlite3 and no IndexedDB.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../engine-client", () => ({
  isEngineAvailable: vi.fn(),
  engineSeedInFlight: vi.fn(),
  getEngineStatus: vi.fn(),
  engineGetSchemaVersion: vi.fn(),
  engineGetRecordsFingerprint: vi.fn(),
  engineGetTransactionsFingerprint: vi.fn(),
  engineGetParticipantsFingerprint: vi.fn(),
  engineGetTransactionMetadataFingerprint: vi.fn(),
}));
vi.mock("../engine-core", () => ({ ENGINE_SCHEMA_VERSION: 2 }));
vi.mock("@/lib/data/record-crud", () => ({ getRecordsFingerprint: vi.fn() }));
vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsFingerprint: vi.fn(),
  getParticipantsFingerprint: vi.fn(),
}));
vi.mock("@/lib/repository", () => ({
  getVaultRepository: vi.fn(() => ({ kind: "dexie" })),
}));

import { evaluateEngineFreshness } from "../engine-freshness";
import {
  isEngineAvailable,
  engineSeedInFlight,
  getEngineStatus,
  engineGetSchemaVersion,
  engineGetRecordsFingerprint,
  engineGetTransactionsFingerprint,
  engineGetParticipantsFingerprint,
  engineGetTransactionMetadataFingerprint,
  type EngineSnapshot,
} from "../engine-client";
import { getRecordsFingerprint } from "@/lib/data/record-crud";
import { getTransactionsFingerprint, getParticipantsFingerprint } from "@/lib/data/transaction-crud";
import { getVaultRepository } from "@/lib/repository";

const READY_SNAPSHOT = { ready: true } as unknown as EngineSnapshot;
const recordsFp = { count: 3, maxId: 9, maxUpdatedAt: 100 };

// A promise that never settles — stands in for a worker blocked in `finalize`.
const NEVER = <T>() => new Promise<T>(() => {});

beforeEach(() => {
  // Default to the healthy fast-path: engine present, no seed, ready, current
  // schema, matching fingerprints. Each test overrides only what it exercises.
  vi.mocked(isEngineAvailable).mockReturnValue(true);
  vi.mocked(engineSeedInFlight).mockReturnValue(false);
  vi.mocked(getEngineStatus).mockResolvedValue(READY_SNAPSHOT);
  vi.mocked(engineGetSchemaVersion).mockResolvedValue(2);
  vi.mocked(engineGetRecordsFingerprint).mockResolvedValue({ ...recordsFp });
  vi.mocked(getRecordsFingerprint).mockResolvedValue({ ...recordsFp });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("evaluateEngineFreshness — healthy fast path", () => {
  it("uses the engine when ready, schema current, and fingerprints match", async () => {
    // Guards that the new timeout wrapper does not break normal operation.
    await expect(evaluateEngineFreshness("records")).resolves.toEqual({
      useEngine: true,
      reason: "ready-fresh",
    });
  });

  it("compares protected source fingerprints without touching renderer Dexie", async () => {
    const tx = { count: 2, maxId: 4, maxBlockTime: 200 };
    const participants = { count: 3, maxId: 8, resolvedPrevoutCount: 1 };
    const metadata = { count: 1, maxId: 6, maxUpdatedAt: 300 };
    const mirrorFingerprint = vi.fn(async (table: string) => ({
      records: recordsFp,
      blockchainTransactions: tx,
      transactionParticipants: participants,
      transactionMetadata: metadata,
    })[table]);
    vi.mocked(getVaultRepository).mockReturnValue({
      kind: "protected",
      mirrorFingerprint,
    } as never);
    vi.mocked(engineGetTransactionsFingerprint).mockResolvedValue(tx);
    vi.mocked(engineGetParticipantsFingerprint).mockResolvedValue(participants);
    vi.mocked(engineGetTransactionMetadataFingerprint).mockResolvedValue(metadata);

    await expect(evaluateEngineFreshness("coinOrigins")).resolves.toEqual({
      useEngine: true,
      reason: "ready-fresh",
    });
    expect(mirrorFingerprint).toHaveBeenCalledTimes(4);
    expect(getRecordsFingerprint).not.toHaveBeenCalled();
    expect(getTransactionsFingerprint).not.toHaveBeenCalled();
    expect(getParticipantsFingerprint).not.toHaveBeenCalled();
  });
});

describe("evaluateEngineFreshness — in-flight seed short-circuit", () => {
  it("falls back to Dexie WITHOUT probing the worker while a seed is in flight", async () => {
    vi.mocked(engineSeedInFlight).mockReturnValue(true);

    await expect(evaluateEngineFreshness("records")).resolves.toEqual({
      useEngine: false,
      reason: "seeding",
    });

    // The whole point: never round-trip to the (possibly blocked) worker.
    expect(getEngineStatus).not.toHaveBeenCalled();
    expect(engineGetSchemaVersion).not.toHaveBeenCalled();
    expect(engineGetRecordsFingerprint).not.toHaveBeenCalled();
  });
});

describe("evaluateEngineFreshness — worker stall backstop", () => {
  it("times out to Dexie (never hangs) when the status probe does not answer", async () => {
    vi.useFakeTimers();
    // The worker is blocked in finalize: status never resolves.
    vi.mocked(getEngineStatus).mockReturnValue(NEVER<EngineSnapshot>());

    const pending = evaluateEngineFreshness("records");
    // Advance past the gate's probe budget so the timeout timer fires.
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toEqual({ useEngine: false, reason: "timeout" });
  });

  it("times out to Dexie when a fingerprint probe does not answer", async () => {
    vi.useFakeTimers();
    // status + schema answer, but the engine fingerprint read stalls.
    vi.mocked(engineGetRecordsFingerprint).mockReturnValue(NEVER());

    const pending = evaluateEngineFreshness("records");
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toEqual({ useEngine: false, reason: "timeout" });
  });
});
