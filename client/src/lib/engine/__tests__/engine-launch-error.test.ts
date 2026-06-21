// @vitest-environment jsdom
//
// Launch regression test: a failed (ERROR) engine must NOT retry-loop.
//
// engine-maintenance.runBootstrap deliberately does NOT auto-reseed when the
// worker reports state 'ERROR' at launch. A prior seed failed and tearing it
// down + rebuilding on every launch would thrash the single-threaded worker and
// never converge; instead the failure is surfaced once (phase 'error') and the
// per-screen read gate keeps every screen on Dexie.
//
// This pins that contract so a future refactor can't silently reintroduce a
// reseed loop. The Electron worker IPC is MOCKED (a tiny stateful worker — like
// the engine-launch-rebuild suite — never real better-sqlite3).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The read gate reads the live Dexie fingerprints through these CRUD modules.
// The ERROR/not-ready path short-circuits before they are touched, but mock them
// so importing engine-freshness never reaches a real Dexie DB.
vi.mock("@/lib/data/record-crud", () => ({ getRecordsFingerprint: vi.fn() }));
vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsFingerprint: vi.fn(),
  getParticipantsFingerprint: vi.fn(),
}));

import { evaluateEngineFreshness } from "../engine-freshness";
import {
  __runEngineBootstrapForTests,
  __resetEngineMaintenanceForTests,
  getEngineMaintenanceState,
} from "../engine-maintenance";
import type { EngineEnvelope } from "../../electron";

const ok = (result?: unknown): Promise<EngineEnvelope> =>
  Promise.resolve({ ok: true, result });

// ---------------------------------------------------------------------------
// Stateful mock worker (window.electronAPI.engine), stuck in ERROR.
// ---------------------------------------------------------------------------

function installErrorWorker() {
  const snap = () => ({ state: "ERROR" as const, ready: false });
  const bridge = {
    init: vi.fn(() => ok(snap())),
    status: vi.fn(() => ok(snap())),
    seedBegin: vi.fn(() => ok(snap())),
    seedBatch: vi.fn(() => ok()),
    seedFinish: vi.fn(() => ok(snap())),
    clear: vi.fn(() => ok(snap())),
    query: vi.fn(() => ok(null)),
    benchmark: vi.fn(() => ok([])),
    reopen: vi.fn(() => ok()),
    integrityCheck: vi.fn(() => ok("ok")),
    generateSynthetic: vi.fn(() => ok()),
    dbInfo: vi.fn(() => ok({ dbPath: "/tmp/x", portableMode: false })),
  };
  (window as unknown as { electronAPI: { engine: typeof bridge } }).electronAPI = {
    engine: bridge,
  };
  return bridge;
}

// ---------------------------------------------------------------------------

describe("launch with a failed (ERROR) engine — no retry loop", () => {
  beforeEach(() => {
    __resetEngineMaintenanceForTests();
  });

  afterEach(() => {
    __resetEngineMaintenanceForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.restoreAllMocks();
  });

  it("surfaces the failure once, attempts no reseed, and keeps screens on Dexie", async () => {
    const bridge = installErrorWorker();

    // --- Launch: bootstrap sees ERROR and must NOT reseed -------------------
    await __runEngineBootstrapForTests();

    // The failure is surfaced once via the maintenance phase.
    expect(getEngineMaintenanceState().phase).toBe("error");

    // No rebuild was attempted: a reseed would call seedBegin/seedBatch/seedFinish.
    expect(bridge.seedBegin).not.toHaveBeenCalled();
    expect(bridge.seedBatch).not.toHaveBeenCalled();
    expect(bridge.seedFinish).not.toHaveBeenCalled();
    // The mirror was not torn down either.
    expect(bridge.clear).not.toHaveBeenCalled();

    // --- The read gate keeps every scope on Dexie --------------------------
    for (const scope of ["records", "transactions", "allMirrors"] as const) {
      await expect(evaluateEngineFreshness(scope)).resolves.toEqual({
        useEngine: false,
        reason: "not-ready",
      });
    }

    // --- A SECOND launch still does not reseed (the loop is the regression) -
    __resetEngineMaintenanceForTests();
    await __runEngineBootstrapForTests();

    expect(getEngineMaintenanceState().phase).toBe("error");
    expect(bridge.seedBegin).not.toHaveBeenCalled();
    expect(bridge.seedFinish).not.toHaveBeenCalled();
    expect(bridge.clear).not.toHaveBeenCalled();
  });
});
