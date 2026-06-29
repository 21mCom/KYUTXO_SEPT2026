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

  it("omits the understated-spent-totals warning when unresolvedInputAmountCount is 0", () => {
    const csv = buildAnnualActivityCsv(SAMPLE, ["bc1qaddr1"], GENERATED_AT);
    expect(csv).not.toContain("Spent totals may be understated");
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
    };
    const csv = buildAnnualActivityCsv(empty, [], GENERATED_AT);
    expect(csv).toContain("No synced transaction data for any of the provided addresses.");
    expect(csv).toContain("No counterparties.");
  });
});
