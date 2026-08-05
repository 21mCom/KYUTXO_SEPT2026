// @vitest-environment jsdom
//
// Coverage for the FULLY-VERIFIED proof-of-control disclaimer branch — the case
// where EVERY declared address is cryptographically control-verified.
//
// When all addresses are verified, the generated PDF disclaimer must read:
//   "Cryptographic proof-of-control is included for all addresses via
//    <formats>. ..."
// (the `allVerified` branch around ProofOfFundsDeclaration.tsx line 1223-1224).
// A regression that flips the all/partial branch could silently claim
// "for all addresses" when only some are verified, or — as guarded here —
// understate a fully-verified set with the "N of M" / "remaining addresses are
// self-declared" partial wording. Either is materially misleading in an
// evidence document.
//
// This test resolves balances for TWO addresses, verifies BOTH of them (one
// legacy P2PKH, one Taproot BIP-322), then generates the PDF (jsPDF is mocked so
// every doc.text(...) string is captured) and asserts:
//   (1) the disclaimer reads "for all addresses" (the all-verified phrasing);
//   (2) the disclaimer does NOT contain the "N of M" partial count wording;
//   (3) the disclaimer does NOT contain "The remaining addresses are
//       self-declared." (the partial branch tail);
//   (4) the disclaimer does NOT use the none-verified phrasing.
//
// verifyBitcoinSignature is mocked to return verified with a format derived
// from the address prefix; signatureFormatLabel / buildChallengeMessage stay
// real so the disclaimer text is exercised exactly as shipped.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import {
  CONTROL_INCLUDED_FRAGMENT,
  ALL_ADDRESSES_FRAGMENT,
  REMAINING_SELF_DECLARED_FRAGMENT,
  NO_CONTROL_DISCLAIMER_LINE,
} from "@/pages/proof-of-funds/pof-pdf-strings";

// The disclaimer scaffolding comes from pof-pdf-strings; its exact wording is
// pinned once in proof-of-funds-mixed-format-pdf.test.tsx, so a deliberate
// wording change doesn't cascade into false failures here.

// One legacy P2PKH address and one mainnet Taproot (P2TR) address — both verified.
const LEGACY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TAPROOT_ADDR =
  "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";

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

describe("ProofOfFundsDeclaration — fully-verified proof-of-control PDF", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("reports 'for all addresses' and never the partial / none-verified wording", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed BOTH addresses and resolve their balances so two "done" rows exist.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: {
        value: `${LEGACY_ADDR}\n${TAPROOT_ADDR}`,
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
    });

    // Verify BOTH addresses.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "legacy-signature-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));
    fireEvent.change(screen.getByTestId("textarea-signature-1"), {
      target: { value: "bip322-witness-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-1"));

    // Both addresses should report control-verified.
    await waitFor(() => {
      expect(
        screen.getByText(/2 of 2 addresses control-verified/i),
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
        pdfTextLines.some((l) => l.includes(CONTROL_INCLUDED_FRAGMENT)),
      ).toBe(true);
    });

    // (1) Disclaimer uses the all-verified phrasing.
    const allVerifiedDisclaimer = pdfTextLines.find(
      (l) =>
        l.includes(CONTROL_INCLUDED_FRAGMENT) &&
        l.includes(ALL_ADDRESSES_FRAGMENT),
    );
    expect(allVerifiedDisclaimer).toBeTruthy();

    // (2) The partial "N of M" count wording must NOT appear.
    expect(
      pdfTextLines.some((l) => /for \d+ of \d+ address/.test(l)),
    ).toBe(false);

    // (3) The partial tail "remaining addresses are self-declared" must NOT appear.
    expect(
      pdfTextLines.some((l) => l.includes(REMAINING_SELF_DECLARED_FRAGMENT)),
    ).toBe(false);

    // (4) The none-verified phrasing must NOT appear.
    expect(pdfTextLines).not.toContain(NO_CONTROL_DISCLAIMER_LINE);
  });
});
