import { describe, it, expect } from "vitest";

import {
  type FundingSource,
  type SourceOfFundsData,
  buildSourceOfFundsText,
  sourceOfFundsCapWarning,
  sourceOfFundsFilename,
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
