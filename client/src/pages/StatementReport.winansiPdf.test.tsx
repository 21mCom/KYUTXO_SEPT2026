// @vitest-environment jsdom
//
// Regression guard for the garbled-text vector in the Statement Report PDF
// export (exportPdf in StatementReport.tsx).
//
// jsPDF's Standard-14 Helvetica has no embedded Unicode font, so any text run
// outside the WinAnsi (Windows-1252) range is emitted as a UTF-16BE byte stream
// that renders as garbled glyphs. The fix routes record-derived strings (the
// subtitle "Addresses:" list, the per-row TXID column, and the per-row Addresses
// column) through `sanitizePdfText`. If a future edit drops one of those
// wrappers, a non-Latin address or txid would silently reintroduce a UTF-16BE
// run.
//
// This renders the REAL <StatementReport /> against real Dexie data, drives it
// through the UI (paste address → enable TXID/Address columns → Generate →
// Export PDF), captures the blob jsPDF hands to URL.createObjectURL, and asserts
// the document contains NO UTF-16BE runs.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { clearAllRecords } from "@/lib/data/record-crud";
import { renderWithProviders } from "@/test/testProviders";
import { extractPdfText, pdfHasUtf16beRuns } from "@/test/pdfAssertions";
import StatementReport from "./StatementReport";

// A non-Latin OWNED address (above U+00FF). It flows into the subtitle
// "Addresses:" list (usedAddresses) and the per-row Addresses column.
const OWNED = "bc1q魏health0000000000000000000000000000000aa";
// A non-Latin txid lands in the per-row TXID column (row.txid.slice(0,16)).
const NON_LATIN_TXID = "魏健txid" + "a".repeat(56);
const ONE_BTC = 100_000_000;
const BLOCK_TIME = Math.floor(Date.UTC(2023, 5, 1) / 1000);

let createObjectURL: typeof URL.createObjectURL | undefined;
let revokeObjectURL: typeof URL.revokeObjectURL | undefined;
let capturedBlob: Blob | null = null;

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  capturedBlob = null;

  createObjectURL = (URL as { createObjectURL?: typeof URL.createObjectURL })
    .createObjectURL;
  revokeObjectURL = (URL as { revokeObjectURL?: typeof URL.revokeObjectURL })
    .revokeObjectURL;
  URL.createObjectURL = vi.fn((obj: Blob | MediaSource) => {
    if (obj instanceof Blob) capturedBlob = obj;
    return "blob:mock";
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  // exportPdf appends an <a> and clicks it; stop jsdom from navigating.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });

  // A confirmed tx with an OWNED output (net positive) so the report has a row.
  await addTransaction(
    {
      txid: NON_LATIN_TXID,
      blockHeight: 790000,
      blockTime: BLOCK_TIME,
      fee: 1000,
      feeRate: 5,
      syncedAt: Date.now(),
    },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: NON_LATIN_TXID, role: "output", address: OWNED, amount: ONE_BTC, vout: 0 },
    { skipNotification: true },
  );
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  if (createObjectURL) URL.createObjectURL = createObjectURL;
  else
    delete (URL as { createObjectURL?: typeof URL.createObjectURL })
      .createObjectURL;
  if (revokeObjectURL) URL.revokeObjectURL = revokeObjectURL;
  else
    delete (URL as { revokeObjectURL?: typeof URL.revokeObjectURL })
      .revokeObjectURL;
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

describe("Statement Report PDF — WinAnsi safety", () => {
  it("emits no UTF-16BE runs for non-Latin addresses/txids in the exported PDF", async () => {
    const { getByTestId, findByTestId } = renderWithProviders(<StatementReport />);

    fireEvent.change(getByTestId("textarea-paste-addresses"), {
      target: { value: OWNED },
    });
    // Enable the TXID and Addresses columns so both record-derived columns are
    // exercised in the PDF body.
    fireEvent.click(getByTestId("checkbox-show-txids"));
    fireEvent.click(getByTestId("checkbox-show-addresses"));
    fireEvent.click(getByTestId("button-generate-report"));

    // Wait for the report rows to render before the export button does anything.
    await findByTestId("table-statement");

    const exportBtn = await findByTestId("button-export-pdf");
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(capturedBlob).toBeInstanceOf(Blob);
    });
    const blob = capturedBlob as unknown as Blob;

    // The smoking gun: a UTF-16BE run means a record-derived string bypassed
    // sanitizePdfText and will render garbled.
    expect(await pdfHasUtf16beRuns(blob)).toBe(false);

    const text = await extractPdfText(blob);
    // Static scaffolding proves the document rendered, not just that bytes exist.
    expect(text).toContain("Bitcoin Statement Report");
    // The Latin-1 portion of the owned address survives the sanitizer intact.
    expect(text).toContain("health");
    // The non-Latin glyphs were replaced with the safe "?" substitute.
    expect(text).toContain("?");
  });
});
