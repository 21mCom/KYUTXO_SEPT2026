// @vitest-environment jsdom
//
// Coverage for the SINGLE-format disclaimer phrasing produced by formatPhrase
// in the DISCLAIMERS section. Task #1346 covered the MIXED legacy + BIP-322
// case (combined "Bitcoin Signed Message and BIP-322 signatures" wording). The
// two single-scheme branches were still untested:
//   - every verified address is legacy  -> "via Bitcoin Signed Message signatures."
//   - every verified address is BIP-322 -> "via BIP-322 signatures."
//
// A regression in formatPhrase could silently emit the wrong wording (or even
// the combined phrasing) for a single-scheme declaration without any test
// failing. Each case verifies two addresses that share one signature scheme,
// generates the PDF (jsPDF is mocked so every `doc.text(...)` string is
// captured) and asserts:
//   (1) the per-address "Signature Format:" line uses the correct human label;
//   (2) the DISCLAIMERS line uses the matching single-format phrasing AND that
//       neither the combined phrasing nor the other single-format phrasing is
//       emitted.
//
// verifyBitcoinSignature is mocked to return verified with a format derived
// from the address prefix; signatureFormatLabel and buildChallengeMessage stay
// real so the labels and disclaimer text are exercised exactly as shipped.

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

// Two legacy P2PKH addresses and two mainnet Taproot (P2TR) addresses.
const LEGACY_ADDR_1 = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const LEGACY_ADDR_2 = "12higDjoCCNXSA95xZMWUdPvXNmkAduhWv";
const TAPROOT_ADDR_1 =
  "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";
const TAPROOT_ADDR_2 =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";

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

async function seedVerifyAndGeneratePdf(addresses: string[]) {
  const { default: ProofOfFundsDeclaration } = await import(
    "@/pages/ProofOfFundsDeclaration"
  );

  renderWithProviders(<ProofOfFundsDeclaration />);

  // Seed addresses and resolve their balances so "done" rows exist.
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: addresses.join("\n") },
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
    for (let i = 0; i < addresses.length; i++) {
      expect(screen.getByTestId(`textarea-signature-${i}`)).toBeTruthy();
    }
  });

  // Paste a (mock-accepted) signature for each address and verify it.
  for (let i = 0; i < addresses.length; i++) {
    fireEvent.change(screen.getByTestId(`textarea-signature-${i}`), {
      target: { value: `signature-base64-${i}==` },
    });
    fireEvent.click(screen.getByTestId(`button-verify-${i}`));
  }

  // All addresses should report as control-verified.
  await waitFor(() => {
    expect(
      screen.getByText(
        new RegExp(
          `${addresses.length} of ${addresses.length} addresses control-verified`,
          "i",
        ),
      ),
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
    expect(pdfTextLines.some((l) => l.startsWith("Signature Format:"))).toBe(
      true,
    );
  });
}

describe("ProofOfFundsDeclaration — single-format proof-of-control PDF", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the Bitcoin Signed Message phrasing when every address is legacy", async () => {
    await seedVerifyAndGeneratePdf([LEGACY_ADDR_1, LEGACY_ADDR_2]);

    // (1) Per-address "Signature Format:" line uses the legacy label, and the
    //     BIP-322 label is never emitted.
    expect(pdfTextLines).toContain(`Signature Format: ${LEGACY_LABEL}`);
    expect(pdfTextLines).not.toContain(`Signature Format: ${BIP322_LABEL}`);

    // (2) Disclaimer uses the single legacy phrasing.
    const legacyDisclaimer = pdfTextLines.find(
      (l) =>
        l.includes("proof-of-control is included") &&
        new RegExp(`via ${escapeRegExp(LEGACY_LABEL)} signatures\\.`).test(l),
    );
    expect(legacyDisclaimer).toBeTruthy();

    // The combined and the other single-format phrasings must NOT appear.
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes("proof-of-control is included") &&
          l.includes(`${LEGACY_LABEL} and ${BIP322_LABEL} signatures`),
      ),
    ).toBe(false);
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes("proof-of-control is included") &&
          new RegExp(`via ${escapeRegExp(BIP322_LABEL)} signatures\\.`).test(l),
      ),
    ).toBe(false);
  });

  it("uses the BIP-322 phrasing when every address is Taproot/BIP-322", async () => {
    await seedVerifyAndGeneratePdf([TAPROOT_ADDR_1, TAPROOT_ADDR_2]);

    // (1) Per-address "Signature Format:" line uses the BIP-322 label, and the
    //     legacy label is never emitted.
    expect(pdfTextLines).toContain(`Signature Format: ${BIP322_LABEL}`);
    expect(pdfTextLines).not.toContain(`Signature Format: ${LEGACY_LABEL}`);

    // (2) Disclaimer uses the single BIP-322 phrasing.
    const bip322Disclaimer = pdfTextLines.find(
      (l) =>
        l.includes("proof-of-control is included") &&
        new RegExp(`via ${escapeRegExp(BIP322_LABEL)} signatures\\.`).test(l),
    );
    expect(bip322Disclaimer).toBeTruthy();

    // The combined and the other single-format phrasings must NOT appear.
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes("proof-of-control is included") &&
          l.includes(`${LEGACY_LABEL} and ${BIP322_LABEL} signatures`),
      ),
    ).toBe(false);
    expect(
      pdfTextLines.some(
        (l) =>
          l.includes("proof-of-control is included") &&
          new RegExp(`via ${escapeRegExp(LEGACY_LABEL)} signatures\\.`).test(l),
      ),
    ).toBe(false);
  });
});
