// @vitest-environment jsdom
//
// End-to-end coverage for the Proof of Funds Declaration page's signature
// verification, exercised through the REAL verifier (no mock of
// verifyBitcoinSignature).
//
// The bc1q BIP-322 path is unit-tested at the library level, but the page where
// users actually paste a signature had not been exercised end-to-end for a
// native SegWit (bc1q) signature. This test renders the page, seeds a valid
// bc1q address with an offline balance, pastes a genuine signature into the
// per-address proof-of-control box, clicks Verify, and asserts the page shows
// the verified state with the correct on-screen format label:
//
//   (1) a real bc1q BIP-322 Simple witness verifies and shows
//       "(BIP-322 (Simple))";
//   (2) a legacy bc1q Bitcoin Signed Message (BIP-137) signature for a
//       different bc1q address still verifies and shows
//       "(Bitcoin Signed Message)".
//
// The per-address challenge message normally embeds the declarant name/date/
// purpose/nonce, so a pre-recorded signature could never match it. We mock ONLY
// buildChallengeMessage to return the exact message each fixture signature was
// produced over, while leaving the real verifyBitcoinSignature in place — so
// the full UI → verifier → format-label pipeline is exercised for real.

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

// ── Genuine signature fixtures ───────────────────────────────────────────────
// bc1q BIP-322 Simple witness over "Hello World" for the canonical BIP-322
// reference key/address (same vector used across BIP-322 reference impls and
// bip322-js). This is the format Bitcoin Core 24+ and Sparrow produce.
const BIP322_ADDR = "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l";
const BIP322_MSG = "Hello World";
const BIP322_SIG =
  "AkgwRQIhAOzyynlqt93lOKJr+wmmxIens//zPzl9tqIOua93wO6MAiBi5n5EyAcPScOjf1lAqIUIQtr3zKNeavYabHyR8eGhowEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy";

// Legacy bc1q Bitcoin Signed Message (BIP-137) signature — the 65-byte format
// produced by Electrum, Bitcoin Core, Sparrow, Trezor, Ledger, etc.
const LEGACY_ADDR = "bc1qwe7rk7w29xsfttcfrr2s35qk8w880j9vrlfkf0";
const LEGACY_MSG = "I certify that I control the following Bitcoin address.";
const LEGACY_SIG =
  "IIxtBxuNMtMv+9gSBmfkRFo9NrgfyOlw8cVSJhg0eT6NClVBzBhGGzxhbkqYXktBs+V7ATt/2/Afm+GHQrBmscI=";

const MESSAGE_FOR: Record<string, string> = {
  [BIP322_ADDR]: BIP322_MSG,
  [LEGACY_ADDR]: LEGACY_MSG,
};

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

// Keep the REAL verifyBitcoinSignature; only force the challenge message to the
// exact text each fixture signature was produced over.
vi.mock("@/lib/signatureVerify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/signatureVerify")>();
  return {
    ...actual,
    buildChallengeMessage: (params: { address: string }) =>
      MESSAGE_FOR[params.address] ?? "unmatched-message",
  };
});

async function seedAddressAndOpenControl(addr: string) {
  fireEvent.change(screen.getByTestId("input-declarant-name"), {
    target: { value: "Alice" },
  });
  fireEvent.change(screen.getByTestId("input-purpose"), {
    target: { value: "Loan application" },
  });
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: addr },
  });
  fireEvent.click(screen.getByTestId("button-check-balances"));

  await waitFor(() => {
    expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
  });
}

describe("ProofOfFundsDeclaration — bc1q signature verification (E2E, real verifier)", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("verifies a real bc1q BIP-322 Simple signature and shows the BIP-322 (Simple) format label", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );
    renderWithProviders(<ProofOfFundsDeclaration />);

    await seedAddressAndOpenControl(BIP322_ADDR);

    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: BIP322_SIG },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(screen.getByText("Control Verified")).toBeTruthy();
    });

    // The inline verified line shows the BIP-322 (Simple) format label.
    await waitFor(() => {
      expect(
        screen.getByText(
          new RegExp(`Signature verified \\(${escapeRegExp(BIP322_LABEL)}\\)`),
        ),
      ).toBeTruthy();
    });

    // No failure surfaced.
    expect(screen.queryByText("Verification Failed")).toBeNull();
  });

  it("still verifies a legacy bc1q Bitcoin Signed Message signature and shows the legacy format label", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );
    renderWithProviders(<ProofOfFundsDeclaration />);

    await seedAddressAndOpenControl(LEGACY_ADDR);

    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: LEGACY_SIG },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(screen.getByText("Control Verified")).toBeTruthy();
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          new RegExp(`Signature verified \\(${escapeRegExp(LEGACY_LABEL)}\\)`),
        ),
      ).toBeTruthy();
    });

    expect(screen.queryByText("Verification Failed")).toBeNull();
  });
});
