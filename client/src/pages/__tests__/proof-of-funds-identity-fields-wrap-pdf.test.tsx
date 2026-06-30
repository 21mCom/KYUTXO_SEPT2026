// @vitest-environment jsdom
//
// Wrapping coverage for the optional declarant identity fields in the Proof of
// Funds Declaration PDF.
//
// The declarant identity lines (Residential / Street Address especially) are
// rendered with the `addLine` helper. A long residential address must NOT run
// off the right page margin — it has to wrap within the printable content width
// (`contentW = pageW - margin * 2`).
//
// Unlike the sibling identity-fields test (which fully fakes jsPDF and stubs
// `splitTextToSize` to a no-op), this file drives the REAL jsPDF so wrapping is
// genuinely width-based. jsPDF attaches `text` as a per-instance method (not on
// the prototype), so we mock the module to wrap the real constructor and patch
// the returned instance's `text` to capture every emitted line together with
// its measured width (`getTextWidth`, which honours the font size set right
// before each draw call). We then assert that no line of the long residential
// address exceeds the printable width.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// A4 portrait in mm with the builder's 14mm margins → 182mm printable width.
const PAGE_W = 210;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;
// jsPDF's splitTextToSize wraps to <= maxWidth; allow a tiny float epsilon.
const WIDTH_EPSILON = 0.5;

// A deliberately very long residential address (with spaces so it is wrappable)
// that vastly exceeds the printable width at the rendered font size.
const LONG_ADDRESS =
  "Flat 12B, The Exceptionally Long Residential Building Name, " +
  "1234 Extraordinarily Lengthy Boulevard Street Avenue Crescent, " +
  "Some Very Long Suburb District Neighbourhood Name, " +
  "Greater Metropolitan Council Area, Postcode AB12 3CD, " +
  "United Kingdom of Great Britain and Northern Ireland";

interface CapturedLine {
  text: string;
  width: number;
}

// Every string drawn via doc.text(), with the width jsPDF measured for it at
// draw time. Declared before vi.mock so the (hoisted) factory closes over it.
const captured: CapturedLine[] = [];

vi.mock("jspdf", async () => {
  const actual = await vi.importActual<typeof import("jspdf")>("jspdf");
  const Real = actual.default;
  // Wrap the constructor: build a real jsPDF doc, then patch its instance-level
  // `text` method to record each emitted line and its measured width.
  function CapturingJsPDF(this: unknown, ...args: unknown[]) {
    const doc: any = new (Real as any)(...args);
    const origText = doc.text.bind(doc);
    doc.text = (text: string | string[], ...rest: unknown[]) => {
      const arr = Array.isArray(text) ? text : [text];
      for (const t of arr) {
        let width = 0;
        try {
          width = doc.getTextWidth(t);
        } catch {
          width = 0;
        }
        captured.push({ text: String(t), width });
      }
      return origText(text, ...rest);
    };
    return doc;
  }
  return { ...actual, default: CapturingJsPDF };
});

vi.mock("jspdf-autotable", () => ({
  default: (doc: any) => {
    // Mirror the real plugin's contract: leave a finalY the caller reads from.
    doc.lastAutoTable = { finalY: 100 };
  },
}));

vi.mock("@/lib/data/address-stats", () => ({
  computeStatsForAddresses: vi.fn(async (addresses: string[]) => {
    const map = new Map<string, { balanceSats: number }>();
    for (const a of addresses) map.set(a, { balanceSats: 500_000 });
    return map;
  }),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByType: vi.fn(async () => []),
}));

// Make the signature verifier always succeed so an address reaches the
// "verified" state and the proof-of-control appendix branch runs.
const verifyBitcoinSignature = vi.fn(async () => ({ verified: true }));

vi.mock("@/lib/signatureVerify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/signatureVerify")>();
  return {
    ...actual,
    verifyBitcoinSignature: (...args: unknown[]) =>
      (verifyBitcoinSignature as any)(...args),
  };
});

describe("ProofOfFundsDeclaration — long identity values wrap within the PDF page", () => {
  beforeEach(() => {
    captured.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("wraps a very long residential address so no line overflows the right margin", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Required fields.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    // Only the long residential address — leaving the other optional identity
    // fields blank keeps the residential block bounded by the next emitted
    // label ("Declaration Date:") so we can isolate its wrapped lines.
    fireEvent.change(
      screen.getByTestId("input-declarant-residential-address"),
      { target: { value: LONG_ADDRESS } },
    );

    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(captured.some((c) => c.text.startsWith("Full Name:"))).toBe(true);
    });

    // Locate the residential block: from its label line up to the next
    // declarant label ("Declaration Date:").
    const startIdx = captured.findIndex((c) =>
      c.text.startsWith("Residential / Street Address:"),
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);

    const endIdx = captured.findIndex(
      (c, i) => i > startIdx && c.text.startsWith("Declaration Date:"),
    );
    expect(endIdx).toBeGreaterThan(startIdx);

    const residentialLines = captured.slice(startIdx, endIdx);

    // The long address must have wrapped onto more than one line (proving the
    // single-line label did not silently overflow off the page).
    expect(residentialLines.length).toBeGreaterThan(1);

    // No residential line may exceed the printable content width.
    for (const line of residentialLines) {
      expect(line.width).toBeLessThanOrEqual(CONTENT_W + WIDTH_EPSILON);
    }

    // The wrapped lines, recombined, must still contain the full address text
    // (nothing was clipped/dropped). The label prefix lives on the first line.
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const recombined = normalize(residentialLines.map((l) => l.text).join(" "));
    expect(recombined).toContain(normalize(LONG_ADDRESS));
  });

  it("wraps the fiat-equivalent and disclaimer lines so neither overflows the right margin", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    // An absurdly large exchange rate makes the formatted fiat-equivalent and
    // "(at USD ... per BTC)" line far exceed the printable width. The raw
    // doc.text used to draw it would have run straight off the right margin.
    fireEvent.change(screen.getByTestId("input-fiat-rate"), {
      target: { value: "1" + "0".repeat(60) },
    });

    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(captured.some((c) => c.text.startsWith("Fiat equivalent:"))).toBe(
        true,
      );
    });

    // The fiat block: from the "Fiat equivalent:" line up to (excluding) the
    // "DISCLAIMER:" line.
    const fiatStart = captured.findIndex((c) =>
      c.text.startsWith("Fiat equivalent:"),
    );
    expect(fiatStart).toBeGreaterThanOrEqual(0);
    const disclaimerStart = captured.findIndex(
      (c, i) => i > fiatStart && c.text.startsWith("DISCLAIMER:"),
    );
    expect(disclaimerStart).toBeGreaterThan(fiatStart);

    const fiatBlock = captured.slice(fiatStart, disclaimerStart);
    // The huge rate must have forced the fiat block to wrap.
    expect(fiatBlock.length).toBeGreaterThan(1);
    for (const line of fiatBlock) {
      expect(line.width).toBeLessThanOrEqual(CONTENT_W + WIDTH_EPSILON);
    }

    // The disclaimer block must also stay within the printable width.
    const afterDisclaimer = captured.findIndex(
      (c, i) =>
        i > disclaimerStart &&
        !c.text.startsWith("DISCLAIMER:") &&
        !/^(market quote|or financial)/.test(c.text),
    );
    const disclaimerEnd =
      afterDisclaimer > disclaimerStart ? afterDisclaimer : captured.length;
    const disclaimerBlock = captured.slice(disclaimerStart, disclaimerEnd);
    expect(disclaimerBlock.length).toBeGreaterThanOrEqual(1);
    for (const line of disclaimerBlock) {
      expect(line.width).toBeLessThanOrEqual(CONTENT_W + WIDTH_EPSILON);
    }
  });

  it("keeps the verified-address appendix heading and signature-format lines within the page", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
    });

    // Verify the address so it reaches "verified" and the appendix renders.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "AnyBase64SignatureHere==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(screen.getByText("Control Verified")).toBeTruthy();
    });

    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(captured.some((c) => c.text === `Address: ${ADDR}`)).toBe(true);
    });

    // The appendix per-address heading line must stay within the page.
    const addrHeadings = captured.filter((c) => c.text === `Address: ${ADDR}`);
    expect(addrHeadings.length).toBeGreaterThanOrEqual(1);
    for (const line of addrHeadings) {
      expect(line.width).toBeLessThanOrEqual(CONTENT_W + WIDTH_EPSILON);
    }

    // The "Signature Format: ..." line must also stay within the page.
    const sigFormatLines = captured.filter((c) =>
      c.text.startsWith("Signature Format:"),
    );
    expect(sigFormatLines.length).toBeGreaterThanOrEqual(1);
    for (const line of sigFormatLines) {
      expect(line.width).toBeLessThanOrEqual(CONTENT_W + WIDTH_EPSILON);
    }
  });
});
