// @vitest-environment jsdom
//
// Coverage for the PARTIAL-verification branch of controlDisclaimerLine in the
// DISCLAIMERS section. The all-verified single-format and mixed-format branches
// are tested elsewhere (proof-of-funds-single-format-pdf.test.tsx and
// proof-of-funds-mixed-format-pdf.test.tsx). The partial branch — some but not
// all addresses are control-verified — was still untested:
//
//   "Cryptographic proof-of-control is included for N of M addresses via
//    <formatPhrase>. The remaining addresses are self-declared. ..."
//
// A regression in the N-of-M count, the "es" pluralization, or the formatPhrase
// selection could silently ship the wrong disclaimer wording without any test
// failing. This test seeds two legacy addresses, verifies only ONE of them,
// generates the PDF (jsPDF is mocked so every `doc.text(...)` string is
// captured) and asserts:
//   (1) the disclaimer uses the "1 of 2 addresses ... The remaining addresses
//       are self-declared" partial phrasing with correct counts/pluralization;
//   (2) the formatPhrase reflects only the verified (legacy) address;
//   (3) the all-verified "for all addresses" phrasing is NOT used.
//
// verifyBitcoinSignature is mocked to return verified with a format derived
// from the address prefix; signatureFormatLabel and buildChallengeMessage stay
// real so the labels and disclaimer text are exercised exactly as shipped.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { signatureFormatLabel } from "@/lib/signatureVerify";

// Expected label derives from the real signatureFormatLabel so a deliberate
// wording change doesn't cascade into false failures here; the exact wording
// is pinned once in client/src/lib/signatureVerify.test.ts.
const LEGACY_LABEL = signatureFormatLabel("legacy");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Two legacy P2PKH addresses — verifying only the first leaves the second
// self-declared, so doneRows.length (2) !== verifiedRows.length (1).
const LEGACY_ADDR_1 = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const LEGACY_ADDR_2 = "12higDjoCCNXSA95xZMWUdPvXNmkAduhWv";

// Captures every string passed to doc.text() across the generated PDF so the
// test can assert which labelled lines were (and were not) emitted.
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

// Keep signatureFormatLabel / buildChallengeMessage / generateDeclarationNonce
// real; only stub the actual cryptographic verification so the test does not
// need genuine signatures over the dynamic challenge message. The format is
// derived from the address type, exactly as the real verifier would report it.
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

describe("ProofOfFundsDeclaration — partial-verification proof-of-control PDF", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the 'N of M addresses ... remaining are self-declared' phrasing when only some are verified", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed both addresses and resolve their balances so two "done" rows exist.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: `${LEGACY_ADDR_1}\n${LEGACY_ADDR_2}` },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Required declarant fields — filled BEFORE verifying so the challenge
    // message is final and the verified state is not reset as stale.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    // Step 5 verify UI only renders once declarant info is complete.
    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
      expect(screen.getByTestId("textarea-signature-1")).toBeTruthy();
    });

    // Verify ONLY the first address — the second stays self-declared.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "legacy-signature-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    // Exactly one of two addresses should report as control-verified.
    await waitFor(() => {
      expect(
        screen.getByText(/1 of 2 addresses control-verified/i),
      ).toBeTruthy();
    });

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
        pdfTextLines.some((l) => l.includes("proof-of-control is included")),
      ).toBe(true);
    });

    // (1) Disclaimer uses the partial "1 of 2 addresses ... The remaining
    //     addresses are self-declared" phrasing with the legacy formatPhrase.
    const partialDisclaimer = pdfTextLines.find(
      (l) =>
        l.includes("proof-of-control is included") &&
        l.includes("1 of 2 addresses") &&
        new RegExp(`via ${escapeRegExp(LEGACY_LABEL)} signatures\\.`).test(l) &&
        l.includes("The remaining addresses are self-declared"),
    );
    expect(partialDisclaimer).toBeTruthy();

    // (2) The all-verified "for all addresses" phrasing must NOT be used.
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes("proof-of-control is included") &&
          l.includes("for all addresses"),
      ),
    ).toBe(false);

    // The "No cryptographic proof-of-control" branch must also NOT appear.
    expect(
      pdfTextLines.some((l) =>
        l.includes("No cryptographic proof-of-control is included"),
      ),
    ).toBe(false);
  });
});
