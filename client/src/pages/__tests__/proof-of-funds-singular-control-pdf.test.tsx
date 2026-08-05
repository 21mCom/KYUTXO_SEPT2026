// @vitest-environment jsdom
//
// Coverage for the SINGULAR grammar boundary of the proof-of-control
// pluralization `address${doneRows.length !== 1 ? "es" : ""}`
// (ProofOfFundsDeclaration.tsx). The sibling
// `proof-of-funds-partial-control-pdf.test.tsx` locks the plural case
// ("2 of 3 addresses"); this file locks the singular boundary so a formal
// evidence document never reads an awkward "1 of 1 addresses" / "1 address(es)".
//
// Two reachable boundaries are exercised:
//
//   (A) ONE address, control-verified. doneRows.length === 1, so the on-screen
//       control-verification disclaimer (the green ShieldCheck line) must read
//       "1 of 1 address control-verified" — singular "address", NO trailing
//       "es". Because a single verified address is also `allVerified`, the
//       generated PDF disclaimer reads "for all addresses" and must NEVER emit
//       the awkward partial "1 of 1 addresses" phrasing.
//
//   (B) ONE verified of TWO declared ("1 of N" edge). The partial-branch
//       disclaimer pluralizes off the TOTAL (doneRows.length), not the verified
//       count, so a single verified address among others must still read
//       "for 1 of 2 addresses" — plural, anchored to the total. This guards
//       against a refactor that mistakenly keys pluralization off the verified
//       count (which would wrongly produce "1 of 2 address").
//
// jsPDF is mocked so every doc.text(...) string is captured; signature
// verification is stubbed (format derived from the address prefix) while
// signatureFormatLabel / buildChallengeMessage stay real.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import {
  CONTROL_INCLUDED_FRAGMENT,
  ALL_ADDRESSES_FRAGMENT,
  buildFormatPhrase,
  buildControlDisclaimerLine,
} from "@/pages/proof-of-funds/pof-pdf-strings";

// The disclaimer scaffolding comes from pof-pdf-strings; its exact wording is
// pinned once in proof-of-funds-mixed-format-pdf.test.tsx, so a deliberate
// wording change doesn't cascade into false failures here. Case (B) verifies
// one legacy address of two, so the expected partial line uses the legacy
// format phrase.
const PARTIAL_1_OF_2_LINE = buildControlDisclaimerLine({
  allVerified: false,
  hasVerified: true,
  verifiedCount: 1,
  totalCount: 2,
  formatPhrase: buildFormatPhrase(new Set(["legacy"])),
});

const LEGACY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const SELF_DECLARED_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

// Captures every string passed to doc.text() across the generated PDF.
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

vi.mock("@/lib/signatureVerify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/signatureVerify")>();
  return {
    ...actual,
    verifyBitcoinSignature: vi.fn(async (address: string) => {
      const isTaproot =
        address.startsWith("bc1p") || address.startsWith("tb1p");
      return { verified: true, format: isTaproot ? "bip322" : "legacy" };
    }),
  };
});

describe("ProofOfFundsDeclaration — singular proof-of-control boundary", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("(A) a single verified address reads 'address' (singular) and PDF says 'for all addresses'", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: LEGACY_ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Declarant fields filled BEFORE verifying so verified state is not reset.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "legacy-signature-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    // On-screen control-verified line must read the SINGULAR "1 of 1 address".
    await waitFor(() => {
      expect(
        screen.getByText(/1 of 1 address control-verified/i),
      ).toBeTruthy();
    });
    // And must NOT pluralize to "1 of 1 addresses".
    expect(screen.queryByText(/1 of 1 addresses control-verified/i)).toBeNull();

    // Generate the PDF.
    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(
        pdfTextLines.some((l) => l.includes(CONTROL_INCLUDED_FRAGMENT)),
      ).toBe(true);
    });

    // A single verified address is allVerified → "for all addresses".
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes(CONTROL_INCLUDED_FRAGMENT) &&
          l.includes(ALL_ADDRESSES_FRAGMENT),
      ),
    ).toBe(true);

    // It must NEVER emit the awkward partial "1 of 1 addresses" phrasing.
    expect(
      pdfTextLines.some((l) => l.includes("1 of 1 addresses")),
    ).toBe(false);
    expect(
      pdfTextLines.some((l) => l.includes("1 of 1 address")),
    ).toBe(false);
  });

  it("(B) a single verified address among many keeps the disclaimer plural ('for 1 of 2 addresses')", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: `${LEGACY_ADDR}\n${SELF_DECLARED_ADDR}` },
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

    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
      expect(screen.getByTestId("textarea-signature-1")).toBeTruthy();
    });

    // Verify ONLY the first address; leave the second self-declared.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "legacy-signature-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(
        screen.getByText(/1 of 2 addresses control-verified/i),
      ).toBeTruthy();
    });

    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(
        pdfTextLines.some((l) => l.includes(CONTROL_INCLUDED_FRAGMENT)),
      ).toBe(true);
    });

    // The "1 of N" edge must stay pluralized off the TOTAL → "for 1 of 2
    // addresses" — asserted as the exact partial-branch line built from
    // pof-pdf-strings.
    expect(pdfTextLines).toContain(PARTIAL_1_OF_2_LINE);

    // It must NOT read the ungrammatical "for 1 of 2 address".
    expect(
      pdfTextLines.some((l) => l.includes("for 1 of 2 address via")),
    ).toBe(false);
  });
});
