// @vitest-environment jsdom
//
// Regression test for the manual freshness-anchor fallback input validation.
//
// The manual block height + hash fallback (shown when the provider can't fetch
// the tip hash) must reject obviously invalid data before it gets embedded in
// the signed challenge message:
//   1. The Apply button is disabled until the height is a positive whole number
//      AND the hash is exactly 64 lowercase hex characters.
//   2. A malformed hash / non-numeric or negative height surfaces an inline
//      error and keeps Apply disabled.
//   3. Valid inputs enable Apply and set the anchor.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

import { renderWithProviders } from "@/test/testProviders";

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: { id: "default", providerType: "mempool-space" } }),
}));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [], isLoading: false }) }));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [], isLoading: false }),
}));

const getBlockHeight = vi.fn(async () => 800000);
const getAddressCoreStats = vi.fn(async () => ({
  txCount: 1,
  receivedSats: 5000,
  sentSats: 0,
  balanceSats: 5000,
}));
// Provider WITHOUT getTipBlockHash → fetchFreshnessAnchor throws → manual entry appears.
const createProviderFromSettings = vi.fn(() => ({ getBlockHeight, getAddressCoreStats }));

vi.mock("@/lib/blockchain-api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    createProviderFromSettings: (...a: unknown[]) => createProviderFromSettings(...a),
  };
});

import ProofOfFundsDeclaration from "./ProofOfFundsDeclaration";

const VALID_HASH = "00000000000000000000a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6";

const ADDR_A = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

async function openManualEntry() {
  renderWithProviders(<ProofOfFundsDeclaration />);

  // Step 2: run a live balance check so the proof-of-control step unlocks.
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: ADDR_A },
  });
  fireEvent.click(screen.getByTestId("button-source-live"));
  fireEvent.click(screen.getByTestId("button-check-balances"));
  await waitFor(() => {
    expect(screen.getByTestId("button-reset")).toBeTruthy();
  });

  // Step 3: complete declarant info so the challenge message can be built.
  fireEvent.change(screen.getByTestId("input-declarant-name"), {
    target: { value: "Jane Doe" },
  });
  fireEvent.change(screen.getByTestId("input-declaration-date"), {
    target: { value: "2026-06-30" },
  });
  fireEvent.change(screen.getByTestId("input-purpose"), {
    target: { value: "Proof of funds" },
  });

  // Expand the collapsed "Optional add-ons" section that holds the anchor.
  await waitFor(() => {
    expect(screen.getByTestId("button-proof-addons-toggle")).toBeTruthy();
  });
  fireEvent.click(screen.getByTestId("button-proof-addons-toggle"));

  // Enable the freshness anchor; provider can't fetch tip hash → manual entry appears.
  await waitFor(() => {
    expect(screen.getByTestId("switch-freshness-anchor")).toBeTruthy();
  });
  fireEvent.click(screen.getByTestId("switch-freshness-anchor"));
  await waitFor(() => {
    expect(screen.getByTestId("input-freshness-manual-hash")).toBeTruthy();
  });
}

describe("ProofOfFundsDeclaration — manual freshness anchor validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBlockHeight.mockResolvedValue(800000);
    cleanup();
  });

  it("keeps Apply disabled and shows an error for an invalid hash", async () => {
    await openManualEntry();

    fireEvent.change(screen.getByTestId("input-freshness-manual-height"), {
      target: { value: "800000" },
    });
    fireEvent.change(screen.getByTestId("input-freshness-manual-hash"), {
      target: { value: "not-a-real-hash" },
    });

    expect(screen.getByTestId("error-freshness-manual-hash")).toBeTruthy();
    expect(
      (screen.getByTestId("button-apply-manual-freshness") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("rejects an uppercase hex hash (must be lowercase, exactly 64 chars)", async () => {
    await openManualEntry();

    fireEvent.change(screen.getByTestId("input-freshness-manual-height"), {
      target: { value: "800000" },
    });
    fireEvent.change(screen.getByTestId("input-freshness-manual-hash"), {
      target: { value: VALID_HASH.toUpperCase() },
    });

    expect(screen.getByTestId("error-freshness-manual-hash")).toBeTruthy();
    expect(
      (screen.getByTestId("button-apply-manual-freshness") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows an inline error for a non-numeric or negative height", async () => {
    await openManualEntry();

    fireEvent.change(screen.getByTestId("input-freshness-manual-hash"), {
      target: { value: VALID_HASH },
    });

    fireEvent.change(screen.getByTestId("input-freshness-manual-height"), {
      target: { value: "abc" },
    });
    expect(screen.getByTestId("error-freshness-manual-height")).toBeTruthy();
    expect(
      (screen.getByTestId("button-apply-manual-freshness") as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(screen.getByTestId("input-freshness-manual-height"), {
      target: { value: "-5" },
    });
    expect(screen.getByTestId("error-freshness-manual-height")).toBeTruthy();
    expect(
      (screen.getByTestId("button-apply-manual-freshness") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("enables Apply and sets the anchor for valid inputs", async () => {
    await openManualEntry();

    fireEvent.change(screen.getByTestId("input-freshness-manual-height"), {
      target: { value: "800000" },
    });
    fireEvent.change(screen.getByTestId("input-freshness-manual-hash"), {
      target: { value: VALID_HASH },
    });

    expect(screen.queryByTestId("error-freshness-manual-hash")).toBeNull();
    expect(screen.queryByTestId("error-freshness-manual-height")).toBeNull();

    const applyBtn = screen.getByTestId("button-apply-manual-freshness") as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);

    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(screen.getByText("Block anchor set")).toBeTruthy();
    });
    expect(screen.getByText(`Hash: ${VALID_HASH}`)).toBeTruthy();
  });
});
