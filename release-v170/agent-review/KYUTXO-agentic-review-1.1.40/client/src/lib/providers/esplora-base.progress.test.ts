import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EsploraProvider } from "./esplora-base";
import type { ApiTransaction } from "./types";

const ADDR = "bc1qaddressunderinspection0000000000000000";

// Concrete subclass so we can instantiate the abstract base. The rate-limit
// delay is zeroed so the paged history walk doesn't sleep between fetches.
class TestEsploraProvider extends EsploraProvider {
  name = "TestEsplora";
  constructor() {
    super("https://example.test");
    this.rateLimitDelay = 0;
  }
}

function makeTx(txid: string, blockTime: number): ApiTransaction {
  return {
    txid,
    version: 2,
    locktime: 0,
    status: { confirmed: true, block_height: 800000, block_time: blockTime },
    fee: 0,
    size: 200,
    weight: 800,
    vin: [],
    vout: [],
  } as ApiTransaction;
}

// Build a page of `count` confirmed txs. Each tx gets a unique txid (so the
// walk's `lastTxid` cursor advances) and an incrementing block_time so we can
// also verify first/last-seen dates reflect every page that was walked.
function makePage(pageIndex: number, count: number): ApiTransaction[] {
  return Array.from({ length: count }, (_, i) =>
    makeTx(`tx-${pageIndex}-${i}`, 1000 + pageIndex * 100 + i),
  );
}

describe("EsploraProvider.getAddressHistoryDates onProgress per page", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function queuePages(pages: ApiTransaction[][]) {
    // The walk fetches sequentially; return each queued page in order
    // regardless of URL (which encodes the cursor txid).
    let call = 0;
    fetchMock.mockImplementation(async () => {
      const page = pages[call] ?? [];
      call += 1;
      return new Response(JSON.stringify(page), { status: 200 });
    });
  }

  it("emits cumulative scanned count after each fetched page, not just at the end", async () => {
    // Two full pages (25 each) then an empty page terminates the walk.
    queuePages([makePage(0, 25), makePage(1, 25), []]);

    const provider = new TestEsploraProvider();
    const onProgress = vi.fn();

    await provider.getAddressHistoryDates(ADDR, onProgress);

    // Fired once per non-empty page with the running total — 25, then 50 —
    // proving progress advances per page instead of a single end-of-walk emit.
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 25);
    expect(onProgress).toHaveBeenNthCalledWith(2, 50);
  });

  it("final scanned count matches the total number of transactions walked", async () => {
    // 25 + 25 + 10 = 60 confirmed txs across three pages; the 10-tx page
    // (< 25) terminates the walk.
    const pages = [makePage(0, 25), makePage(1, 25), makePage(2, 10)];
    queuePages(pages);
    const totalWalked = pages.reduce((sum, p) => sum + p.length, 0);

    const provider = new TestEsploraProvider();
    const onProgress = vi.fn();

    const result = await provider.getAddressHistoryDates(ADDR, onProgress);

    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([25, 50, 60]);
    const lastCount = onProgress.mock.calls.at(-1)![0];
    expect(lastCount).toBe(totalWalked);

    // Dates reflect every page that was walked (earliest = first tx of page 0,
    // latest = last tx of the final page), confirming the full history walk ran.
    expect(result.firstSeenTime).toBe(1000);
    expect(result.lastSeenTime).toBe(1000 + 2 * 100 + 9);
  });

  it("aborting the signal mid-walk stops further page fetches", async () => {
    // Endless full pages — without cancellation the walk would never end.
    let call = 0;
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      const page = makePage(call, 25);
      call += 1;
      return new Response(JSON.stringify(page), { status: 200 });
    });

    const provider = new TestEsploraProvider();
    const onProgress = vi.fn((scanned: number) => {
      // Cancel after the second page has been reported.
      if (scanned >= 50) controller.abort();
    });

    await expect(
      provider.getAddressHistoryDates(ADDR, onProgress, controller.signal),
    ).rejects.toThrow(/cancelled/i);

    // Exactly two pages were fetched; the between-pages guard stopped the
    // walk before a third request went out.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an already-aborted signal prevents any fetch", async () => {
    queuePages([makePage(0, 25)]);
    const controller = new AbortController();
    controller.abort();

    const provider = new TestEsploraProvider();
    await expect(
      provider.getAddressHistoryDates(ADDR, undefined, controller.signal),
    ).rejects.toThrow(/cancelled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
