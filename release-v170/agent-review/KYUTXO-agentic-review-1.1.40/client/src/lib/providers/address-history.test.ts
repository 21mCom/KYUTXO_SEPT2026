import { describe, it, expect } from "vitest";
import { computeHistoryFromTxs } from "./address-history";
import type { ApiTransaction } from "./types";

const ADDR = "bc1qaddressunderinspection0000000000000000";
const OTHER = "bc1qotherparty00000000000000000000000000000";

function tx(partial: {
  txid: string;
  confirmed: boolean;
  blockTime?: number;
  vin?: Array<{ txid: string; vout: number; address?: string; value?: number }>;
  vout?: Array<{ address?: string; value: number; n: number }>;
}): ApiTransaction {
  return {
    txid: partial.txid,
    version: 2,
    locktime: 0,
    status: {
      confirmed: partial.confirmed,
      block_height: partial.confirmed ? 800000 : undefined,
      block_hash: partial.confirmed ? "hash" : undefined,
      block_time: partial.blockTime,
    },
    fee: 0,
    size: 200,
    weight: 800,
    vin: (partial.vin ?? []).map(v => ({
      txid: v.txid,
      vout: v.vout,
      prevout:
        v.address !== undefined || v.value !== undefined
          ? { scriptpubkey_address: v.address, value: v.value ?? 0 }
          : undefined,
    })),
    vout: (partial.vout ?? []).map(o => ({
      scriptpubkey_address: o.address,
      value: o.value,
      n: o.n,
    })),
  } as ApiTransaction;
}

describe("computeHistoryFromTxs", () => {
  it("detects spends via outpoint matching even when inputs lack prevout addresses", () => {
    // Funding tx: pays 100_000 to ADDR at output 0 (block_time earliest).
    const funding = tx({
      txid: "aaaa",
      confirmed: true,
      blockTime: 1000,
      vout: [
        { address: ADDR, value: 100_000, n: 0 },
        { address: OTHER, value: 50_000, n: 1 },
      ],
    });
    // Spending tx: spends ADDR's outpoint aaaa:0 — but the input carries NO
    // prevout address (the Electrum verbose-tx case). Old address-matching → 0 sent.
    const spending = tx({
      txid: "bbbb",
      confirmed: true,
      blockTime: 2000,
      vin: [{ txid: "aaaa", vout: 0 }],
      vout: [{ address: OTHER, value: 90_000, n: 0 }],
    });

    const result = computeHistoryFromTxs(ADDR, [funding, spending]);

    expect(result.receivedSats).toBe(100_000);
    expect(result.sentSats).toBe(100_000);
    expect(result.firstSeenTime).toBe(1000);
    expect(result.lastSeenTime).toBe(2000);
  });

  it("does not count inputs that spend other addresses' outpoints", () => {
    const funding = tx({
      txid: "aaaa",
      confirmed: true,
      blockTime: 1000,
      vout: [{ address: ADDR, value: 100_000, n: 0 }],
    });
    // Spends an outpoint (cccc:0) that never paid ADDR — must not count as sent.
    const unrelated = tx({
      txid: "bbbb",
      confirmed: true,
      blockTime: 2000,
      vin: [{ txid: "cccc", vout: 0 }],
      vout: [{ address: OTHER, value: 10_000, n: 0 }],
    });

    const result = computeHistoryFromTxs(ADDR, [funding, unrelated]);

    expect(result.receivedSats).toBe(100_000);
    expect(result.sentSats).toBe(0);
  });

  it("ignores unconfirmed transactions for lifetime totals and dates", () => {
    const confirmed = tx({
      txid: "aaaa",
      confirmed: true,
      blockTime: 1000,
      vout: [{ address: ADDR, value: 100_000, n: 0 }],
    });
    const mempool = tx({
      txid: "bbbb",
      confirmed: false,
      vout: [{ address: ADDR, value: 25_000, n: 0 }],
    });

    const result = computeHistoryFromTxs(ADDR, [confirmed, mempool]);

    expect(result.receivedSats).toBe(100_000);
    expect(result.sentSats).toBe(0);
    expect(result.firstSeenTime).toBe(1000);
    expect(result.lastSeenTime).toBe(1000);
  });

  it("returns zero totals and undefined dates for an address with no activity", () => {
    const result = computeHistoryFromTxs(ADDR, []);
    expect(result.receivedSats).toBe(0);
    expect(result.sentSats).toBe(0);
    expect(result.firstSeenTime).toBeUndefined();
    expect(result.lastSeenTime).toBeUndefined();
  });

  it("aggregates multiple receives and partial spends", () => {
    const fund1 = tx({
      txid: "aaaa",
      confirmed: true,
      blockTime: 1000,
      vout: [{ address: ADDR, value: 100_000, n: 0 }],
    });
    const fund2 = tx({
      txid: "bbbb",
      confirmed: true,
      blockTime: 1500,
      vout: [{ address: ADDR, value: 40_000, n: 2 }],
    });
    // Spend only the first outpoint (aaaa:0); bbbb:2 remains unspent.
    const spend = tx({
      txid: "cccc",
      confirmed: true,
      blockTime: 3000,
      vin: [{ txid: "aaaa", vout: 0 }],
      vout: [{ address: OTHER, value: 95_000, n: 0 }],
    });

    const result = computeHistoryFromTxs(ADDR, [fund1, fund2, spend]);

    expect(result.receivedSats).toBe(140_000);
    expect(result.sentSats).toBe(100_000);
    expect(result.firstSeenTime).toBe(1000);
    expect(result.lastSeenTime).toBe(3000);
  });
});
