// @vitest-environment jsdom
//
// Coverage for the format-specific labelling that appears once an address is
// verified with a particular signature scheme (ControlState.verifiedFormat).
//
// When a declaration mixes legacy-verified and BIP-322-verified addresses, the
// generated PDF must label each one correctly and the disclaimer must use the
// combined-format phrasing. A regression here would silently mislabel evidence
// in the exported document.
//
// This test verifies one legacy (P2PKH) address and one Taproot (BIP-322)
// address, then generates the PDF (jsPDF is mocked so every `doc.text(...)`
// string is captured) and asserts:
//   (1) the per-address "Signature Format:" line uses the correct human label
//       for each format (Bitcoin Signed Message vs BIP-322);
//   (2) the appendix signature-box heading switches between
//       "Wallet Signature (base64):" and "BIP-322 Witness (base64):";
//   (3) the DISCLAIMERS section uses the combined
//       "Bitcoin Signed Message and BIP-322 signatures" phrasing.
//
// verifyBitcoinSignature is mocked to return verified with a format derived
// from the address prefix; signatureFormatLabel and buildChallengeMessage stay
// real so the labels and disclaimer text are exercised exactly as shipped.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { signatureFormatLabel } from "@/lib/signatureVerify";
import {
  WALLET_SIGNATURE_HEADING,
  BIP322_WITNESS_HEADING,
  CONTROL_INCLUDED_FRAGMENT,
  REMAINING_SELF_DECLARED_FRAGMENT,
  ALL_ADDRESSES_FRAGMENT,
  NO_CONTROL_DISCLAIMER_LINE,
  buildFormatPhrase,
  buildControlDisclaimerLine,
  viaFormatPhrase,
} from "@/pages/proof-of-funds/pof-pdf-strings";

// Expected labels derive from the real signatureFormatLabel so a deliberate
// wording change doesn't cascade into false failures here; the exact wording
// is pinned once in client/src/lib/signatureVerify.test.ts. The appendix
// headings and disclaimer scaffolding come from pof-pdf-strings, and their
// exact wording is pinned by the dedicated test at the bottom of this file.
const LEGACY_LABEL = signatureFormatLabel("legacy");
const BIP322_LABEL = signatureFormatLabel("bip322");
const COMBINED_PHRASE = buildFormatPhrase(new Set(["legacy", "bip322"]));
const LEGACY_VIA = viaFormatPhrase(buildFormatPhrase(new Set(["legacy"])));
const BIP322_VIA = viaFormatPhrase(buildFormatPhrase(new Set(["bip322"])));

// A legacy P2PKH address and a mainnet Taproot (P2TR) address.
const LEGACY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
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

describe("ProofOfFundsDeclaration — mixed-format proof-of-control PDF", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("labels each verified address by its format and uses combined disclaimer phrasing", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed both addresses and resolve their balances so two "done" rows exist.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: `${LEGACY_ADDR}\n${TAPROOT_ADDR}` },
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

    // Paste a (mock-accepted) signature for each address and verify it.
    // doneRows preserve input order: idx 0 = legacy, idx 1 = taproot.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "legacy-signature-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));
    fireEvent.change(screen.getByTestId("textarea-signature-1"), {
      target: { value: "bip322-witness-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-1"));

    // Both addresses should report as control-verified.
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
        pdfTextLines.some((l) => l.startsWith("Signature Format:")),
      ).toBe(true);
    });

    // (1) Per-address "Signature Format:" lines — one per scheme, correct label.
    expect(pdfTextLines).toContain(`Signature Format: ${LEGACY_LABEL}`);
    // The BIP-322 label covers both Simple (single-key) and Full
    // (script-path / multisig) witnesses.
    expect(pdfTextLines).toContain(`Signature Format: ${BIP322_LABEL}`);

    // (2) Appendix signature-box headings switch on format.
    expect(pdfTextLines).toContain(WALLET_SIGNATURE_HEADING);
    expect(pdfTextLines).toContain(BIP322_WITNESS_HEADING);

    // (3) Disclaimer uses the combined-format phrasing for the mixed set.
    const combinedDisclaimer = pdfTextLines.find(
      (l) =>
        l.includes(CONTROL_INCLUDED_FRAGMENT) && l.includes(COMBINED_PHRASE),
    );
    expect(combinedDisclaimer).toBeTruthy();
    // The single-format phrasings must NOT be the one used here.
    expect(
      pdfTextLines.some(
        (l) => l.includes(CONTROL_INCLUDED_FRAGMENT) && l.includes(BIP322_VIA),
      ),
    ).toBe(false);
    expect(
      pdfTextLines.some(
        (l) => l.includes(CONTROL_INCLUDED_FRAGMENT) && l.includes(LEGACY_VIA),
      ),
    ).toBe(false);
  });

  // ── Exact-wording pin ─────────────────────────────────────────────────────
  // The ONE place the exact appendix-heading and disclaimer wording is pinned.
  // Every other PDF test derives its expectations from pof-pdf-strings, so a
  // deliberate wording change means updating pof-pdf-strings.ts plus this test
  // only — no cascade of hand-edits across the suite.
  it("pins the exact appendix-heading and disclaimer wording", () => {
    expect(WALLET_SIGNATURE_HEADING).toBe("Wallet Signature (base64):");
    expect(BIP322_WITNESS_HEADING).toBe("BIP-322 Witness (base64):");
    expect(CONTROL_INCLUDED_FRAGMENT).toBe("proof-of-control is included");
    expect(REMAINING_SELF_DECLARED_FRAGMENT).toBe(
      "The remaining addresses are self-declared",
    );
    expect(ALL_ADDRESSES_FRAGMENT).toBe("for all addresses");
    expect(NO_CONTROL_DISCLAIMER_LINE).toBe(
      "2. No cryptographic proof-of-control is included. All addresses are self-declared by the declarant.",
    );

    expect(buildFormatPhrase(new Set(["legacy"]))).toBe(
      "Bitcoin Signed Message signatures",
    );
    expect(buildFormatPhrase(new Set(["bip322"]))).toBe("BIP-322 signatures");
    expect(buildFormatPhrase(new Set(["legacy", "bip322"]))).toBe(
      "Bitcoin Signed Message and BIP-322 signatures",
    );

    expect(
      buildControlDisclaimerLine({
        allVerified: true,
        hasVerified: true,
        verifiedCount: 2,
        totalCount: 2,
        formatPhrase: COMBINED_PHRASE,
      }),
    ).toBe(
      "2. Cryptographic proof-of-control is included for all addresses via Bitcoin Signed Message and BIP-322 signatures. An appendix contains the challenge messages and signatures for independent re-verification.",
    );
    expect(
      buildControlDisclaimerLine({
        allVerified: false,
        hasVerified: true,
        verifiedCount: 1,
        totalCount: 2,
        formatPhrase: buildFormatPhrase(new Set(["legacy"])),
      }),
    ).toBe(
      "2. Cryptographic proof-of-control is included for 1 of 2 addresses via Bitcoin Signed Message signatures. The remaining addresses are self-declared. An appendix contains the challenge messages and signatures for verified addresses.",
    );
    expect(
      buildControlDisclaimerLine({
        allVerified: false,
        hasVerified: false,
        verifiedCount: 0,
        totalCount: 2,
        formatPhrase: buildFormatPhrase(new Set()),
      }),
    ).toBe(NO_CONTROL_DISCLAIMER_LINE);
  });
});
