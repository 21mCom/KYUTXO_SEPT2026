// @vitest-environment jsdom
//
// Coverage for the re-verification instructions in the Proof of Funds
// Declaration PDF appendix.
//
// When at least one address has verified cryptographic proof-of-control, the
// PDF appends a "PROOF-OF-CONTROL EVIDENCE" appendix that now includes two
// instructional sections aimed at the institution receiving the declaration:
//   1. "HOW TO INDEPENDENTLY VERIFY" — bitcoin-cli, Electrum, and other
//      generic signed-message verifiers.
//   2. "CHALLENGE MESSAGE FORMAT" — explains the unique Declaration Reference
//      (nonce) and why the message must be supplied verbatim.
//
// These only render inside the `if (hasVerified)` branch, so a regression in
// that branch could silently drop them and no one would notice until a bank
// complained. This test seeds one valid address (offline balance), verifies a
// signature via a mocked verifier so the appendix renders, generates the PDF
// (jsPDF mocked to capture every doc.text string), and asserts:
//   (1) the "HOW TO INDEPENDENTLY VERIFY" heading and each verifier method
//       (bitcoin-cli, Electrum, other) are present;
//   (2) the "CHALLENGE MESSAGE FORMAT" heading and the nonce / Declaration
//       Reference explanation are present;
//   (3) the actual per-address challenge message embeds the nonce.
// The test fails if either new section is missing.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// Captures every string passed to doc.text() across the generated PDF so the
// test can assert which lines were emitted. splitTextToSize is the identity
// (returns the input as a single element) so multi-line paragraphs stay intact
// and can be matched with substring checks.
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

// Make the signature verifier always succeed so an address reaches the
// "verified" state and the appendix branch (hasVerified) runs.
const verifyBitcoinSignature = vi.fn(async () => ({ verified: true }));

vi.mock("@/lib/signatureVerify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/signatureVerify")>();
  return {
    ...actual,
    verifyBitcoinSignature: (...args: unknown[]) =>
      (verifyBitcoinSignature as any)(...args),
  };
});

// True when at least one captured PDF line contains the given substring.
function pdfHas(substr: string): boolean {
  return pdfTextLines.some((l) => l.includes(substr));
}

describe("ProofOfFundsDeclaration — re-verify instructions in PDF appendix", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    verifyBitcoinSignature.mockClear();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("emits the verification-instructions and challenge-format sections when an address is verified", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Required declarant details (needed to build the challenge message and
    // unlock PDF generation).
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    // Seed one valid address and run the offline balance check.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
    });

    // Paste a signature and verify it so the address reaches "verified".
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "AnyBase64SignatureHere==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(screen.getByText("Control Verified")).toBeTruthy();
    });

    // Generate the PDF.
    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    // Wait until the appendix has been written.
    await waitFor(() => {
      expect(pdfHas("APPENDIX: PROOF-OF-CONTROL EVIDENCE")).toBe(true);
    });

    // (1) "HOW TO INDEPENDENTLY VERIFY" heading and each verifier method.
    expect(pdfHas("HOW TO INDEPENDENTLY VERIFY")).toBe(true);
    expect(pdfHas("bitcoin-cli")).toBe(true);
    expect(pdfHas("verifymessage")).toBe(true);
    expect(pdfHas("Electrum")).toBe(true);
    expect(pdfHas("Sign/Verify Message")).toBe(true);
    // The generic "any other verifier" method.
    expect(pdfHas("Any other Bitcoin signed-message verifier")).toBe(true);

    // (2) "CHALLENGE MESSAGE FORMAT" heading and the nonce / Declaration
    // Reference explanation.
    expect(pdfHas("CHALLENGE MESSAGE FORMAT")).toBe(true);
    expect(pdfHas("Declaration Reference")).toBe(true);
    expect(pdfHas("nonce:")).toBe(true);
    expect(
      pdfHas("signatures cannot be silently reused for a different declaration"),
    ).toBe(true);

    // (3) The actual per-address challenge message embeds the nonce as the
    // Reference line, proving the format explanation matches what was signed.
    expect(pdfHas("Reference: ")).toBe(true);
    expect(pdfHas(`Address:   ${ADDR}`)).toBe(true);
  });
});
