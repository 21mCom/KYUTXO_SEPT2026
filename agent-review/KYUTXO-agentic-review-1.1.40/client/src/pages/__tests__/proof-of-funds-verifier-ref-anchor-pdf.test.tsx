// @vitest-environment jsdom
//
// Coverage for the RENDERED challenge message in the Proof-of-Control PDF
// appendix when the optional add-ons are set:
//   - a Verifier Reference (free-text request ID from the requesting party)
//   - a Block-hash Freshness Anchor (height + hash + fetched timestamp)
//
// The canonical fingerprint payload (pof-pdf-data.ts) rebuilds each verified
// address's challenge with verifierReference and freshnessAnchor. The visible
// PDF appendix (pof-pdf-section-proof-of-control.ts) builds the same challenge
// INDEPENDENTLY for display. If the display path ever dropped those fields,
// the printed challenge would no longer match what the signer actually signed
// — a third party verifying "Address + Challenge Message + Signature" from the
// PDF would get a false verification failure, even though the fingerprint is
// correct. This test pins the rendered text.
//
// Assertions:
//   (1) The captured challenge text of each verified address includes the
//       "Verifier ref: <ref>" line and the
//       "Block anchor: <height> / <hash> (fetched <ts>)" line.
//   (2) The CHALLENGE MESSAGE FORMAT explanation mentions the Verifier
//       Reference and Block Anchor (height + hash) so a reader knows they are
//       part of the signed text.
//   (3) The SAMPLE PDF (isSample guards) NEVER includes "Verifier ref:" or
//       "Block anchor:" lines, even when both add-ons are set in the UI.
//
// verifyBitcoinSignature is mocked to return verified; buildChallengeMessage /
// signatureFormatLabel stay real so the rendered challenge text is exercised
// exactly as shipped. The freshness anchor is fetched through a mocked
// blockchain provider (getBlockHeight/getTipBlockHash) via the real switch.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const LEGACY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TAPROOT_ADDR =
  "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";

const VERIFIER_REF = "ACME Bank request #2026-777";
const ANCHOR_HEIGHT = 850_000;
const ANCHOR_HASH =
  "00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054";

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

// Freshness anchor is fetched via the node provider when the switch is
// toggled on — stub only provider construction so the real toggle flow runs.
vi.mock("@/lib/blockchain-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    createProviderFromSettings: vi.fn(() => ({
      getBlockHeight: vi.fn(async () => ANCHOR_HEIGHT),
      getTipBlockHash: vi.fn(async () => ANCHOR_HASH),
    })),
  };
});

// Keep signatureFormatLabel / buildChallengeMessage real; only stub the
// actual cryptographic verification.
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

describe("ProofOfFundsDeclaration — verifier reference + block anchor in printed challenge", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("prints both add-on lines in the real challenge text and excludes them from the sample PDF", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed BOTH addresses and resolve balances so two "done" rows exist.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: `${LEGACY_ADDR}\n${TAPROOT_ADDR}` },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Declarant fields — filled BEFORE verifying so the challenge message is
    // final and verified state is not reset as stale.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    // Open the optional add-ons panel; set the verifier reference and the
    // freshness anchor BEFORE verifying (they are part of the signed text).
    fireEvent.click(screen.getByTestId("button-proof-addons-toggle"));
    fireEvent.change(screen.getByTestId("input-verifier-reference"), {
      target: { value: VERIFIER_REF },
    });
    fireEvent.click(screen.getByTestId("switch-freshness-anchor"));

    // The mocked provider resolves the anchor; wait until it is displayed.
    await waitFor(() => {
      expect(screen.getByText(`Height: ${ANCHOR_HEIGHT}`)).toBeTruthy();
    });

    // Verify BOTH addresses.
    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
      expect(screen.getByTestId("textarea-signature-1")).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "legacy-signature-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));
    fireEvent.change(screen.getByTestId("textarea-signature-1"), {
      target: { value: "bip322-witness-base64==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-1"));

    await waitFor(() => {
      expect(
        screen.getByText(/2 of 2 addresses control-verified/i),
      ).toBeTruthy();
    });

    // Generate the REAL PDF.
    const pdfButton = screen.getByTestId(
      "button-generate-pdf",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(
        pdfTextLines.some((l) => l.includes("Challenge Message:")),
      ).toBe(true);
    });

    // (1) Each verified address's rendered challenge includes BOTH add-on
    // lines. splitTextToSize is identity-mocked, so the full multi-line
    // challenge arrives as one captured string containing the address.
    const verifierLine = `Verifier ref: ${VERIFIER_REF}`;
    const anchorLinePrefix = `Block anchor: ${ANCHOR_HEIGHT} / ${ANCHOR_HASH} (fetched `;
    for (const addr of [LEGACY_ADDR, TAPROOT_ADDR]) {
      const challenge = pdfTextLines.find(
        (l) => l.includes(addr) && l.includes("Verifier ref:"),
      );
      expect(challenge, `challenge text for ${addr}`).toBeTruthy();
      expect(challenge).toContain(verifierLine);
      expect(challenge).toContain(anchorLinePrefix);
    }

    // (2) The CHALLENGE MESSAGE FORMAT explanation covers both add-ons.
    const explanation = pdfTextLines.find((l) =>
      l.includes("The Challenge Message is the human-readable text"),
    );
    expect(explanation).toBeTruthy();
    expect(explanation).toContain(`Verifier Reference: "${VERIFIER_REF}"`);
    expect(explanation).toContain(
      `Block Anchor: height ${ANCHOR_HEIGHT}, hash ${ANCHOR_HASH}`,
    );

    // (3) The SAMPLE PDF must exclude both lines even though both add-ons are
    // set in the UI (isSample guards strip them).
    pdfTextLines.length = 0;
    fireEvent.click(screen.getByTestId("button-generate-sample-pdf"));

    await waitFor(() => {
      expect(
        pdfTextLines.some((l) => l.includes("Challenge Message:")),
      ).toBe(true);
    });

    expect(pdfTextLines.some((l) => l.includes("Verifier ref:"))).toBe(false);
    expect(pdfTextLines.some((l) => l.includes("Block anchor:"))).toBe(false);
    expect(pdfTextLines.some((l) => l.includes("Verifier Reference:"))).toBe(
      false,
    );
    expect(pdfTextLines.some((l) => l.includes("Block Anchor: height"))).toBe(
      false,
    );
  });
});
