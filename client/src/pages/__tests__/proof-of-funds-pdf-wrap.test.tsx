// @vitest-environment jsdom
//
// Coverage for ProofOfFundsDeclaration's PDF line-wrapping behavior.
//
// The PDF builder's addLine()/addWrapped() helpers run every string through
// jsPDF's doc.splitTextToSize(text, contentW) before drawing, so that very long
// declarant identity values (Full Name, Tax ID, Residential Address,
// Nationality, ID Number, etc.) wrap onto multiple lines instead of running off
// the right edge of the page.
//
// This test fills the declarant identity fields with extremely long values,
// generates the PDF, and spies on the REAL jsPDF instance's text() calls to
// assert two things:
//   (1) every drawn line fits within the printable content width (no overflow);
//   (2) the long values actually wrapped across more than one drawn line.
//
// If addLine() ever reverts to writing unwrapped single-line text (e.g. a
// refactor drops the splitTextToSize() call), the long values would be drawn as
// a single line far wider than contentW and assertion (1) fails.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// A4 portrait in mm: width 210, margin 14 each side → printable width 182mm.
const CONTENT_W_MM = 210 - 14 * 2;
// Small tolerance for rounding in jsPDF's width measurement.
const WIDTH_TOLERANCE_MM = 0.5;

// Long, space-separated values so they MUST wrap across several lines. Each
// field embeds a unique sentinel token so we can count how many drawn lines
// carry that field's content.
const LONG_NAME = Array(40).fill("Wrapname").join(" ");
const LONG_RESIDENTIAL = Array(40).fill("Wrapaddr").join(" ");
const LONG_NATIONALITY = Array(40).fill("Wrapnat").join(" ");
const LONG_TAXID = Array(40).fill("Wraptax").join(" ");
const LONG_IDNUMBER = Array(40).fill("Wrapidn").join(" ");

// Capture every line the PDF builder draws via the REAL jsPDF instance. The
// mock wraps a genuine jsPDF object so splitTextToSize()/getTextWidth() reflect
// actual jsPDF behavior; only text() (recording) and save() (no-op) are wrapped.
const pdfState = vi.hoisted(() => ({
  drawn: [] as { line: string; width: number }[],
}));

vi.mock("jspdf", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  const Real = actual.default;
  function Wrapped(this: any, ...args: unknown[]) {
    const inst: any = new Real(...args);
    const origText = inst.text.bind(inst);
    inst.text = (...a: unknown[]) => {
      const text = a[0];
      const parts = Array.isArray(text) ? (text as string[]) : [text as string];
      for (const line of parts) {
        if (typeof line === "string") {
          pdfState.drawn.push({ line, width: inst.getTextWidth(line) });
        }
      }
      return origText(...a);
    };
    inst.save = () => inst;
    return inst;
  }
  Wrapped.prototype = Real.prototype;
  return { ...actual, default: Wrapped };
});

vi.mock("@/lib/data/address-stats", () => ({
  computeStatsForAddresses: vi.fn(async (addresses: string[]) => {
    const map = new Map<string, { balanceSats: number }>();
    for (const a of addresses) map.set(a, { balanceSats: 500_000 });
    return map;
  }),
}));

// Treat any non-empty string as a valid address so we can feed an
// artificially long "address" (real Bitcoin addresses top out around 62 chars,
// which is too short to force the balances table / QR appendix to wrap). The
// rest of @/lib/bitcoin (notably formatBTC) keeps its real implementation.
vi.mock("@/lib/bitcoin", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    validateAddress: (address: string) =>
      address && address.trim().length > 0
        ? { isValid: true, type: "address", addressType: "P2PKH", network: "mainnet" }
        : actual.validateAddress(address),
  };
});

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByType: vi.fn(async () => []),
}));

// qrcode's toDataURL renders to a <canvas>, which jsdom doesn't implement, so
// the real call hangs/rejects. Return an empty string: the PDF builder guards
// `if (dataUrl)` before doc.addImage(), so the QR image is skipped (jspdf can't
// decode a fake PNG anyway) while the per-address text block — the address,
// balance, and explorer URL we're asserting on — is still drawn.
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => ""),
  },
}));

describe("ProofOfFundsDeclaration — long identity values wrap inside the PDF page", () => {
  beforeEach(() => {
    pdfState.drawn.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("wraps long declarant fields onto multiple lines that stay within the content width", async () => {
    const drawn = pdfState.drawn;

    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed one address and run the offline balance check so a "done" row exists
    // (the Generate PDF button is gated on doneRows.length > 0).
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));
    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Fill the declarant identity fields with extremely long values.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: LONG_NAME },
    });
    fireEvent.change(screen.getByTestId("input-declarant-residential-address"), {
      target: { value: LONG_RESIDENTIAL },
    });
    fireEvent.change(screen.getByTestId("input-declarant-nationality"), {
      target: { value: LONG_NATIONALITY },
    });
    fireEvent.change(screen.getByTestId("input-declarant-tax-id"), {
      target: { value: LONG_TAXID },
    });
    fireEvent.change(screen.getByTestId("input-declarant-id-number"), {
      target: { value: LONG_IDNUMBER },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Proof of funds for a property purchase" },
    });

    // Generate the PDF.
    await waitFor(() => {
      expect(
        (screen.getByTestId("button-generate-pdf") as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("button-generate-pdf"));

    // Wait until the builder has drawn the declarant fields.
    await waitFor(() => {
      expect(drawn.some((d) => d.line.includes("Wraptax"))).toBe(true);
    });

    // (1) No drawn line may overflow the printable content width.
    const overflowing = drawn.filter(
      (d) => d.width > CONTENT_W_MM + WIDTH_TOLERANCE_MM,
    );
    expect(
      overflowing,
      `Drawn line(s) overflow the ${CONTENT_W_MM}mm content width: ` +
        JSON.stringify(overflowing.slice(0, 3)),
    ).toEqual([]);

    // (2) Each long field must have wrapped across more than one drawn line.
    // (If addLine reverted to single-line text, these would each be 1 — and
    // assertion (1) above would already have failed on the overflow.)
    for (const token of ["Wrapname", "Wrapaddr", "Wrapnat", "Wraptax", "Wrapidn"]) {
      const count = drawn.filter((d) => d.line.includes(token)).length;
      expect(count, `field "${token}" should wrap onto multiple lines`).toBeGreaterThan(1);
    }
  });
});

// The Bitcoin Address Balances table (drawn by jspdf-autotable) and the Balance
// Verification QR appendix draw their own text through separate code paths from
// the declarant fields above:
//   - the table relies on autoTable's per-column cellWidth to wrap long
//     addresses inside column 0 (contentW * 0.55);
//   - the QR appendix calls doc.splitTextToSize(text, textW) for the address and
//     explorer URL drawn next to each code, where textW is the narrower
//     content width minus the QR image column (contentW - qrSize - 4).
// A refactor could widen/remove a column style or drop a splitTextToSize() call
// and reintroduce overflow there without the declarant test noticing. This test
// feeds an artificially long address (so its explorer URL is long too) and
// asserts those sections keep every drawn line inside the available
// column/content width.
describe("ProofOfFundsDeclaration — balances table & QR appendix keep long content inside the page", () => {
  // A4 portrait, margin 14mm: printable contentW = 182mm.
  const CONTENT_W_MM = 210 - 14 * 2;
  // Table column 0 ("Bitcoin Address") is contentW * 0.55; autoTable wraps cell
  // text to that width (minus padding), so no drawn address line may exceed it.
  const TABLE_ADDR_COL_W_MM = CONTENT_W_MM * 0.55;
  // QR appendix text column: contentW minus the 30mm QR image and a 4mm gutter.
  const QR_TEXT_W_MM = CONTENT_W_MM - 30 - 4;
  const TOL_MM = 0.5;

  // Unbroken 320-char "address" with a repeating sentinel unit. jsPDF /
  // autoTable break long unbroken strings by character, and every wrapped chunk
  // is wide enough to contain at least one full "Qrza" period, so counting
  // lines that contain the token counts the wrapped chunks.
  const LONG_ADDR = "Qrza".repeat(80);

  beforeEach(() => {
    pdfState.drawn.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("wraps the long table address and QR appendix address/URL inside their columns", async () => {
    const drawn = pdfState.drawn;

    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: LONG_ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));
    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Turn on the QR appendix so the per-address QR text block is emitted. Do
    // this before filling the declarant fields: generatePdf is a useCallback
    // whose dep list omits includeQr, so a subsequent declarant-field change
    // (a real dep) is what re-memoizes it with includeQr=true.
    fireEvent.click(screen.getByTestId("switch-include-qr"));

    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Jane Declarant" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Proof of funds for a property purchase" },
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId("button-generate-pdf") as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("button-generate-pdf"));

    // Wait until both sections have been drawn.
    await waitFor(() => {
      expect(drawn.some((d) => d.line === "BALANCE VERIFICATION QR CODES")).toBe(true);
    });

    const idxTable = drawn.findIndex((d) => d.line === "BITCOIN ADDRESS BALANCES");
    const idxQr = drawn.findIndex((d) => d.line === "BALANCE VERIFICATION QR CODES");
    const idxDisc = drawn.findIndex((d) => d.line === "DISCLAIMERS");
    expect(idxTable, "balances table heading should be drawn").toBeGreaterThanOrEqual(0);
    expect(idxQr, "QR appendix heading should be drawn").toBeGreaterThan(idxTable);
    expect(idxDisc, "disclaimers heading should be drawn").toBeGreaterThan(idxQr);

    const tableRegion = drawn.slice(idxTable + 1, idxQr);
    const qrRegion = drawn.slice(idxQr + 1, idxDisc);

    // (0) Sanity: no drawn line anywhere overflows the full printable width.
    const pageOverflow = drawn.filter((d) => d.width > CONTENT_W_MM + TOL_MM);
    expect(
      pageOverflow,
      `Drawn line(s) overflow the ${CONTENT_W_MM}mm page width: ` +
        JSON.stringify(pageOverflow.slice(0, 3)),
    ).toEqual([]);

    // (1) Balances table: the long address must wrap, and every wrapped line of
    // it must stay within the address column width. If the column style were
    // removed/widened, an address line would exceed TABLE_ADDR_COL_W_MM.
    const tableAddrLines = tableRegion.filter((d) => d.line.includes("Qrza"));
    expect(
      tableAddrLines.length,
      "long address should wrap onto multiple lines in the balances table",
    ).toBeGreaterThan(1);
    const tableOverflow = tableAddrLines.filter(
      (d) => d.width > TABLE_ADDR_COL_W_MM + TOL_MM,
    );
    expect(
      tableOverflow,
      `Balances-table address line(s) overflow the ${TABLE_ADDR_COL_W_MM.toFixed(1)}mm column: ` +
        JSON.stringify(tableOverflow.slice(0, 3)),
    ).toEqual([]);

    // (2) QR appendix: the address and its explorer URL are drawn next to the
    // code through splitTextToSize(text, textW). Both must wrap and stay within
    // the narrower QR text column. If a splitTextToSize() call were dropped, the
    // long address/URL would be one line far wider than QR_TEXT_W_MM.
    const qrAddrUrlLines = qrRegion.filter(
      (d) => d.line.includes("Qrza") || d.line.includes("https"),
    );
    expect(
      qrAddrUrlLines.length,
      "QR appendix address/URL should wrap onto multiple lines",
    ).toBeGreaterThan(1);
    const qrOverflow = qrAddrUrlLines.filter(
      (d) => d.width > QR_TEXT_W_MM + TOL_MM,
    );
    expect(
      qrOverflow,
      `QR appendix line(s) overflow the ${QR_TEXT_W_MM.toFixed(1)}mm text column: ` +
        JSON.stringify(qrOverflow.slice(0, 3)),
    ).toEqual([]);
  });
});
