// @vitest-environment jsdom
//
// Regression guard for the NON-PDF date-bearing outputs of the Statement Report
// (StatementReport.tsx). Task #772 pinned only the PDF footer + the per-row Date
// column inside the generated PDF; the surfaces below were left unpinned and a
// locale/format swap, a raw epoch, or an ISO string could still regress them:
//   - the download filename `btc-statement-${today}.pdf`, where `today` is
//     `new Date().toISOString().split("T")[0]` (a yyyy-mm-dd stamp), and
//   - the on-screen table Date cell (`cell-date-${idx}`), rendered from
//     row.dateStr === formatDate(blockTime) === en-US toLocaleDateString(...).
//
// As in StatementReport.pdfDates.test.tsx we mock jspdf / jspdf-autotable and
// stub the whole data-access chain so generateReport yields exactly one row. The
// anchor's `download` attribute is captured by spying on HTMLAnchorElement click,
// and `new Date()` is frozen so the filename stamp is reproducible. Each
// assertion explicitly rejects the raw-epoch and wrong-format forms.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

const ADDR = "bc1qstatementreporttestaddress0000000000";
// 2023-11-14T22:13:20Z — fixed Unix seconds so the row date is deterministic.
const BLOCK_TIME = 1700000000;
const TXID = "tx_statement_report_0001";

// jspdf mock: output() must yield a Blob so the download path is reached.
vi.mock("jspdf", () => {
  class FakeJsPDF {
    internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
    setFontSize() {}
    setFont() {}
    setTextColor() {}
    setFillColor() {}
    setDrawColor() {}
    roundedRect() {}
    addPage() {}
    getNumberOfPages() {
      return 1;
    }
    save() {}
    output() {
      return new Blob([], { type: "application/pdf" });
    }
    text() {}
  }
  return { jsPDF: FakeJsPDF, default: FakeJsPDF };
});

vi.mock("jspdf-autotable", () => ({
  default: () => {},
}));

// Isolate the page from Dexie: stub the vocabulary hooks and the whole data
// access chain. Paste mode + BTC currency keeps the path simple.
vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [], isLoading: false }) }));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [], isLoading: false }) }));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [], isLoading: false }),
}));

const outputParticipant = {
  id: 1,
  txid: TXID,
  address: ADDR,
  role: "output",
  vout: 0,
  amount: 50000,
};

vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddresses: vi.fn(async () => [outputParticipant]),
  getParticipantsByTxids: vi.fn(async () => [outputParticipant]),
}));
vi.mock("@/lib/data/record-crud", () => ({ getRecordsByType: vi.fn(async () => []) }));
vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsByTxids: vi.fn(async () => [{ txid: TXID, blockTime: BLOCK_TIME }]),
  getParticipantsByPrevOutKeys: vi.fn(async () => []),
}));
vi.mock("@/lib/data/price-data-crud", () => ({
  getPriceDataByDateCurrencyAssetKeys: vi.fn(async () => []),
}));

const { default: StatementReport } = await import("./StatementReport");

// Poll a condition by flushing only microtasks (no timers) so it cooperates
// with fake timers when those are active.
async function waitForCondition(fn: () => boolean, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("waitForCondition: condition never became true");
}

const anchorDownloads: string[] = [];

beforeEach(() => {
  anchorDownloads.length = 0;
  if (!("createObjectURL" in URL)) {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:test";
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  // Capture the filename without triggering jsdom's "navigation not implemented".
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchorDownloads.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("StatementReport non-PDF date formatting", () => {
  it("stamps the download filename as btc-statement-<yyyy-mm-dd>.pdf", async () => {
    const screen = render(<StatementReport />);

    fireEvent.change(screen.getByTestId("input-statement-report-addresses"), {
      target: { value: ADDR },
    });
    fireEvent.keyDown(screen.getByTestId("input-statement-report-addresses"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("button-generate-report"));

    await waitForCondition(() => !!screen.queryByTestId("cell-date-0"));

    // Freeze the clock so the filename's `new Date()` is reproducible.
    const fixed = new Date("2026-06-27T15:30:45Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const expectedStamp = new Date().toISOString().split("T")[0];

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-export-pdf"));
      for (let i = 0; i < 30; i++) await Promise.resolve();
    });

    expect(anchorDownloads.length).toBe(1);
    const filename = anchorDownloads[0];

    // Exact expected form: btc-statement-2026-06-27.pdf
    expect(filename).toBe(`btc-statement-${expectedStamp}.pdf`);
    expect(filename).toMatch(/^btc-statement-\d{4}-\d{2}-\d{2}\.pdf$/);

    // Reject the regression forms: raw epoch (ms + seconds), a full ISO string
    // with the time portion, and a locale-formatted (slashed) date.
    const fixedMs = fixed.getTime();
    expect(filename).not.toContain(String(fixedMs));
    expect(filename).not.toContain(String(Math.floor(fixedMs / 1000)));
    expect(filename).not.toContain("T");
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("/");
    expect(filename).not.toContain(fixed.toLocaleDateString());
  });

  it("renders the on-screen table Date cell via en-US toLocaleDateString()", async () => {
    const screen = render(<StatementReport />);

    fireEvent.change(screen.getByTestId("input-statement-report-addresses"), {
      target: { value: ADDR },
    });
    fireEvent.keyDown(screen.getByTestId("input-statement-report-addresses"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("button-generate-report"));

    await waitForCondition(() => !!screen.queryByTestId("cell-date-0"));

    const dateCell = screen.getByTestId("cell-date-0").textContent;

    const expectedDate = new Date(BLOCK_TIME * 1000).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(dateCell).toBe(expectedDate);

    // Reject raw epoch (seconds + ms) and any ISO / yyyy-mm-dd form.
    expect(dateCell).not.toBe(String(BLOCK_TIME));
    expect(dateCell).not.toBe(String(BLOCK_TIME * 1000));
    expect(dateCell).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(dateCell).not.toContain("T");
  });
});
