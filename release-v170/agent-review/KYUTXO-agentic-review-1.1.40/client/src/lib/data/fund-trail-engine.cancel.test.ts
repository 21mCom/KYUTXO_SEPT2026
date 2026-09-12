// @vitest-environment jsdom
//
// Mid-scan cancellation tests for computeOneHop() in fund-trail-engine.ts.
//
// A single very wide hop (one address touched by hundreds of thousands of
// participant/lineage rows) used to scan entirely synchronously, freezing the
// UI and ignoring a Cancel click until it finished. computeOneHop now yields
// and re-checks the AbortSignal every SCAN_YIELD_EVERY (5000) iterations inside
// each of its five in-memory scan loops:
//   - step 2   — participant fallback (by address)            [allParticipants]
//   - step 4a  — incoming lineage rows                        [incomingLineage]
//   - step 4b  — incoming participant fallback (by txid group)
//   - step 5a  — outgoing lineage rows                        [outgoingLineage]
//   - step 5b  — outgoing participant fallback (by txid group)
//
// These tests prove cancellation is observed *within* one wide loop, not merely
// between hops, and would FAIL if a refactor silently dropped the per-loop abort
// checks (reintroducing the freeze).
//
// To make timing deterministic the database is a tiny in-memory mock whose
// queries resolve on MICROTASKS only (never setTimeout). That means the ONLY
// macrotask yield inside computeOneHop comes from scanYield's `setTimeout(0)`.
// Two cancellation strategies exploit that:
//
//   1. Macrotask abort (steps 2, 4a, 5a — loops whose candidate txid set stays
//      at 1, so no batched setTimeout muddies the picture): a real
//      AbortController.abort() is scheduled as a setTimeout(0). Because the
//      fixture's only macrotask is scanYield, the abort can only land while the
//      wide loop is mid-yield. Remove that loop's scanYield and computeOneHop
//      finishes entirely on microtasks BEFORE the abort macrotask fires — so it
//      RESOLVES instead of rejecting, and the test fails. This is the regression
//      guard.
//
//   2. Data-triggered abort (steps 4b, 5b — loops over txid groups, which
//      inherently need >5000 txids and therefore batched setTimeout yields): a
//      plain mutable signal is flipped to aborted by a getter on a field that is
//      only read INSIDE the target loop. Remove that loop's scanYield and the
//      flipped flag is never re-checked (no abort check follows step 5b), so
//      computeOneHop RESOLVES — again failing the test.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  TransactionParticipant,
  UtxoLineage,
} from "@/lib/database";

// ---------------------------------------------------------------------------
// Tiny microtask-only Dexie stand-in
// ---------------------------------------------------------------------------

/** Records every `.where(field)` call so a test can prove a downstream query
 *  (e.g. loadBlockTimes' blockchainTransactions lookup) was NOT reached. */
const whereLog: string[] = [];

class MockTable<T extends Record<string, unknown>> {
  rows: T[] = [];
  constructor(private name: string) {}

  where(field: string) {
    whereLog.push(`${this.name}.${field}`);
    const rows = this.rows;
    return {
      anyOf: (values: unknown[]) => {
        const set = new Set(values);
        // Resolves on a microtask (async), never via setTimeout.
        return { toArray: async () => rows.filter((r) => set.has(r[field])) };
      },
      equals: (value: unknown) => ({
        toArray: async () => rows.filter((r) => r[field] === value),
        first: async () => rows.find((r) => r[field] === value),
      }),
    };
  }
}

interface MockDb {
  records: MockTable<Record<string, unknown>>;
  blockchainTransactions: MockTable<Record<string, unknown>>;
  transactionParticipants: MockTable<Record<string, unknown>>;
  utxoLineage: MockTable<Record<string, unknown>>;
}

let db: MockDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    get db() {
      return db;
    },
    notifyDbChange: vi.fn(),
  };
});

const { computeOneHop } = await import("./fund-trail-engine");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROUP_ADDR = "group-addr";
const SELF_LABEL = "MyWallet";
const NO_CAP = { txLimit: 1_000_000 } as const;

// SCAN_YIELD_EVERY is 5000 (private). A "macrotask abort" loop must hit at least
// TWO scanYields (one to yield so the abort can fire, the next to observe it),
// so it needs > 10000 rows.
const WIDE_MACROTASK = 12_000;
// A "data-triggered abort" loop flips the signal at iteration 0, so a single
// scanYield (> 5000 rows) is enough to observe it.
const WIDE_GETTER = 6_000;

function freshDb(): void {
  db = {
    records: new MockTable("records"),
    blockchainTransactions: new MockTable("blockchainTransactions"),
    transactionParticipants: new MockTable("transactionParticipants"),
    utxoLineage: new MockTable("utxoLineage"),
  };
  whereLog.length = 0;
}

beforeEach(freshDb);

/** Resolves the rejection (or `undefined` if the promise resolved instead). */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

function expectAbortError(err: unknown): void {
  expect(err, "expected computeOneHop to reject mid-scan, but it resolved").toBeDefined();
  expect((err as DOMException).name).toBe("AbortError");
}

// ---------------------------------------------------------------------------
// Strategy 1: macrotask abort (steps 2, 4a, 5a)
// ---------------------------------------------------------------------------

describe("computeOneHop mid-scan cancellation (macrotask abort)", () => {
  it("step 2: aborts within the wide participant-fallback scan, before completing", async () => {
    // 12000 output participants on ONE address, all sharing a single txid so the
    // candidate set stays at 1 (no batched setTimeout) — the only macrotask in
    // the whole run is step 2's scanYield.
    const sharedTxid = "wide-tx";
    db.transactionParticipants.rows = Array.from(
      { length: WIDE_MACROTASK },
      (_, i) =>
        ({
          txid: sharedTxid,
          role: "output",
          address: GROUP_ADDR,
          amount: 100,
          vout: i,
        }) as unknown as Record<string, unknown>,
    );

    const controller = new AbortController();
    const promise = computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      controller.signal,
      NO_CAP,
    );
    // Fires only once computeOneHop yields to a macrotask — i.e. mid step-2 scan.
    setTimeout(() => controller.abort(), 0);

    expectAbortError(await rejectionOf(promise));

    // loadBlockTimes (the blockchainTransactions lookup) runs strictly AFTER the
    // step 2 loop. Never reaching it proves the scan was cut short mid-loop, not
    // merely caught by the post-loop inter-step check.
    expect(whereLog).not.toContain("blockchainTransactions.txid");
  });

  it("step 4a: aborts within the wide incoming-lineage scan", async () => {
    const sharedTxid = "wide-lin-in";
    db.utxoLineage.rows = Array.from({ length: WIDE_MACROTASK }, () => ({
      spentAddress: "ext-src",
      spentAmount: 100,
      consumingTxid: sharedTxid,
      createdTxid: sharedTxid,
      createdVout: 0,
      createdAddress: GROUP_ADDR,
      createdAmount: 100,
      blockTime: 1000,
    })) as unknown as Record<string, unknown>[];

    const controller = new AbortController();
    const promise = computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      controller.signal,
      NO_CAP,
    );
    setTimeout(() => controller.abort(), 0);

    expectAbortError(await rejectionOf(promise));
  });

  it("step 5a: aborts within the wide outgoing-lineage scan", async () => {
    const sharedTxid = "wide-lin-out";
    db.utxoLineage.rows = Array.from({ length: WIDE_MACROTASK }, () => ({
      spentAddress: GROUP_ADDR,
      spentAmount: 100,
      consumingTxid: sharedTxid,
      createdTxid: sharedTxid,
      createdVout: 0,
      createdAddress: "ext-dst",
      createdAmount: 100,
      blockTime: 1000,
    })) as unknown as Record<string, unknown>[];

    const controller = new AbortController();
    const promise = computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      controller.signal,
      NO_CAP,
    );
    setTimeout(() => controller.abort(), 0);

    expectAbortError(await rejectionOf(promise));
  });
});

// ---------------------------------------------------------------------------
// Strategy 2: data-triggered abort (steps 4b, 5b)
// ---------------------------------------------------------------------------

describe("computeOneHop mid-scan cancellation (txid-group fallback scans)", () => {
  it("step 4b: aborts within the wide incoming participant-fallback scan", async () => {
    // 6000 distinct incoming txids => 6000 groups for step 4b to walk. Each tx
    // has an output on our address and an external input. The external input's
    // `amount` is a getter that flips the signal — and `amount` is read ONLY
    // inside step 4b's body, so the flag is set mid-loop and step 4b's scanYield
    // observes it.
    const signal = { aborted: false } as { aborted: boolean };
    const parts: Record<string, unknown>[] = [];
    for (let i = 0; i < WIDE_GETTER; i++) {
      const txid = `in-tx-${i}`;
      parts.push({ txid, role: "output", address: GROUP_ADDR, amount: 100, vout: 0 });
      parts.push({
        txid,
        role: "input",
        address: `ext-in-${i}`,
        vout: 1,
        get amount() {
          signal.aborted = true;
          return 100;
        },
      });
    }
    db.transactionParticipants.rows = parts;

    const promise = computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      signal as unknown as AbortSignal,
      NO_CAP,
    );

    expectAbortError(await rejectionOf(promise));
  });

  it("step 5b: aborts within the wide outgoing participant-fallback scan", async () => {
    // 6000 distinct outgoing txids => 6000 groups for step 5b. Each tx spends
    // from our address (input) to an external output whose `amount` getter flips
    // the signal; `amount` is read only inside step 5b's body.
    const signal = { aborted: false } as { aborted: boolean };
    const parts: Record<string, unknown>[] = [];
    for (let i = 0; i < WIDE_GETTER; i++) {
      const txid = `out-tx-${i}`;
      parts.push({ txid, role: "input", address: GROUP_ADDR, amount: 100, vout: 0 });
      parts.push({
        txid,
        role: "output",
        address: `ext-out-${i}`,
        vout: 1,
        get amount() {
          signal.aborted = true;
          return 100;
        },
      });
    }
    db.transactionParticipants.rows = parts;

    const promise = computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      signal as unknown as AbortSignal,
      NO_CAP,
    );

    expectAbortError(await rejectionOf(promise));
  });
});

// Keep the type imports referenced so the file documents the row shapes it mocks.
export type _Shapes = TransactionParticipant | UtxoLineage;
