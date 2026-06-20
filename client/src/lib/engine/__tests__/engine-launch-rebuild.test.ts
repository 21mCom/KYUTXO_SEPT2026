// @vitest-environment jsdom
//
// End-to-end launch regression test (Task #309).
//
// This locks in the exact freeze-on-launch scenario the read-gate + bounded-probe
// work fixed. It walks the WHOLE launch path with the Electron worker IPC MOCKED
// (a tiny stateful worker — like the engine-client-seed suite — never real
// better-sqlite3):
//
//   1. An existing mirror was built by an OLDER engine schema version.
//   2. First launch (runBootstrap) detects the schema mismatch and kicks off a
//      background reseed.
//   3. WHILE the reseed streams, the per-screen read gate returns "use Dexie"
//      (reason 'seeding') so a page's first paint is never blocked on the
//      single-threaded worker mid-rebuild.
//   4. When the reseed finishes, the readiness subscription fires a single
//      not-ready → ready transition, telling idle pages the fast path is live.
//   5. The gate then returns "use engine" (ready-fresh) and the mirror is stamped
//      with the current schema version.
//   6. The NEXT launch sees a fresh, current-schema mirror and does NOT rebuild.
//
// jsdom gives us `window` (for window.electronAPI) and fake-indexeddb/auto gives
// the seed loop a real source vault to stream from. The Dexie-side fingerprint
// reads (record-crud / transaction-crud) are mocked to mirror the worker's
// fingerprints — fingerprint correctness itself is covered elsewhere; here we
// exercise the launch/gate/readiness orchestration.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The read gate reads the live Dexie fingerprints through these CRUD modules.
// Mock them so the test controls the "live vault" side without a real Dexie DB.
vi.mock("@/lib/data/record-crud", () => ({ getRecordsFingerprint: vi.fn() }));
vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsFingerprint: vi.fn(),
  getParticipantsFingerprint: vi.fn(),
}));

import {
  cancelSeeding,
  engineSeedInFlight,
  subscribeEngineReadiness,
  __setSeedChunkSizeForTests,
} from "../engine-client";
import { evaluateEngineFreshness } from "../engine-freshness";
import {
  __runEngineBootstrapForTests,
  __resetEngineMaintenanceForTests,
  getEngineMaintenanceState,
} from "../engine-maintenance";
import { ENGINE_SCHEMA_VERSION } from "../engine-core";
import type { EngineEnvelope } from "../../electron";
import { getRecordsFingerprint } from "@/lib/data/record-crud";
import {
  getTransactionsFingerprint,
  getParticipantsFingerprint,
} from "@/lib/data/transaction-crud";

// The poll interval the readiness subscription uses internally (engine-client).
const READINESS_POLL_MS = 2000;

// Schema versions: the existing mirror was built by the PREVIOUS version, the
// running app expects the CURRENT one. Derived from the real constant so this
// test stays correct across future schema bumps.
const CURRENT_SCHEMA = ENGINE_SCHEMA_VERSION;
const OLD_SCHEMA = ENGINE_SCHEMA_VERSION - 1;

// Fingerprints the reseeded mirror and the live Dexie vault agree on. After the
// reseed the gate compares engine-side (worker query) vs Dexie-side (mocked CRUD)
// and must find them identical to flip to the fast path.
const RECORDS_FP = { count: 3, maxId: 3, maxUpdatedAt: 100 };
const TX_FP = { count: 2, maxId: 2, maxBlockTime: 200 };
const PART_FP = { count: 4, maxId: 4, resolvedPrevoutCount: 1 };

// ---------------------------------------------------------------------------
// Source vault (fake IndexedDB) the seed loop streams from
// ---------------------------------------------------------------------------

const IDB_NAME = "KYUTXODatabase";
const STORES = ["records", "blockchainTransactions", "transactionParticipants"] as const;
type Store = (typeof STORES)[number];

function deleteIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function seedSourceIdb(
  data: Partial<Record<Store, Array<{ id: number } & Record<string, unknown>>>>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: "id" });
        }
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORES as unknown as string[], "readwrite");
      for (const store of STORES) {
        const os = tx.objectStore(store);
        for (const row of data[store] ?? []) os.put(row);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// ---------------------------------------------------------------------------
// Stateful mock worker (window.electronAPI.engine)
// ---------------------------------------------------------------------------

type EngineState = "EMPTY" | "LOADING" | "INDEXING" | "READY" | "ERROR";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (result?: unknown): Promise<EngineEnvelope> => Promise.resolve({ ok: true, result });

interface MockWorker {
  state: EngineState;
  schemaVersion: number;
  /** When set, the first seedBatch awaits this gate — holding the seed mid-flight. */
  hold: Deferred | null;
  bridge: {
    init: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    seedBegin: ReturnType<typeof vi.fn>;
    seedBatch: ReturnType<typeof vi.fn>;
    seedFinish: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    benchmark: ReturnType<typeof vi.fn>;
    reopen: ReturnType<typeof vi.fn>;
    integrityCheck: ReturnType<typeof vi.fn>;
    generateSynthetic: ReturnType<typeof vi.fn>;
    dbInfo: ReturnType<typeof vi.fn>;
  };
}

function installMockWorker(initial: { state: EngineState; schemaVersion: number }): MockWorker {
  const worker: MockWorker = {
    state: initial.state,
    schemaVersion: initial.schemaVersion,
    hold: null,
    // assigned below
    bridge: undefined as unknown as MockWorker["bridge"],
  };

  const snap = () => ({ state: worker.state, ready: worker.state === "READY" });

  worker.bridge = {
    init: vi.fn(() => ok(snap())),
    status: vi.fn(() => ok(snap())),
    // A reseed is a full rebuild: dropping to LOADING means status.ready=false
    // for the whole streaming window — exactly the not-ready baseline a page
    // sees while the worker rebuilds.
    seedBegin: vi.fn(() => {
      worker.state = "LOADING";
      return ok(snap());
    }),
    seedBatch: vi.fn(async () => {
      if (worker.hold) await worker.hold.promise; // hold the seed mid-flight
      return { ok: true } as EngineEnvelope;
    }),
    // Finalize marks the rebuilt mirror READY and stamps the CURRENT schema.
    seedFinish: vi.fn(() => {
      worker.state = "READY";
      worker.schemaVersion = CURRENT_SCHEMA;
      return ok(snap());
    }),
    clear: vi.fn(() => {
      worker.state = "EMPTY";
      return ok(snap());
    }),
    query: vi.fn((name: string) => {
      switch (name) {
        case "getEngineSchemaVersion":
          return ok(worker.schemaVersion);
        case "getRecordsFingerprint":
          return ok({ ...RECORDS_FP });
        case "getTransactionsFingerprint":
          return ok({ ...TX_FP });
        case "getParticipantsFingerprint":
          return ok({ ...PART_FP });
        default:
          return ok(null);
      }
    }),
    benchmark: vi.fn(() => ok([])),
    reopen: vi.fn(() => ok()),
    integrityCheck: vi.fn(() => ok("ok")),
    generateSynthetic: vi.fn(() => ok()),
    dbInfo: vi.fn(() => ok({ dbPath: "/tmp/x", portableMode: false })),
  };

  (window as unknown as { electronAPI: { engine: MockWorker["bridge"] } }).electronAPI = {
    engine: worker.bridge,
  };
  return worker;
}

/** Resolve after the next macrotask so real (unfaked) IDB + promise work flushes. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// ---------------------------------------------------------------------------

describe("launch with a stale-schema mirror (end-to-end)", () => {
  beforeEach(async () => {
    await deleteIdb();
    cancelSeeding();
    __resetEngineMaintenanceForTests();
    __setSeedChunkSizeForTests(2); // small batches so the seed actually streams
    // Only fake setInterval/clearInterval: the readiness poll uses setInterval, but
    // fake-indexeddb + promise work must keep running on real timers/microtasks.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    // The live Dexie vault side of the freshness compare.
    vi.mocked(getRecordsFingerprint).mockResolvedValue({ ...RECORDS_FP });
    vi.mocked(getTransactionsFingerprint).mockResolvedValue({ ...TX_FP });
    vi.mocked(getParticipantsFingerprint).mockResolvedValue({ ...PART_FP });
  });

  afterEach(async () => {
    vi.useRealTimers();
    __setSeedChunkSizeForTests();
    __resetEngineMaintenanceForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    await deleteIdb();
    vi.restoreAllMocks();
  });

  it("reseeds, keeps the app on Dexie during the seed, then flips to the engine — and the next launch does not rebuild", async () => {
    // An existing mirror, but built by the PREVIOUS schema version. The worker
    // reports READY (it is a valid, indexed mirror) — the staleness is invisible
    // to a plain readiness check and only the schema-version gate catches it.
    const worker = installMockWorker({ state: "READY", schemaVersion: OLD_SCHEMA });
    await seedSourceIdb({
      records: [1, 2, 3].map((id) => ({ id, inputString: `addr${id}` })),
      blockchainTransactions: [1, 2].map((id) => ({ id, txid: `tx${id}` })),
      transactionParticipants: [1, 2, 3, 4].map((id) => ({
        id,
        txid: "tx1",
        role: "output",
        address: "a",
        amount: id,
      })),
    });

    // Hold the seed mid-flight so we can observe the "reseed in progress" window.
    worker.hold = deferred();

    // --- Launch: bootstrap detects the schema mismatch and starts a reseed -----
    const bootstrap = __runEngineBootstrapForTests();

    await waitFor(() => engineSeedInFlight(), "seed to start");
    expect(getEngineMaintenanceState().phase).toBe("refreshing");
    // The reseed is a full rebuild — begin was issued, finish has not.
    expect(worker.bridge.seedBegin).toHaveBeenCalledTimes(1);
    expect(worker.bridge.seedFinish).not.toHaveBeenCalled();

    // Ignore the status() the bootstrap itself made before deciding to reseed —
    // we only want to prove the GATE never touches the worker while seeding.
    worker.bridge.status.mockClear();

    // --- While the reseed streams: every scope must fall back to Dexie ---------
    for (const scope of ["records", "transactions", "allMirrors"] as const) {
      await expect(evaluateEngineFreshness(scope)).resolves.toEqual({
        useEngine: false,
        reason: "seeding",
      });
    }
    // The gate short-circuited on the in-flight seed WITHOUT round-tripping to
    // the (mid-rebuild, possibly blocked) worker.
    expect(worker.bridge.status).not.toHaveBeenCalled();

    // A page that subscribes now sees the worker as not-ready (rebuilding). This
    // baseline is what makes the later transition a true not-ready → ready event.
    const transitions: boolean[] = [];
    const unsubscribe = subscribeEngineReadiness((ready) => transitions.push(ready));
    await flush(); // let the priming poll establish the not-ready baseline
    expect(transitions).toEqual([]); // baseline never fires a notification

    // --- Reseed finishes -------------------------------------------------------
    worker.hold.resolve();
    await bootstrap;

    expect(getEngineMaintenanceState().phase).toBe("ready");
    expect(worker.bridge.seedFinish).toHaveBeenCalledTimes(1);
    expect(worker.bridge.clear).not.toHaveBeenCalled(); // not cancelled
    expect(worker.schemaVersion).toBe(CURRENT_SCHEMA); // mirror re-stamped

    // The readiness poll observes the worker go READY and fires exactly one
    // not-ready → ready transition, waking idle pages to re-query the fast path.
    await vi.advanceTimersByTimeAsync(READINESS_POLL_MS);
    expect(transitions).toEqual([true]);

    // --- The gate now transparently switches every scope to the engine --------
    for (const scope of ["records", "transactions", "allMirrors"] as const) {
      await expect(evaluateEngineFreshness(scope)).resolves.toEqual({
        useEngine: true,
        reason: "ready-fresh",
      });
    }

    unsubscribe();

    // --- Next launch: fresh, current-schema mirror → NO rebuild ---------------
    __resetEngineMaintenanceForTests();
    await __runEngineBootstrapForTests();

    expect(getEngineMaintenanceState().phase).toBe("ready");
    // seedBegin/seedFinish are still at their single reseed from the first launch:
    // the second launch verified freshness and rebuilt nothing.
    expect(worker.bridge.seedBegin).toHaveBeenCalledTimes(1);
    expect(worker.bridge.seedFinish).toHaveBeenCalledTimes(1);
  });
});
