// Scale coverage for applyPoisoningTags (Task: keep "Tag all suspects" from
// freezing when there are thousands of results).
//
// The helper used to issue one record lookup + one write per suspect; on
// thousands of unique suspects that meant thousands of sequential Dexie
// round-trips with zero yields — a frozen page and a minutes-long run. The
// fix processes addresses in bounded chunks (chunked anyOf lookups,
// bulkUpdateRecords for tag merges, bulkCreateRecords for missing records)
// with a cooperative yield between chunks.
//
// Per the fake-indexeddb scale-test guidance, responsiveness is asserted via
// the helper's cooperative shape (bounded bulk-call counts, zero-delay yields
// between chunks, monotonic progress callbacks) plus a generous wall-clock
// budget on the tagging run itself — never on seeding, which measures the
// harness.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Partial-mock record-crud with counting wrappers so we can prove the helper
// uses chunked BULK calls (never per-record lookups/writes) while still
// exercising the real Dexie write paths underneath.
const crudCalls = {
  lookups: [] as number[], // addresses per getRecordsByInputStrings call
  updates: [] as number[], // rows per bulkUpdateRecords call
  creates: [] as number[], // rows per bulkCreateRecords call
};

vi.mock("./record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./record-crud")>();
  return {
    ...actual,
    getRecordsByInputStrings: async (values: string[]) => {
      crudCalls.lookups.push(values.length);
      return actual.getRecordsByInputStrings(values);
    },
    bulkUpdateRecords: async (
      updates: Parameters<typeof actual.bulkUpdateRecords>[0],
      options?: Parameters<typeof actual.bulkUpdateRecords>[1],
    ) => {
      crudCalls.updates.push(updates.length);
      return actual.bulkUpdateRecords(updates, options);
    },
    bulkCreateRecords: async (
      records: Parameters<typeof actual.bulkCreateRecords>[0],
      options?: Parameters<typeof actual.bulkCreateRecords>[1],
    ) => {
      crudCalls.creates.push(records.length);
      return actual.bulkCreateRecords(records, options);
    },
  };
});

import { applyPoisoningTags } from "./poisoning-tagging";
import {
  bulkCreateRecords,
  clearAllRecords,
  getRecordsByInputStrings,
} from "./record-crud";

const TAG = "suspected-poisoning";
const CHUNK = 500;

// 1,000 already-fully-tagged + 1,000 existing-untagged + 3,000 without any
// vault record = 5,000 unique suspects, mirroring a 10k-vault scan's output.
const ALREADY_TAGGED = 1_000;
const EXISTING_UNTAGGED = 1_000;
const MISSING = 3_000;
const TOTAL = ALREADY_TAGGED + EXISTING_UNTAGGED + MISSING;

// Generous "seconds, not minutes" budget for the tagging run itself under
// fake-indexeddb's synchronous structured-clone harness.
const TAGGING_BUDGET_MS = 30_000;

function suspectAddr(i: number): string {
  return `bc1q${i.toString(16).padStart(8, "0")}${"z".repeat(20)}suspect`;
}
function txidFor(i: number): string {
  return i.toString(16).padStart(8, "0").repeat(8);
}

describe("applyPoisoningTags at scale", () => {
  beforeEach(async () => {
    crudCalls.lookups.length = 0;
    crudCalls.updates.length = 0;
    crudCalls.creates.length = 0;
    await clearAllRecords();
  });

  afterEach(async () => {
    await clearAllRecords();
  });

  it(
    `tags ${TOTAL} suspects via chunked bulk writes within budget, yielding between chunks`,
    async () => {
      // Seed the existing records (not measured — harness cost).
      const seedRows = [];
      for (let i = 0; i < ALREADY_TAGGED + EXISTING_UNTAGGED; i++) {
        seedRows.push({
          type: "address" as const,
          inputString: suspectAddr(i),
          label: `existing ${i}`,
          source: "manual",
          tags: i < ALREADY_TAGGED ? [TAG] : [],
          categories: [],
        });
      }
      await bulkCreateRecords(seedRows, {
        skipVocabularySync: true,
        skipNotification: true,
      });
      crudCalls.creates.length = 0; // ignore seeding

      const entries = Array.from({ length: TOTAL }, (_, i) => ({
        address: suspectAddr(i),
        discoveredInTxid: txidFor(i),
      }));

      // Count cooperative zero-delay yields issued during the run.
      const realSetTimeout = globalThis.setTimeout;
      let zeroDelayYields = 0;
      const timeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
          if (!ms) zeroDelayYields++;
          return realSetTimeout(fn, ms as number, ...(rest as []));
        }) as typeof setTimeout);

      const progress: Array<[number, number]> = [];
      const start = performance.now();
      const summary = await applyPoisoningTags(entries, [TAG], {
        chunkSize: CHUNK,
        onProgress: (done, total) => progress.push([done, total]),
      });
      const elapsed = performance.now() - start;
      timeoutSpy.mockRestore();

      // Summary is exact.
      expect(summary).toEqual({
        tagged: EXISTING_UNTAGGED,
        alreadyTagged: ALREADY_TAGGED,
        created: MISSING,
      });

      // Generous wall-clock budget: seconds, not minutes.
      expect(elapsed).toBeLessThan(TAGGING_BUDGET_MS);

      const expectedChunks = Math.ceil(TOTAL / CHUNK);

      // Chunked BULK calls only — never one lookup/write per suspect.
      expect(crudCalls.lookups.length).toBe(expectedChunks);
      expect(Math.max(...crudCalls.lookups)).toBeLessThanOrEqual(CHUNK);
      expect(crudCalls.updates.length).toBeLessThanOrEqual(expectedChunks);
      expect(crudCalls.creates.length).toBeLessThanOrEqual(expectedChunks);
      const totalUpdated = crudCalls.updates.reduce((a, b) => a + b, 0);
      const totalCreated = crudCalls.creates.reduce((a, b) => a + b, 0);
      expect(totalUpdated).toBe(EXISTING_UNTAGGED);
      expect(totalCreated).toBe(MISSING);
      for (const n of [...crudCalls.updates, ...crudCalls.creates]) {
        expect(n).toBeLessThanOrEqual(CHUNK);
      }

      // Cooperative yields between chunks keep the main thread breathing.
      expect(zeroDelayYields).toBeGreaterThanOrEqual(expectedChunks - 1);

      // Progress is monotonic, per-chunk, and ends complete.
      expect(progress.length).toBe(expectedChunks);
      expect(progress[progress.length - 1]).toEqual([TOTAL, TOTAL]);
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i][0]).toBeGreaterThan(progress[i - 1][0]);
      }

      // Spot-check the writes actually landed.
      const check = await getRecordsByInputStrings([
        suspectAddr(0), // already tagged — untouched
        suspectAddr(ALREADY_TAGGED), // existing untagged — merged
        suspectAddr(ALREADY_TAGGED + EXISTING_UNTAGGED), // created
      ]);
      expect(check).toHaveLength(3);
      for (const rec of check) {
        expect(rec.tags).toContain(TAG);
      }
      const createdRec = check.find(
        (r) => r.inputString === suspectAddr(ALREADY_TAGGED + EXISTING_UNTAGGED),
      );
      expect(createdRec?.addressImportance).toBe("blockchain-discovered");
      expect(createdRec?.source).toBe("address-poisoning-scan");
      expect(createdRec?.discoveredInTxid).toBe(
        txidFor(ALREADY_TAGGED + EXISTING_UNTAGGED),
      );
    },
    120_000,
  );

  it("dedupes duplicate entries so a suspect is only written once", async () => {
    const addr = suspectAddr(999_999);
    const entries = [
      { address: addr, discoveredInTxid: txidFor(1) },
      { address: addr, discoveredInTxid: txidFor(2) },
      { address: addr.toUpperCase().replace("BC1Q", "bc1q"), discoveredInTxid: txidFor(3) },
    ];
    const summary = await applyPoisoningTags(entries, [TAG]);
    expect(summary.created).toBe(1);
    expect(summary.tagged).toBe(0);

    const recs = await getRecordsByInputStrings([addr]);
    expect(recs).toHaveLength(1);
    // First discoveredInTxid seen wins.
    expect(recs[0].discoveredInTxid).toBe(txidFor(1));
  });

  it("union-merges tags without dropping existing ones", async () => {
    const addr = suspectAddr(888_888);
    await bulkCreateRecords(
      [
        {
          type: "address",
          inputString: addr,
          label: "keep my tags",
          source: "manual",
          tags: ["pre-existing"],
          categories: [],
        },
      ],
      { skipVocabularySync: true, skipNotification: true },
    );
    const summary = await applyPoisoningTags([{ address: addr }], [TAG]);
    expect(summary.tagged).toBe(1);
    const [rec] = await getRecordsByInputStrings([addr]);
    expect(rec.tags).toEqual(expect.arrayContaining(["pre-existing", TAG]));
  });
});
