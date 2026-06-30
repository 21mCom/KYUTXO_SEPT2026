// @vitest-environment jsdom
//
// Middle-case coverage for the Proof of Funds Declaration PDF.
//
// Two companion tests already pin the extremes:
//   - proof-of-funds-verify-instructions-pdf.test.tsx (ALL addresses verified)
//   - proof-of-funds-no-verify-appendix-omitted.test.tsx (NONE verified)
//
// The partially-verified case — some addresses cryptographically verified, the
// rest self-declared — is the one most likely to mislead a bank if it
// regresses. The disclaimer for this case (generatePdf, the
// `hasVerified && !allVerified` branch) must report the correct verified/total
// counts ("X of N addresses") AND still flag the remaining addresses as
// self-declared. Likewise, the "APPENDIX: PROOF-OF-CONTROL EVIDENCE" section
// loops over verifiedRows only, so it must render a signature block for the
// verified address and NEVER for the self-declared one.
//
// This test seeds two valid addresses with resolved offline balances, verifies
// the signature for ONLY the first one, generates the PDF (jsPDF mocked to
// capture every doc.text string), and asserts:
//   (1) the disclaimer states "1 of 2 addresses" are verified and that the
//       remaining addresses are self-declared (not all-verified, not none);
//   (2) the disclaimer does NOT claim all addresses are verified;
//   (3) the appendix renders and contains an "Address:" heading + a verified
//       Status line for the verified address only;
//   (4) the appendix has NO per-address heading for the self-declared address.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const VERIFIED_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const SELF_DECLARED_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

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

// Make the signature verifier always succeed so the address we choose to verify
// reaches the "verified" state. We only click verify on ONE address, so only
// that one ends up verified regardless.
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

describe("ProofOfFundsDeclaration — partially-verified PDF only proves verified addresses", () => {
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

  it("reports the correct verified/total counts and only appends a signature block for the verified address", async () => {
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

    // Seed two valid addresses (one per line) and run the offline balance check.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: `${VERIFIED_ADDR}\n${SELF_DECLARED_ADDR}` },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    // Both addresses resolve to a balance and expose a signature textarea.
    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
      expect(screen.getByTestId("textarea-signature-1")).toBeTruthy();
    });

    // Verify ONLY the first address. The second stays self-declared.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "AnyBase64SignatureHere==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(screen.getByText("Control Verified")).toBeTruthy();
    });

    // Exactly one address should have been verified.
    expect(verifyBitcoinSignature).toHaveBeenCalledTimes(1);

    // Generate the PDF.
    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    // Wait until the appendix has been written (it only renders when at least
    // one address is verified).
    await waitFor(() => {
      expect(pdfHas("APPENDIX: PROOF-OF-CONTROL EVIDENCE")).toBe(true);
    });

    // (1) The disclaimer reports the correct verified/total counts and flags the
    // remaining addresses as self-declared.
    expect(
      pdfHas(
        "Cryptographic proof-of-control is included for 1 of 2 addresses",
      ),
    ).toBe(true);
    expect(pdfHas("The remaining addresses are self-declared.")).toBe(true);

    // (2) The disclaimer must NOT overstate the proof (all-verified language) or
    // understate it (none-verified language).
    expect(
      pdfHas("Cryptographic proof-of-control is included for all addresses"),
    ).toBe(false);
    expect(
      pdfHas(
        "No cryptographic proof-of-control is included. All addresses are self-declared by the declarant.",
      ),
    ).toBe(false);

    // (3) The appendix contains a per-address signature block for the verified
    // address: its heading, the verified Status line.
    // (the em-dash is sanitized to "?" for WinAnsi safety, so match around it)
    expect(pdfHas(`Address: ${VERIFIED_ADDR}`)).toBe(true);
    expect(pdfHas("Status: Control Verified")).toBe(true);
    expect(pdfHas("signature matches this address.")).toBe(true);

    // (4) The appendix has NO per-address heading for the self-declared address,
    // so it is never presented as carrying cryptographic proof-of-control.
    expect(pdfHas(`Address: ${SELF_DECLARED_ADDR}`)).toBe(false);
  });
});
