// @vitest-environment jsdom
//
// Regression guard for the garbled-text vector in the Annual Activity Report
// PDF export (AnnualActivityReport.tsx `exportPdf`).
//
// jsPDF's Standard-14 Helvetica has no embedded Unicode font, so any text run
// outside the WinAnsi (Windows-1252) range is emitted as a UTF-16BE byte stream
// that renders as garbled glyphs. The fix routes record-derived strings (the
// per-address breakdown header, counterparty addresses, unresolved-input txids)
// through `sanitizePdfText`. If a future edit drops one of those wrappers, a
// non-Latin address would silently reintroduce a UTF-16BE run.
//
// This renders the REAL <AnnualActivityReport /> against real Dexie data, drives
// it through the UI (paste address → Generate → Export PDF), captures the blob
// jsPDF hands to URL.createObjectURL, and asserts the document contains NO
// UTF-16BE runs. A non-Latin OWNED address (per-address header) and a non-Latin
// counterparty input address ("Received From" list) exercise both surfaces.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { renderWithProviders } from "@/test/testProviders";
import { extractPdfText, pdfHasUtf16beRuns } from "@/test/pdfAssertions";
import AnnualActivityReport from "./AnnualActivityReport";

// A pasted OWNED address carrying a CJK glyph (above U+00FF). It flows into the
// per-address breakdown header via sanitizePdfText(pa.address).
const OWNED = "bc1q魏health0000000000000000000000000000000aa";

// A non-Latin counterparty that funds OWNED — it lands in the "Received From"
// list, rendered via sanitizePdfText(e.address).
const COUNTERPARTY = "bc1q段測試counterparty00000000000000000000aa";

const FUND_TX =
  "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const ONE_BTC = 100_000_000;
const FUND_BLOCKTIME = Math.floor(Date.UTC(2022, 5, 1) / 1000);

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
  // jsPDF/exportPdf appends an <a> and clicks it; stop jsdom from navigating.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });

  await createRecord(
    { type: "address", inputString: OWNED, label: "Owned", tags: [], categories: [] },
    { skipNotification: true, skipVocabularySync: true },
  );

  // Funding tx: COUNTERPARTY (input) → OWNED (output, 1 BTC).
  await addTransaction(
    {
      txid: FUND_TX,
      blockHeight: 730000,
      blockTime: FUND_BLOCKTIME,
      fee: 1000,
      feeRate: 5,
      syncedAt: Date.now(),
    },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: FUND_TX, role: "input", address: COUNTERPARTY, amount: ONE_BTC },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: FUND_TX, role: "output", address: OWNED, amount: ONE_BTC, vout: 0 },
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

describe("Annual Activity Report PDF — WinAnsi safety", () => {
  it("emits no UTF-16BE runs for non-Latin addresses in the exported PDF", async () => {
    const { getByTestId, findByTestId } = renderWithProviders(
      <AnnualActivityReport />,
    );

    fireEvent.change(getByTestId("textarea-addresses"), {
      target: { value: OWNED },
    });
    fireEvent.click(getByTestId("button-generate"));

    // Wait for the report to build before the export button does anything.
    await findByTestId("table-combined");

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
    expect(text).toContain("KYUTXO Annual Activity Report");
    expect(text).toContain("Per-Address Breakdown");
    // The non-Latin OWNED/counterparty glyphs were replaced with "?".
    expect(text).toContain("?");
    // The Latin-1 portion of the owned address survives the sanitizer intact.
    expect(text).toContain("health");
  });
});
