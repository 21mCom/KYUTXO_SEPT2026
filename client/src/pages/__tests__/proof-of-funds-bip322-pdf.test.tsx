// @vitest-environment jsdom
//
// Coverage for the Taproot (BIP-322) format-specific labelling in the Proof of
// Funds Declaration PDF appendix.
//
// The appendix renders a different label depending on the verified signature
// scheme: legacy addresses show "Wallet Signature (base64):" while a Taproot
// (bc1p…) address verified via BIP-322 must show "BIP-322 Witness (base64):"
// plus the BIP-322 format label. The existing verify-instructions test only
// exercises a legacy address, so a regression that mislabelled BIP-322 evidence
// (or dropped the format-specific branch and fell back to the legacy label)
// would go unnoticed and could confuse the institution verifying the proof.
//
// This test verifies a SINGLE Taproot address with a mocked BIP-322 result and
// generates the PDF (jsPDF is mocked so every `doc.text(...)` string is
// captured), then asserts:
//   (1) the per-address "Signature Format:" line uses the BIP-322 label and the
//       legacy label is NOT present anywhere;
//   (2) the appendix signature-box heading is "BIP-322 Witness (base64):" and
//       the legacy "Wallet Signature (base64):" heading is NOT present;
//   (3) the DISCLAIMERS statement line uses the single-format "via BIP-322
//       signatures." phrasing (not the legacy or combined phrasing).
//
// verifyBitcoinSignature is mocked to return verified with format "bip322";
// signatureFormatLabel / buildChallengeMessage stay real so the labels and
// disclaimer text are exercised exactly as shipped.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { signatureFormatLabel } from "@/lib/signatureVerify";

// Expected labels derive from the real signatureFormatLabel so a deliberate
// wording change doesn't cascade into false failures here; the exact wording
// is pinned once in client/src/lib/signatureVerify.test.ts.
const LEGACY_LABEL = signatureFormatLabel("legacy");
const BIP322_LABEL = signatureFormatLabel("bip322");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A mainnet Taproot (P2TR) address.
const TAPROOT_ADDR =
  "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";

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
// need a genuine BIP-322 witness over the dynamic challenge message. The format
// is reported as "bip322", exactly as the real verifier would for a Taproot
// address.
vi.mock("@/lib/signatureVerify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/signatureVerify")>();
  return {
    ...actual,
    verifyBitcoinSignature: vi.fn(async () => ({
      verified: true,
      format: "bip322",
    })),
  };
});

describe("ProofOfFundsDeclaration — Taproot (BIP-322) proof-of-control PDF", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("labels a Taproot address with the BIP-322 format, not the legacy label", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed the Taproot address and resolve its balance.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: TAPROOT_ADDR },
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
    });

    // Paste a (mock-accepted) BIP-322 witness and verify it.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "bip322-witness-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(
        screen.getByText(/1 of 1 address control-verified/i),
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
        pdfTextLines.some((l) => l.startsWith("Signature Format:")),
      ).toBe(true);
    });

    // (1) Per-address "Signature Format:" line uses the BIP-322 label and the
    //     legacy label must NOT appear anywhere.
    expect(pdfTextLines).toContain(`Signature Format: ${BIP322_LABEL}`);
    expect(pdfTextLines).not.toContain(`Signature Format: ${LEGACY_LABEL}`);

    // (2) Appendix signature-box heading is the BIP-322 witness heading; the
    //     legacy heading must NOT be present.
    expect(pdfTextLines).toContain("BIP-322 Witness (base64):");
    expect(pdfTextLines).not.toContain("Wallet Signature (base64):");

    // (3) The DISCLAIMERS statement line uses the single-format BIP-322
    //     phrasing — not the legacy or combined phrasing.
    const bip322Disclaimer = pdfTextLines.find(
      (l) =>
        l.includes("proof-of-control is included") &&
        new RegExp(`via ${escapeRegExp(BIP322_LABEL)} signatures\\.`).test(l),
    );
    expect(bip322Disclaimer).toBeTruthy();
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes("proof-of-control is included") &&
          new RegExp(`via ${escapeRegExp(LEGACY_LABEL)} signatures\\.`).test(l),
      ),
    ).toBe(false);
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes("proof-of-control is included") &&
          l.includes(`${LEGACY_LABEL} and ${BIP322_LABEL} signatures`),
      ),
    ).toBe(false);
  });
});
