import { describe, it, expect } from "vitest";
import { buildAnnualActivityCsv, type ReportData } from "../AnnualActivityReport";

const GENERATED_AT = new Date("2026-06-27T12:00:00.000Z");

const SAMPLE: ReportData = {
  combinedYearRows: [
    { year: 2023, txCount: 2, receivedSats: 150_000_000, spentSats: 50_000_000 },
    { year: 2024, txCount: 1, receivedSats: 0, spentSats: 100_000_000 },
  ],
  perAddress: [
    {
      address: "bc1qaddr1",
      hasData: true,
      yearRows: [
        { year: 2023, txCount: 2, receivedSats: 150_000_000, spentSats: 50_000_000 },
      ],
    },
    {
      address: "bc1qaddr2",
      hasData: false,
      yearRows: [],
    },
  ],
  receivedFrom: [
    { address: "bc1qsender", txCount: 3 },
    { address: "bc1qsender2", txCount: 1 },
  ],
  sentTo: [{ address: "bc1qreceiver", txCount: 2 }],
  unresolvedReceivedFromCount: 4,
  unresolvedSentToCount: 0,
  noDataAddresses: ["bc1qaddr2"],
  unresolvedInputAmountCount: 0,
  unresolvedInputs: [],
};

describe("buildAnnualActivityCsv", () => {
  it("includes the generation date in ISO form", () => {
    const csv = buildAnnualActivityCsv(SAMPLE, ["bc1qaddr1", "bc1qaddr2"], GENERATED_AT);
    expect(csv).toContain("Generated,2026-06-27T12:00:00.000Z");
    expect(csv).toContain("Addresses analyzed,2");
    expect(csv).toContain("Addresses with data,1");
  });

  it("renders the combined annual table with an All Time totals row", () => {
    const csv = buildAnnualActivityCsv(SAMPLE, ["bc1qaddr1"], GENERATED_AT);
    expect(csv).toContain("Combined Annual Activity");
    expect(csv).toContain("Year,Transactions,BTC Received,BTC Spent");
    expect(csv).toContain("2023,2,1.50000000,0.50000000");
    expect(csv).toContain("2024,1,0.00000000,1.00000000");
    // All Time = 3 tx, 1.5 received, 1.5 spent
    expect(csv).toContain("All Time,3,1.50000000,1.50000000");
  });

  it("renders per-address rows and marks no-data addresses", () => {
    const csv = buildAnnualActivityCsv(SAMPLE, ["bc1qaddr1", "bc1qaddr2"], GENERATED_AT);
    expect(csv).toContain("Per-Address Breakdown");
    expect(csv).toContain("bc1qaddr1,2023,2,1.50000000,0.50000000");
    expect(csv).toContain("bc1qaddr1,All Time,2,1.50000000,0.50000000");
    expect(csv).toContain("bc1qaddr2,No data,0,0.00000000,0.00000000");
  });

  it("includes the full unfiltered counterparty lists with counts", () => {
    const csv = buildAnnualActivityCsv(SAMPLE, ["bc1qaddr1"], GENERATED_AT);
    expect(csv).toContain("Received From (counterparties)");
    expect(csv).toContain("bc1qsender,3");
    expect(csv).toContain("bc1qsender2,1");
    expect(csv).toContain("Sent To (counterparties)");
    expect(csv).toContain("bc1qreceiver,2");
  });

  it("notes unresolved counterparty transactions when present", () => {
    const csv = buildAnnualActivityCsv(SAMPLE, ["bc1qaddr1"], GENERATED_AT);
    expect(csv).toContain("4 transaction(s) had input sources that could not be resolved");
  });

  it("warns about understated spent totals when unresolvedInputAmountCount > 0", () => {
    const withUnresolved: ReportData = { ...SAMPLE, unresolvedInputAmountCount: 3 };
    const csv = buildAnnualActivityCsv(withUnresolved, ["bc1qaddr1"], GENERATED_AT);
    expect(csv).toContain(
      "Warning: 3 input amount(s) could not be resolved because the funding transaction(s) were never synced. Spent totals may be understated.",
    );
  });

  it("keeps dotted address/label values literal and unquoted in the CSV", () => {
    // Dots are not CSV-special (only quotes, commas, and newlines trigger
    // csvEscape quoting), so dotted user text must pass through verbatim —
    // including trailing dots — without gaining wrapping quotes.
    const dotted: ReportData = {
      ...SAMPLE,
      receivedFrom: [{ address: "wallet.v1.2.sender", txCount: 3 }],
      sentTo: [{ address: "Alice.", txCount: 2 }],
    };
    const csv = buildAnnualActivityCsv(dotted, ["bc1qaddr1"], GENERATED_AT);
    expect(csv).toContain("wallet.v1.2.sender,3");
    expect(csv).not.toContain('"wallet.v1.2.sender"');
    expect(csv).toContain("Alice.,2");
    expect(csv).not.toContain('"Alice."');
  });

  it("still quotes a dotted value when it also contains a comma", () => {
    const dotted: ReportData = {
      ...SAMPLE,
      receivedFrom: [{ address: "v1.2, beta", txCount: 1 }],
    };
    const csv = buildAnnualActivityCsv(dotted, ["bc1qaddr1"], GENERATED_AT);
    // The comma forces quoting; the dots inside remain literal.
    expect(csv).toContain('"v1.2, beta",1');
  });

  it("omits the understated-spent-totals warning when unresolvedInputAmountCount is 0", () => {
    const csv = buildAnnualActivityCsv(SAMPLE, ["bc1qaddr1"], GENERATED_AT);
    expect(csv).not.toContain("Spent totals may be understated");
  });

  it("lists the unresolved inputs when includeUnresolvedInputs is true", () => {
    const withUnresolved: ReportData = {
      ...SAMPLE,
      unresolvedInputAmountCount: 2,
      unresolvedInputs: [
        { spendingTxid: "spendA", prevTxid: "fundA", prevVout: 0, address: "bc1qowner1" },
        { spendingTxid: "spendB", prevTxid: "fundB", prevVout: 3, address: "" },
      ],
    };
    const csv = buildAnnualActivityCsv(withUnresolved, ["bc1qaddr1"], GENERATED_AT, true);
    expect(csv).toContain("Unresolved Inputs (understated spends)");
    expect(csv).toContain("Spending Txid,Funding Txid,Funding Output,Owning Address");
    expect(csv).toContain("spendA,fundA,0,bc1qowner1");
    // Blank owning address falls back to a readable placeholder.
    expect(csv).toContain("spendB,fundB,3,(unknown)");
  });

  it("omits the unresolved-input list by default (includeUnresolvedInputs unset)", () => {
    const withUnresolved: ReportData = {
      ...SAMPLE,
      unresolvedInputAmountCount: 1,
      unresolvedInputs: [
        { spendingTxid: "spendA", prevTxid: "fundA", prevVout: 0, address: "bc1qowner1" },
      ],
    };
    const csv = buildAnnualActivityCsv(withUnresolved, ["bc1qaddr1"], GENERATED_AT);
    // Warning still present, but no detail table.
    expect(csv).toContain("Spent totals may be understated");
    expect(csv).not.toContain("Unresolved Inputs (understated spends)");
    expect(csv).not.toContain("spendA,fundA");
  });

  it("escapes cells that contain commas or quotes", () => {
    const tricky: ReportData = {
      ...SAMPLE,
      receivedFrom: [{ address: 'weird,"addr', txCount: 1 }],
    };
    const csv = buildAnnualActivityCsv(tricky, ["bc1qaddr1"], GENERATED_AT);
    expect(csv).toContain('"weird,""addr",1');
  });

  it("handles an empty report gracefully", () => {
    const empty: ReportData = {
      combinedYearRows: [],
      perAddress: [],
      receivedFrom: [],
      sentTo: [],
      unresolvedReceivedFromCount: 0,
      unresolvedSentToCount: 0,
      noDataAddresses: [],
      unresolvedInputAmountCount: 0,
      unresolvedInputs: [],
    };
    const csv = buildAnnualActivityCsv(empty, [], GENERATED_AT);
    expect(csv).toContain("No synced transaction data for any of the provided addresses.");
    expect(csv).toContain("No counterparties.");
  });
});
