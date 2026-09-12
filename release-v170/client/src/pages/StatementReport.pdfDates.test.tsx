// @vitest-environment jsdom
//
// Regression guard for the date/timestamp formatting in the Statement Report
// PDF (exportPdf in StatementReport.tsx). Two values are easy to break with a
// locale/format swap, a raw epoch, or an ISO string and neither was pinned by
// a test before:
//   - the footer stamp `Generated: ${new Date().toLocaleString()}`
//   - the per-row Date column, rendered via
//     toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }).
//
// StatementReport is a page component with no lib-level harness, so (mirroring
// the jspdf-mock pattern in lib/__tests__/lineageEngine.test.ts) we mock jspdf
// to capture every doc.text(...) call and mock jspdf-autotable to capture the
// table body. The data-fetching chain is stubbed to yield a single deterministic
// incoming transaction so generateReport produces exactly one row. `new Date()`
// is frozen with fake timers so the footer is reproducible, and each assertion
// explicitly rejects the raw-epoch and ISO-string forms.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

const ADDR = "bc1qstatementreporttestaddress0000000000";
// 2023-11-14T22:13:20Z — fixed Unix seconds so the row date is deterministic.
const BLOCK_TIME = 1700000000;
const TXID = "tx_statement_report_0001";

// jspdf mock: capture text() strings + the table body autoTable receives.
const { pdfTextCalls, autoTableBodies } = vi.hoisted(() => ({
  pdfTextCalls: [] as string[],
  autoTableBodies: [] as string[][][],
}));

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
    text(str: unknown) {
      if (typeof str === "string") pdfTextCalls.push(str);
    }
  }
  return { jsPDF: FakeJsPDF, default: FakeJsPDF };
});

vi.mock("jspdf-autotable", () => ({
  default: (_doc: unknown, options: { body?: string[][] }) => {
    if (options?.body) autoTableBodies.push(options.body);
  },
}));

// Isolate the page from Dexie: stub the vocabulary hooks and the whole data
// access chain. Paste mode + BTC currency keeps the path simple (no record-crud
// or price lookups are reached), but they're stubbed anyway for safety.
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

beforeEach(() => {
  pdfTextCalls.length = 0;
  autoTableBodies.length = 0;
  if (!("createObjectURL" in URL)) {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:test";
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("StatementReport PDF date formatting", () => {
  it("renders the footer via toLocaleString() and the row Date via en-US toLocaleDateString()", async () => {
    const screen = render(<StatementReport />);

    fireEvent.change(screen.getByTestId("input-statement-report-addresses"), {
      target: { value: ADDR },
    });
    fireEvent.keyDown(screen.getByTestId("input-statement-report-addresses"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("button-generate-report"));

    // Wait for the single statement row to render (generate phase, real timers).
    await waitForCondition(() => !!screen.queryByTestId("cell-date-0"));

    // Freeze the clock so the footer's `new Date()` is reproducible, then drive
    // the export. Compute the expected footer with the same frozen clock.
    const fixed = new Date("2026-06-27T15:30:45Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const expectedFooter = `Generated: ${new Date().toLocaleString()}`;

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-export-pdf"));
      for (let i = 0; i < 30; i++) await Promise.resolve();
    });

    // ── Footer assertions ────────────────────────────────────────────────
    const footer = pdfTextCalls.find((s) => s.startsWith("Generated:"));
    expect(footer).toBeDefined();
    expect(footer).toBe(expectedFooter);

    // Reject the regression forms: raw epoch (ms + seconds) and ISO string.
    const fixedMs = fixed.getTime();
    expect(footer).not.toContain(String(fixedMs));
    expect(footer).not.toContain(String(Math.floor(fixedMs / 1000)));
    expect(footer).not.toContain(fixed.toISOString());
    expect(footer).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // ── Row Date column assertions ───────────────────────────────────────
    expect(autoTableBodies.length).toBe(1);
    const body = autoTableBodies[0];
    expect(body.length).toBe(1);
    const dateCell = body[0][0];

    const expectedDate = new Date(BLOCK_TIME * 1000).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(dateCell).toBe(expectedDate);

    // Reject raw epoch (seconds + ms) and any ISO/yyyy-mm-dd form.
    expect(dateCell).not.toBe(String(BLOCK_TIME));
    expect(dateCell).not.toBe(String(BLOCK_TIME * 1000));
    expect(dateCell).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(dateCell).not.toContain("T");

    // Sanity: the rendered table cell agrees with what went into the PDF.
    expect(screen.getByTestId("cell-date-0").textContent).toBe(expectedDate);
  });
});
