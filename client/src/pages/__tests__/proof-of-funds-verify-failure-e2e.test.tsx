// @vitest-environment jsdom
//
// End-to-end coverage for the FAILURE path of the Proof of Funds Declaration
// page's signature verification, exercised through the REAL verifier (no mock
// of verifyBitcoinSignature).
//
// The success path is covered in proof-of-funds-bc1q-bip322-e2e.test.tsx. This
// is the security-critical other half: when a user pastes a signature that does
// NOT prove control of the address — a valid signature for a different address,
// or a structurally corrupt/truncated signature — the page must fail closed.
// It must show the "Verification Failed" badge, surface a readable error alert,
// and NEVER show "Control Verified" / "Signature verified".
//
// We mock ONLY buildChallengeMessage so the genuine legacy fixture signature is
// verified against the exact message it was produced over — making the first
// case a true "valid signature, wrong address" failure (the signature really is
// cryptographically valid, it just doesn't belong to the seeded address). The
// real verifyBitcoinSignature stays in place so the full UI → verifier pipeline
// is exercised for real.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

// Genuine legacy Bitcoin Signed Message (BIP-137) signature — cryptographically
// valid, produced over LEGACY_MSG for LEGACY_ADDR. We deliberately verify it
// against a DIFFERENT address below to exercise the wrong-address failure.
const LEGACY_ADDR = "bc1qwe7rk7w29xsfttcfrr2s35qk8w880j9vrlfkf0";
const LEGACY_MSG = "I certify that I control the following Bitcoin address.";
const LEGACY_SIG =
  "IIxtBxuNMtMv+9gSBmfkRFo9NrgfyOlw8cVSJhg0eT6NClVBzBhGGzxhbkqYXktBs+V7ATt/2/Afm+GHQrBmscI=";

// A different valid bc1q address that the genuine signature above does NOT
// control. Seeding this address and pasting LEGACY_SIG must fail.
const OTHER_ADDR = "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l";

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
// exact text the genuine fixture signature was produced over. This makes the
// "wrong address" case a true cryptographically-valid-but-wrong-address failure
// rather than merely a message mismatch.
vi.mock("@/lib/signatureVerify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/signatureVerify")>();
  return {
    ...actual,
    buildChallengeMessage: () => LEGACY_MSG,
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

describe("ProofOfFundsDeclaration — signature verification FAILURE path (E2E, real verifier)", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("fails closed when a valid signature is pasted for the WRONG address", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );
    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed an address the genuine LEGACY_SIG does not control.
    await seedAddressAndOpenControl(OTHER_ADDR);

    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: LEGACY_SIG },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    // The "Verification Failed" badge must appear.
    await waitFor(() => {
      expect(screen.getByText("Verification Failed")).toBeTruthy();
    });

    // A readable error alert must be surfaced.
    const alerts = await screen.findAllByRole("alert");
    const errorAlert = alerts.find((el) =>
      (el.textContent ?? "").trim().length > 0,
    );
    expect(errorAlert).toBeTruthy();
    expect((errorAlert!.textContent ?? "").trim().length).toBeGreaterThan(0);

    // The success states must NEVER appear.
    expect(screen.queryByText("Control Verified")).toBeNull();
    expect(screen.queryByText(/Signature verified/)).toBeNull();
  });

  it("fails closed (no crash) when a corrupt/truncated signature is pasted", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );
    renderWithProviders(<ProofOfFundsDeclaration />);

    await seedAddressAndOpenControl(OTHER_ADDR);

    // A structurally-invalid / truncated signature — not a parseable witness
    // and not a 65-byte legacy signature. The verifier must reject it without
    // throwing an uncaught error.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "IIxtBxuNMtMv+9gSBmfk" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(screen.getByText("Verification Failed")).toBeTruthy();
    });

    const alerts = await screen.findAllByRole("alert");
    const errorAlert = alerts.find((el) =>
      (el.textContent ?? "").trim().length > 0,
    );
    expect(errorAlert).toBeTruthy();
    expect((errorAlert!.textContent ?? "").trim().length).toBeGreaterThan(0);

    expect(screen.queryByText("Control Verified")).toBeNull();
    expect(screen.queryByText(/Signature verified/)).toBeNull();
  });
});
