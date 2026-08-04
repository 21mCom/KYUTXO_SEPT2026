// Scale coverage for the Address Poisoning scanner (Task: confirm the scan
// stays responsive on very large vaults).
//
// The lookalike phase used to compare every dust-transaction counterparty
// against every scoped address in a single synchronous O(candidates x scoped)
// loop with no yields or abort checks — on a huge vault the UI could freeze
// for the whole phase and Cancel had no effect until it finished. The fix
// pre-buckets scoped addresses by their first+last minMatch characters (a
// match requires both exact affix runs, so the bucket is a strict superset
// filter) and makes the loop yield + honour the AbortSignal periodically.
//
// Per the fake-indexeddb scale-test guidance, responsiveness is asserted via
// the scan's cooperative shape (zero-delay yield count, mid-scan cancel) plus
// a generous wall-clock budget on the scan itself — never on seeding, which
// measures the harness.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  scanAddressPoisoning,
  type ScanPhase,
} from "./address-poisoning";
import { bulkCreateRecords, clearAllRecords } from "./data/record-crud";
import { bulkAddParticipants, clearParticipants } from "./data/transaction-crud";
import type { TransactionParticipant } from "./database";

const noopProgress = () => {};

const ADDRESS_COUNT = 1_500;
const COUNTERPARTIES_PER_TX = 5; // 1 lookalike + 4 same-family strangers
// Generous budget for the scan itself (post-seed). The scan is a few Dexie
// index reads plus the bucketed matching loop; even under fake-indexeddb's
// synchronous structured-clone it finishes in a few seconds.
const SCAN_BUDGET_MS = 30_000;

// Scoped vault address i: unique hex affix on both ends, bc1q family.
function vaultAddr(i: number): string {
  const h = i.toString(16).padStart(8, "0");
  return `bc1q${h}${"m".repeat(20)}${h}`;
}
// Lookalike attacker for address i: same first 12 and last 8 characters.
function lookalikeAddr(i: number): string {
  const h = i.toString(16).padStart(8, "0");
  return `bc1q${h}${"z".repeat(20)}${h}`;
}
// Same-family stranger with a unique suffix (lands in its own bucket, never
// matches anything).
function strangerAddr(i: number, k: number): string {
  return `bc1qstranger${"s".repeat(12)}${i.toString(16).padStart(6, "0")}${k}x`;
}
function txidFor(i: number): string {
  return i.toString(16).padStart(8, "0").repeat(8);
}

async function seedScaleVault() {
  const records = Array.from({ length: ADDRESS_COUNT }, (_, i) => ({
    type: "address" as const,
    inputString: vaultAddr(i),
    label: `Scale addr ${i}`,
    source: "manual",
    tags: [] as string[],
    categories: [] as string[],
  }));
  await bulkCreateRecords(records, { skipVocabularySync: true });

  // One dust tx per vault address: dust output to the vault address plus
  // COUNTERPARTIES_PER_TX inputs (one true lookalike, the rest strangers).
  const participants: Omit<TransactionParticipant, "id">[] = [];
  for (let i = 0; i < ADDRESS_COUNT; i++) {
    const txid = txidFor(i);
    participants.push({
      txid,
      role: "output",
      address: vaultAddr(i),
      amount: 546,
      vout: 0,
    });
    participants.push({ txid, role: "input", address: lookalikeAddr(i), amount: 600 });
    for (let k = 1; k < COUNTERPARTIES_PER_TX; k++) {
      participants.push({ txid, role: "input", address: strangerAddr(i, k), amount: 700 });
    }
  }
  const CHUNK = 5_000;
  for (let s = 0; s < participants.length; s += CHUNK) {
    await bulkAddParticipants(participants.slice(s, s + CHUNK));
  }
}

describe("scanAddressPoisoning at scale", () => {
  beforeEach(async () => {
    await clearAllRecords();
    await clearParticipants();
    await seedScaleVault();
  }, 300_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearAllRecords();
    await clearParticipants();
  }, 120_000);

  it(
    "completes within budget, yields to the event loop, and finds every lookalike",
    async () => {
      // Count the scan's cooperative zero-delay yields.
      const realSetTimeout = globalThis.setTimeout;
      let zeroDelayYields = 0;
      const timeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
          if (!ms) zeroDelayYields++;
          return realSetTimeout(fn, ms as number, ...(rest as []));
        }) as typeof setTimeout);

      const started = Date.now();
      const outcome = await scanAddressPoisoning(
        "all",
        "",
        { dustThresholdSats: 1000, matchLength: 4 },
        new AbortController().signal,
        noopProgress,
      );
      const elapsed = Date.now() - started;
      timeoutSpy.mockRestore();

      expect(outcome).not.toBeNull();
      expect(elapsed).toBeLessThan(SCAN_BUDGET_MS);

      // Every scoped address was scanned; every dust tx's lookalike suspect
      // was found (strangers never match).
      expect(outcome!.scannedAddresses.size).toBe(ADDRESS_COUNT);
      const suspects = new Set(outcome!.results.map((r) => r.suspectAddress));
      for (let i = 0; i < ADDRESS_COUNT; i += 97) {
        expect(suspects.has(lookalikeAddr(i))).toBe(true);
      }
      for (const r of outcome!.results) {
        expect(r.suspectAddress).not.toMatch(/^bc1qstranger/);
      }

      // Cooperative shape: at least one yield per streamed batch of each pass
      // plus the periodic lookalike-loop yields. With 1,500 addresses (3
      // address pages, 3 participant batches, 8 txid batches) and 7,500
      // candidates (>= 3 lookalike-loop yields) the floor is well above 10.
      expect(zeroDelayYields).toBeGreaterThanOrEqual(10);
    },
    300_000,
  );

  it(
    "cancel mid-scan aborts promptly and returns null",
    async () => {
      const ctrl = new AbortController();
      const outcome = await scanAddressPoisoning(
        "all",
        "",
        { dustThresholdSats: 1000, matchLength: 4 },
        ctrl.signal,
        (_processed: number, phase: ScanPhase) => {
          // Abort as soon as the counterparty phase starts streaming — the
          // scan must stop before the lookalike matching completes.
          if (phase === "counterparties") ctrl.abort();
        },
      );
      expect(outcome).toBeNull();
    },
    300_000,
  );
});
