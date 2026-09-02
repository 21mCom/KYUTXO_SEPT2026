// @vitest-environment jsdom
//
// Inverse coverage for the Proof of Funds Declaration PDF appendix.
//
// The companion test (proof-of-funds-verify-instructions-pdf.test.tsx) asserts
// that when at least one address has verified cryptographic proof-of-control,
// the "APPENDIX: PROOF-OF-CONTROL EVIDENCE" section (with "HOW TO INDEPENDENTLY
// VERIFY" and "CHALLENGE MESSAGE FORMAT") is emitted.
//
// This test guards the inverse risk: when NO address has a verified signature,
// the appendix and ALL of its verification language must be completely absent,
// so a self-declared-only declaration can never appear to a bank as if it
// carried cryptographic proof-of-control. It seeds one valid address with a
// resolved offline balance, fills the declarant details, generates the PDF
// WITHOUT verifying any signature, and asserts:
//   (1) the appendix heading "APPENDIX: PROOF-OF-CONTROL EVIDENCE" is absent;
//   (2) "HOW TO INDEPENDENTLY VERIFY" and "CHALLENGE MESSAGE FORMAT" are absent;
//   (3) the disclaimer/statement line states all addresses are self-declared and
//       does NOT claim cryptographic proof-of-control is included.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import {
  CONTROL_INCLUDED_FRAGMENT,
  NO_CONTROL_DISCLAIMER_LINE,
  PROOF_OF_CONTROL_APPENDIX_HEADING,
  HOW_TO_VERIFY_HEADING,
  CHALLENGE_MESSAGE_FORMAT_HEADING,
} from "@/pages/proof-of-funds/pof-pdf-strings";

// The disclaimer scaffolding comes from pof-pdf-strings; its exact wording is
// pinned once in proof-of-funds-mixed-format-pdf.test.tsx, so a deliberate
// wording change doesn't cascade into false failures here.

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// Captures every string passed to doc.text() across the generated PDF so the
// test can assert which lines were (and were not) emitted. splitTextToSize is
// the identity (returns the input as a single element) so multi-line paragraphs
// stay intact and can be matched with substring checks.
const pdfTextLines: string[] = [];

vi.mock("jspdf", () => {
  class FakeJsPDF {
    internal = {
      pageSize: {
        getWidth: () => 210,
        getHeight: () => 297,
      },
    };
    lastAutoTable = { finalY: 0 };
    setFontSize() {}
    setFont() {}
    setTextColor() {}
    setDrawColor() {}
    setFillColor() {}
    setLineWidth() {}
    line() {}
    rect() {}
    addPage() {}
    addImage() {}
    splitTextToSize(text: string) {
      return [text];
    }
    text(text: string | string[]) {
      if (Array.isArray(text)) {
        for (const t of text) pdfTextLines.push(t);
      } else {
        pdfTextLines.push(text);
      }
    }
    save() {}
  }
  return { default: FakeJsPDF };
});

vi.mock("jspdf-autotable", () => ({
  default: (doc: any) => {
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

// True when at least one captured PDF line contains the given substring.
function pdfHas(substr: string): boolean {
  return pdfTextLines.some((l) => l.includes(substr));
}

describe("ProofOfFundsDeclaration — appendix omitted when nothing is verified", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("omits the proof-of-control appendix and verification language for a self-declared-only declaration", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Required declarant details (unlock PDF generation).
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    // Seed one valid address and run the offline balance check so a balance is
    // resolved, but DO NOT verify any signature.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
    });

    // Generate the PDF (no signature verified).
    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    // Wait until PDF generation has emitted content (the DISCLAIMERS section is
    // always present), proving the document was fully generated.
    await waitFor(() => {
      expect(pdfHas("DISCLAIMERS")).toBe(true);
    });

    // (1) + (2) The appendix and all of its verification language must be
    // completely absent.
    expect(pdfHas(PROOF_OF_CONTROL_APPENDIX_HEADING)).toBe(false);
    expect(pdfHas(HOW_TO_VERIFY_HEADING)).toBe(false);
    expect(pdfHas(CHALLENGE_MESSAGE_FORMAT_HEADING)).toBe(false);

    // (3) The statement line must declare everything self-declared and must NOT
    // claim cryptographic proof-of-control is included.
    expect(pdfHas(NO_CONTROL_DISCLAIMER_LINE)).toBe(true);
    expect(pdfHas(`Cryptographic ${CONTROL_INCLUDED_FRAGMENT}`)).toBe(false);
  });
});
