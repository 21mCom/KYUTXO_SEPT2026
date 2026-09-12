import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { ProtectedStoreClient, MESSAGE_TYPES } = requireCjs("./protected-store.cjs");

const ROW_COUNT = 1_000_000;
const BATCH_SIZE = 5_000;
const INGEST_BUDGET_MS = 8 * 60_000;
const MATERIALIZATION_BUDGET_MS = 3 * 60_000;
const CACHED_PAGE_BUDGET_MS = 10_000;
const RSS_BUDGET_BYTES = 3_500 * 1024 * 1024 * 1024;
const PAYLOAD_BUDGET_BYTES = 128 * 1024;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function deadline<T>(work: Promise<T>, ms: number, phase: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${phase} exceeded ${ms}ms budget`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

const describeProtectedMillion = process.env.KYUTXO_OWNER_BOOK_PROTECTED_MILLION === "1"
  ? describe
  : describe.skip;

describeProtectedMillion("protected owner-book million-row release gate", () => {
  it("keeps encrypted ingestion, materialization, and IPC paging bounded", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-protected-million-"));
    roots.push(root);
    const client = new ProtectedStoreClient({ dataDir: root });
    const call = (collection: string, operation: string, payload: object = {}) =>
      client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: collection === "blockchainTransactions" || collection === "transactionParticipants"
          ? "transactions" : "records",
        collection,
        operation,
        ...payload,
      });
    let peakRss = process.memoryUsage().rss;
    const memorySample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 100);
    memorySample.unref();

    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "protected million row release gate" });
      await call("owners", "save", { row: { id: 1, name: "Scale owner", createdAt: 1 } });
      await call("records", "save", { row: {
        id: 1, type: "address", inputString: "scale-owned", label: "", tags: [], categories: [],
        owner: "Scale owner", addressImportance: "manual",
      } });

      const ingestStarted = performance.now();
      await deadline((async () => {
        for (let offset = 0; offset < ROW_COUNT; offset += BATCH_SIZE) {
          const size = Math.min(BATCH_SIZE, ROW_COUNT - offset);
          await call("blockchainTransactions", "saveBatch", {
            rows: Array.from({ length: size }, (_, j) => {
              const i = offset + j;
              return {
                id: i + 1, txid: `protected-scale-${i}`, blockHeight: i + 1,
                blockTime: 1_700_000_000 + i, fee: 0, feeRate: 0, syncedAt: 1,
              };
            }),
          });
          await call("transactionParticipants", "saveBatch", {
            rows: Array.from({ length: size }, (_, j) => {
              const i = offset + j;
              return {
                id: i + 1, txid: `protected-scale-${i}`, role: "output",
                address: "scale-owned", amount: 1, vout: 0,
              };
            }),
          });
        }
      })(), INGEST_BUDGET_MS, "encrypted ingest");
      const ingestMs = performance.now() - ingestStarted;

      const materializeStarted = performance.now();
      const first = await deadline(
        call("records", "ownerCostBasisPage", { options: { limit: 25 } }),
        MATERIALIZATION_BUDGET_MS,
        "first materialization",
      );
      const materializeMs = performance.now() - materializeStarted;

      const cachedStarted = performance.now();
      const cached = await deadline(
        call("records", "ownerCostBasisPage", {
          options: { limit: 25, expectedCheckpointKey: first.checkpointKey },
        }),
        CACHED_PAGE_BUDGET_MS,
        "cached page",
      );
      const cachedMs = performance.now() - cachedStarted;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      const payloadBytes = Buffer.byteLength(JSON.stringify(first));

      expect(first.openBatchesTotal).toBe(ROW_COUNT);
      expect(first.openBatches).toHaveLength(25);
      expect(first.byOwner.length).toBeLessThanOrEqual(25);
      expect(first.disposals.length).toBeLessThanOrEqual(25);
      expect(JSON.stringify(first)).not.toContain('"allocations"');
      expect(cached).toEqual(first);
      expect(payloadBytes).toBeLessThanOrEqual(PAYLOAD_BUDGET_BYTES);
      expect(cachedMs).toBeLessThanOrEqual(CACHED_PAGE_BUDGET_MS);
      expect(cachedMs).toBeLessThan(materializeMs * 0.25);
      expect(peakRss).toBeLessThanOrEqual(RSS_BUDGET_BYTES);

      console.log(JSON.stringify({
        gate: "protected-owner-book-million",
        rows: ROW_COUNT,
        ingestMs: Math.round(ingestMs),
        materializeMs: Math.round(materializeMs),
        cachedMs: Math.round(cachedMs),
        payloadBytes,
        peakRssBytes: peakRss,
        budgets: {
          ingestMs: INGEST_BUDGET_MS,
          materializeMs: MATERIALIZATION_BUDGET_MS,
          cachedPageMs: CACHED_PAGE_BUDGET_MS,
          payloadBytes: PAYLOAD_BUDGET_BYTES,
          rssBytes: RSS_BUDGET_BYTES,
        },
      }));
    } finally {
      clearInterval(memorySample);
      await client.close();
    }
  }, 12 * 60_000);
});