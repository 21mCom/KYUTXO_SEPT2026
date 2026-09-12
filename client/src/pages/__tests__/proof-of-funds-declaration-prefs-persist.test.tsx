// @vitest-environment jsdom
//
// Coverage for persisting the Step 9 (attestation) and Step 10 (glossary)
// declaration preferences to localStorage so they are restored on the next
// page load instead of resetting to off every time.
//
// Verifies:
//   (1) toggling the attestation/glossary switches and typing the attestation
//       place/witness inputs writes the preferences to localStorage;
//   (2) re-mounting the page restores those preferences from localStorage;
//   (3) a fresh load with no stored preferences defaults everything to off/empty;
//   (4) corrupt stored JSON falls back to the safe defaults.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

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

const PREFS_KEY = "kyutxo.proofOfFunds.declarationPrefs";

describe("ProofOfFundsDeclaration — attestation/glossary prefs persist", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("defaults everything off/empty when nothing is stored", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    expect(
      (screen.getByTestId("switch-include-attestation") as HTMLButtonElement)
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      (screen.getByTestId("switch-include-glossary") as HTMLButtonElement)
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      (screen.getByTestId("switch-include-intro") as HTMLButtonElement)
        .getAttribute("aria-checked"),
    ).toBe("false");
    // The place/witness inputs are only shown when attestation is on, so they
    // should not be present in the default off state.
    expect(screen.queryByTestId("input-attestation-place")).toBeNull();
  });

  it("writes preferences to localStorage as the user toggles/types", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.click(screen.getByTestId("switch-include-attestation"));
    fireEvent.click(screen.getByTestId("switch-include-glossary"));
    fireEvent.click(screen.getByTestId("switch-include-intro"));

    fireEvent.change(screen.getByTestId("input-attestation-place"), {
      target: { value: "London, United Kingdom" },
    });
    fireEvent.change(screen.getByTestId("input-attestation-witness"), {
      target: { value: "John Smith, Solicitor" },
    });

    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    expect(stored).toEqual({
      includeIntro: true,
      includeAttestation: true,
      attestationPlaceOfSigning: "London, United Kingdom",
      attestationWitnessLine: "John Smith, Solicitor",
      includeGlossary: true,
      includeQr: false,
      qrExplorerId: "mempool",
      includeProvenance: false,
      provenanceFiatCurrency: "USD",
      fiatCurrency: "USD",
      fiatRate: "",
      includeAml: false,
    });
  });

  it("restores preferences from localStorage on a fresh mount", async () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        includeIntro: true,
        includeAttestation: true,
        attestationPlaceOfSigning: "Berlin, Germany",
        attestationWitnessLine: "Jane Doe, Notary",
        includeGlossary: true,
      }),
    );

    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    expect(
      screen
        .getByTestId("switch-include-attestation")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("switch-include-glossary")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("switch-include-intro")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (screen.getByTestId("input-attestation-place") as HTMLInputElement).value,
    ).toBe("Berlin, Germany");
    expect(
      (screen.getByTestId("input-attestation-witness") as HTMLInputElement)
        .value,
    ).toBe("Jane Doe, Notary");
  });

  it("falls back to defaults when stored JSON is corrupt", async () => {
    localStorage.setItem(PREFS_KEY, "{ not valid json");

    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    expect(
      screen
        .getByTestId("switch-include-attestation")
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("switch-include-glossary")
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("switch-include-intro")
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});
