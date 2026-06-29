import { describe, it, expect } from "vitest";

import {
  type DatedFundingTxid,
  type FundingSource,
  type SourceOfFundsData,
  buildSourceOfFundsText,
  selectFundingTxidsUnderCap,
  sourceOfFundsCapWarning,
  sourceOfFundsFilename,
  sourceOfFundsUnresolvedWarning,
} from "./source-of-funds-export";

function fundingSource(overrides: Partial<FundingSource> = {}): FundingSource {
  return {
    txid: "aaaabbbbcccc",
    date: "2025-01-15",
    blockHeight: 800000,
    amountSats: 100_000_000,
    fromAddress: "bc1qsourceaddress",
    fromLabel: "Exchange",
    isInternalTransfer: false,
    ...overrides,
  };
}

function reportData(overrides: Partial<SourceOfFundsData> = {}): SourceOfFundsData {
  return {
    address: "bc1qtargetaddress",
    label: "My Savings",
    owner: "Alice",
    walletName: "Cold Wallet",
    currentBalanceSats: 100_000_000,
    totalReceivedSats: 100_000_000,
    fundingSources: [fundingSource()],
    internalTransferCount: 0,
    externalFundingCount: 1,
    cap: { capped: false, shownTxCount: 1, totalTxCount: 1 },
    unresolvedAmountCount: 0,
    ...overrides,
  };
}

describe("sourceOfFundsCapWarning", () => {
  it("returns null when nothing was capped", () => {
    expect(
      sourceOfFundsCapWarning({ capped: false, shownTxCount: 5, totalTxCount: 5 }),
    ).toBeNull();
  });

  it("describes how much is missing with shown/total counts when capped", () => {
    const warning = sourceOfFundsCapWarning({
      capped: true,
      shownTxCount: 2000,
      totalTxCount: 12345,
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain("incomplete");
    expect(warning).toContain("2,000");
    expect(warning).toContain("12,345");
  });

  it("explains the oldest+newest retention strategy when both halves are kept", () => {
    const warning = sourceOfFundsCapWarning({
      capped: true,
      shownTxCount: 2000,
      totalTxCount: 12345,
    });
    expect(warning).toContain("oldest and newest funding events were retained");
    expect(warning).toContain("intermediate funding was omitted");
    // The retention strategy must name both ends of the funding history.
    expect(warning).toContain("oldest");
    expect(warning).toContain("newest");
  });

  it("only promises the oldest funding when the cap is too small to keep the newest half", () => {
    const warning = sourceOfFundsCapWarning({
      capped: true,
      shownTxCount: 1,
      totalTxCount: 500,
    });
    expect(warning).toContain("oldest funding events were retained");
    expect(warning).toContain("later funding was");
    // Must not claim recent activity was kept when only the oldest was retained.
    expect(warning).not.toContain("newest");
    expect(warning).not.toContain("intermediate");
  });
});

describe("sourceOfFundsUnresolvedWarning", () => {
  it("returns null when no amounts were unresolved", () => {
    expect(sourceOfFundsUnresolvedWarning(0)).toBeNull();
  });

  it("warns that received totals may be understated with the count", () => {
    const warning = sourceOfFundsUnresolvedWarning(3);
    expect(warning).not.toBeNull();
    expect(warning).toContain("understate");
    expect(warning).toContain("3");
    expect(warning).toContain("never synced");
  });

  it("uses singular wording for exactly one unresolved amount", () => {
    const warning = sourceOfFundsUnresolvedWarning(1);
    expect(warning).toContain("funding amount could not be resolved");
  });
});

describe("buildSourceOfFundsText", () => {
  it("omits any incompleteness warning when the report was not capped", () => {
    const text = buildSourceOfFundsText(reportData(), "USD");
    expect(text).not.toContain("WARNING");
    expect(text).not.toContain("incomplete");
    expect(text).not.toContain("truncated");
    // Sanity: still contains the core declaration content.
    expect(text).toContain("SOURCE OF FUNDS DECLARATION");
    expect(text).toContain("bc1qtargetaddress");
  });

  it("surfaces a partial-results warning with counts when the report was capped", () => {
    const text = buildSourceOfFundsText(
      reportData({
        cap: { capped: true, shownTxCount: 2000, totalTxCount: 9999 },
      }),
      "USD",
    );
    expect(text).toContain("WARNING");
    expect(text).toContain("incomplete");
    expect(text).toContain("2,000");
    expect(text).toContain("9,999");
    // The summary also records the truncation with counts.
    expect(text).toContain("Funding Transactions Shown: 2,000 of 9,999 (truncated)");
  });

  it("omits the unresolved-amount warning when every amount resolved", () => {
    const text = buildSourceOfFundsText(
      reportData({ unresolvedAmountCount: 0 }),
      "USD",
    );
    expect(text).not.toContain("understate");
    expect(text).not.toContain("Unresolved Amounts");
  });

  it("surfaces an unresolved-amount warning with the count when some amounts are unresolved", () => {
    const text = buildSourceOfFundsText(
      reportData({ unresolvedAmountCount: 4 }),
      "USD",
    );
    expect(text).toContain("WARNING");
    expect(text).toContain("understate");
    expect(text).toContain("never synced");
    // The summary also records the unresolved count.
    expect(text).toContain(
      "Unresolved Amounts: 4 (received totals may be understated)",
    );
  });
});

describe("selectFundingTxidsUnderCap", () => {
  function dated(txid: string, blockHeight: number): DatedFundingTxid {
    return { txid, blockHeight };
  }

  it("returns every txid (oldest-first) when the input fits within the cap", () => {
    const entries = [
      dated("c", 800_300),
      dated("a", 800_100),
      dated("b", 800_200),
    ];
    expect(selectFundingTxidsUnderCap(entries, 10)).toEqual(["a", "b", "c"]);
  });

  it("keeps a documented split of the oldest and newest funding when capped", () => {
    // 10 transactions, oldest (h0) .. newest (h9), cap of 4.
    const entries = Array.from({ length: 10 }, (_, i) =>
      dated(`tx${i}`, 800_000 + i),
    );
    const kept = selectFundingTxidsUnderCap(entries, 4);
    // ceil(4/2)=2 oldest + floor(4/2)=2 newest, never the arbitrary middle.
    expect(kept).toEqual(["tx0", "tx1", "tx8", "tx9"]);
  });

  it("never silently drops the earliest funding source", () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      dated(`tx${i}`, 900_000 - i), // shuffled heights: tx0 is newest, tx49 oldest
    );
    const kept = selectFundingTxidsUnderCap(entries, 6);
    // tx49 is the oldest by block height and must be retained.
    expect(kept).toContain("tx49");
    // tx0 is the newest and must also be retained.
    expect(kept).toContain("tx0");
    expect(kept).toHaveLength(6);
  });

  it("orders deterministically by block height, tie-broken by txid", () => {
    const entries = [
      dated("zzz", 800_000),
      dated("aaa", 800_000),
      dated("mmm", 800_000),
    ];
    expect(selectFundingTxidsUnderCap(entries, 10)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("returns an empty list for a non-positive cap", () => {
    expect(selectFundingTxidsUnderCap([dated("a", 1)], 0)).toEqual([]);
  });

  it("keeps the single oldest when the cap is one", () => {
    const entries = [dated("new", 800_500), dated("old", 800_001)];
    expect(selectFundingTxidsUnderCap(entries, 1)).toEqual(["old"]);
  });
});

describe("sourceOfFundsFilename", () => {
  it("builds a dated filename from the address prefix", () => {
    const name = sourceOfFundsFilename(
      "bc1qtargetaddress",
      new Date("2025-06-27T12:00:00Z"),
    );
    expect(name).toBe("source-of-funds-bc1qtarget-2025-06-27.txt");
  });
});
