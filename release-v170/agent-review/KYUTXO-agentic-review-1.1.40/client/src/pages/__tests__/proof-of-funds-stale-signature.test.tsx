// @vitest-environment jsdom
//
// Coverage for ProofOfFundsDeclaration's "declarant details changed" warning.
//
// The per-address challenge message embeds the declarant name, date, and
// purpose. When a user verifies a signature and then edits any of those fields,
// the signed message no longer matches, so the verified state is cleared back to
// idle. Previously this happened silently — the green "Control Verified" badge
// just disappeared with no explanation.
//
// This test seeds one valid address (offline balance), verifies its signature
// via a mocked verifier, then changes the declarant name and asserts:
//   (1) a visible inline warning surfaces next to the cleared address;
//   (2) the warning disappears once the signature is re-verified successfully.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

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

const verifyBitcoinSignature = vi.fn(async () => ({ verified: true }));

vi.mock("@/lib/signatureVerify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/signatureVerify")>();
  return {
    ...actual,
    verifyBitcoinSignature: (...args: unknown[]) =>
      (verifyBitcoinSignature as any)(...args),
  };
});

describe("ProofOfFundsDeclaration — stale signature warning", () => {
  beforeEach(() => {
    verifyBitcoinSignature.mockClear();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("warns when declarant details change after verification and clears on re-verify", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Fill declarant details (required to unlock Step 5 and build the challenge
    // message). The date defaults to today.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Loan application" },
    });

    // Paste a single valid address and run the offline balance check.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    // The per-address proof-of-control section appears once the row is done.
    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
    });

    // Paste a signature and verify it.
    fireEvent.change(screen.getByTestId("textarea-signature-0"), {
      target: { value: "AnyBase64SignatureHere==" },
    });
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(screen.getByText("Control Verified")).toBeTruthy();
    });

    // No stale warning yet.
    expect(screen.queryByTestId("alert-stale-0")).toBeNull();
    expect(screen.queryByTestId("badge-stale-0")).toBeNull();

    // Change the declarant name — this invalidates the signed challenge message.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Smith" },
    });

    // The verified badge is gone and a visible re-verify warning surfaces.
    await waitFor(() => {
      expect(screen.queryByText("Control Verified")).toBeNull();
      expect(screen.getByTestId("alert-stale-0")).toBeTruthy();
      expect(screen.getByTestId("badge-stale-0")).toBeTruthy();
    });
    expect(screen.getByTestId("alert-stale-0").textContent).toContain(
      "Challenge message changed",
    );

    // Re-verify the signature — the warning disappears.
    fireEvent.click(screen.getByTestId("button-verify-0"));

    await waitFor(() => {
      expect(screen.getByText("Control Verified")).toBeTruthy();
      expect(screen.queryByTestId("alert-stale-0")).toBeNull();
      expect(screen.queryByTestId("badge-stale-0")).toBeNull();
    });
  });
});
