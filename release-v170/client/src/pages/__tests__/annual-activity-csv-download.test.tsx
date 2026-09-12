// @vitest-environment jsdom
//
// Page-level coverage for the "Export CSV" download wiring in
// AnnualActivityReport.tsx. The pure CSV serialiser (buildAnnualActivityCsv) is
// content-tested in annual-activity-csv-export.test.ts; this file guards the
// glue that the unit tests never exercise: the exportCsv() click handler that
// turns the in-memory report into a Blob, drives an object-URL anchor download
// with a dated filename, and revokes the URL afterwards.
//
// We render the real AnnualActivityReport, mock its data-fetching seams so a
// small but genuine report generates, then click the button. The serialiser is
// left REAL so the produced Blob carries the actual production content.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const { TX1, ADDR, BLOCK_TIME_2023, OUTPUT_PARTICIPANT } = vi.hoisted(() => {
  const TX1 = "a".repeat(64);
  const ADDR = "bc1qaddr1";
  // A 2023 confirmed block time so the report yields a single 2023 year row.
  const BLOCK_TIME_2023 = Math.floor(
    new Date("2023-06-15T00:00:00.000Z").getTime() / 1000,
  );
  // One output of 1.5 BTC to the pasted address — enough for a non-empty report.
  const OUTPUT_PARTICIPANT = {
    id: 1,
    txid: TX1,
    role: "output" as const,
    vout: 0,
    address: ADDR,
    amount: 150_000_000,
  };
  return { TX1, ADDR, BLOCK_TIME_2023, OUTPUT_PARTICIPANT };
});

// Data seams. getParticipantsByAddresses returns our single output; the prevout
// lookup returns nothing (no spends), so the report is purely a 1.5 BTC receive.
vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddresses: vi.fn(() => Promise.resolve([OUTPUT_PARTICIPANT])),
  getParticipantsByTxids: vi.fn(() => Promise.resolve([OUTPUT_PARTICIPANT])),
  getRecordsByIndexedFieldAnyOfFiltered: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsByTxids: vi.fn(() =>
    Promise.resolve([{ txid: TX1, blockTime: BLOCK_TIME_2023 }]),
  ),
  getParticipantsByPrevOutKeys: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByType: vi.fn(() => Promise.resolve([])),
}));

// @tanstack/react-virtual (used by the counterparty lists) needs ResizeObserver,
// which jsdom lacks. The lists render empty here, but the hook still runs.
beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const AnnualActivityReport = (await import("../AnnualActivityReport")).default;
const { buildAnnualActivityCsv } = await import("../AnnualActivityReport");

// jsdom implements neither URL.createObjectURL nor anchor navigation. Capture
// the Blob and the anchor download attribute instead of attempting a real one.
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clickedDownloads: string[];
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clickedDownloads = [];
  createObjectURL = vi.fn(() => "blob:mock-url");
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownloads.push(this.download);
    });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  void clickSpy;
});

const DATED_CSV = /^kyutxo-annual-activity-\d{4}-\d{2}-\d{2}\.csv$/;

// Render the page, paste an address, generate the report, and wait for the
// Export CSV button (only shown once reportData is populated).
async function generateReport() {
  renderWithProviders(<AnnualActivityReport />);
  const addressInput = screen.getByTestId("input-annual-activity-addresses");
  fireEvent.change(addressInput, {
    target: { value: ADDR },
  });
  fireEvent.keyDown(addressInput, { key: "Enter" });
  fireEvent.click(screen.getByTestId("button-generate"));
  await screen.findByTestId("button-export-csv");
}

describe("AnnualActivityReport — Export CSV download", () => {
  it("hides the Export CSV button until a report has been generated", () => {
    renderWithProviders(<AnnualActivityReport />);
    expect(screen.queryByTestId("button-export-csv")).toBeNull();
  });

  it("produces a text/csv Blob carrying the real report content", async () => {
    await generateReport();

    fireEvent.click(screen.getByTestId("button-export-csv"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/csv;charset=utf-8");

    const text = await blob.text();
    expect(text).toContain("KYUTXO Annual Activity Report");
    expect(text).toContain("Combined Annual Activity");
    // 1.5 BTC received in 2023, nothing spent.
    expect(text).toContain("2023,1,1.50000000,0.00000000");
    expect(text).toContain("All Time,1,1.50000000,0.00000000");
    // Per-address section reflects the single pasted address.
    expect(text).toContain(`${ADDR},2023,1,1.50000000,0.00000000`);
  });

  it("downloads with a dated .csv filename and revokes the object URL", async () => {
    await generateReport();

    fireEvent.click(screen.getByTestId("button-export-csv"));

    await waitFor(() => expect(clickedDownloads).toHaveLength(1));
    expect(clickedDownloads[0]).toMatch(DATED_CSV);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("keeps the produced Blob in sync with buildAnnualActivityCsv", async () => {
    await generateReport();

    fireEvent.click(screen.getByTestId("button-export-csv"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await blob.text();

    // Reconstruct the expected CSV from the same report shape the page built
    // (1 address, one 1.5 BTC receive in 2023). The generation timestamp is the
    // only varying line, so compare everything except the "Generated," row.
    const expected = buildAnnualActivityCsv(
      {
        combinedYearRows: [
          { year: 2023, txCount: 1, receivedSats: 150_000_000, spentSats: 0 },
        ],
        perAddress: [
          {
            address: ADDR,
            hasData: true,
            yearRows: [
              { year: 2023, txCount: 1, receivedSats: 150_000_000, spentSats: 0 },
            ],
          },
        ],
        receivedFrom: [],
        sentTo: [],
        unresolvedReceivedFromCount: 0,
        unresolvedSentToCount: 0,
        noDataAddresses: [],
        unresolvedInputAmountCount: 0,
        unresolvedInputs: [],
      },
      [ADDR],
      new Date(),
    );

    const stripGenerated = (csv: string) =>
      csv
        .split("\r\n")
        .filter((line) => !line.startsWith("Generated,"))
        .join("\r\n");

    expect(stripGenerated(text)).toBe(stripGenerated(expected));
  });
});
