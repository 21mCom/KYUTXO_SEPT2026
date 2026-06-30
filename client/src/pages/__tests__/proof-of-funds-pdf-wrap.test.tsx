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

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByType: vi.fn(async () => []),
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
