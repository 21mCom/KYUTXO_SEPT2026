// @vitest-environment jsdom
//
// Coverage for the PARTIAL proof-of-control disclaimer branch — the case where
// SOME but not all declared addresses are cryptographically control-verified.
//
// When only a subset is verified, the generated PDF disclaimer must read:
//   "Cryptographic proof-of-control is included for N of M address(es) via
//    <formats>. The remaining addresses are self-declared."
// (the `hasVerified && !allVerified` branch around ProofOfFundsDeclaration.tsx
// line 879-883). A regression in the N/M count, the singular/plural handling,
// or the "remaining addresses are self-declared" wording would understate or
// overstate how many addresses are actually proven — materially misleading in
// an evidence document.
//
// This test resolves balances for THREE addresses, verifies only TWO of them
// (one legacy P2PKH, one Taproot BIP-322), leaves the third self-declared, then
// generates the PDF (jsPDF is mocked so every doc.text(...) string is captured)
// and asserts:
//   (1) the disclaimer reports "for 2 of 3 addresses" (correct N of M, plural);
//   (2) the disclaimer contains "The remaining addresses are self-declared.";
//   (3) the all-verified phrasing ("for all addresses") is NOT used;
//   (4) the appendix only contains "Address:" entries for the two VERIFIED
//       addresses — the self-declared address never appears in the appendix.
//
// verifyBitcoinSignature is mocked to return verified with a format derived
// from the address prefix; signatureFormatLabel / buildChallengeMessage stay
// real so the disclaimer + appendix text is exercised exactly as shipped.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

// Two addresses we will verify (legacy + taproot) and one we leave unverified.
const LEGACY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TAPROOT_ADDR =
  "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";
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

// Keep signatureFormatLabel / buildChallengeMessage / generateDeclarationNonce
// real; only stub the actual cryptographic verification. The format is derived
// from the address type, exactly as the real verifier would report it.
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

describe("ProofOfFundsDeclaration — partial proof-of-control PDF", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("reports 'N of M' verified, 'remaining self-declared', and appendix only for the verified subset", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed all THREE addresses and resolve their balances so three "done" rows
    // exist. doneRows preserve input order: 0 = legacy, 1 = taproot, 2 = self.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: {
        value: `${LEGACY_ADDR}\n${TAPROOT_ADDR}\n${SELF_DECLARED_ADDR}`,
      },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Required declarant fields — filled BEFORE verifying so the challenge
    // message is final and verified state is not reset as stale.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    // Step 5 verify UI renders one signature box per address.
    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
      expect(screen.getByTestId("textarea-signature-1")).toBeTruthy();
      expect(screen.getByTestId("textarea-signature-2")).toBeTruthy();
    });

    // Verify ONLY the first two addresses; leave idx 2 (self-declared) alone.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "legacy-signature-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));
    fireEvent.change(screen.getByTestId("textarea-signature-1"), {
      target: { value: "bip322-witness-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-1"));

    // Exactly two of three addresses should report control-verified.
    await waitFor(() => {
      expect(
        screen.getByText(/2 of 3 addresses control-verified/i),
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

    // (1) Disclaimer reports the correct N of M count with plural "addresses".
    const partialDisclaimer = pdfTextLines.find(
      (l) =>
        l.includes("proof-of-control is included") &&
        l.includes("for 2 of 3 addresses"),
    );
    expect(partialDisclaimer).toBeTruthy();

    // (2) Disclaimer states the remaining addresses are self-declared.
    expect(partialDisclaimer!).toContain(
      "The remaining addresses are self-declared.",
    );

    // (3) The all-verified phrasing must NOT be used for a partial set.
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes("proof-of-control is included") &&
          l.includes("for all addresses"),
      ),
    ).toBe(false);
    // Nor the "No cryptographic proof-of-control" (none-verified) phrasing.
    expect(
      pdfTextLines.some((l) =>
        l.includes("No cryptographic proof-of-control is included"),
      ),
    ).toBe(false);

    // (4) Appendix contains entries ONLY for the two verified addresses.
    expect(pdfTextLines).toContain(`Address: ${LEGACY_ADDR}`);
    expect(pdfTextLines).toContain(`Address: ${TAPROOT_ADDR}`);
    expect(pdfTextLines).not.toContain(`Address: ${SELF_DECLARED_ADDR}`);
  });
});
