// @vitest-environment jsdom
//
// Coverage for the optional declarant identity inputs in the Proof of Funds
// Declaration form (the on-screen inputs, not the PDF output).
//
// Five optional identity fields (Residential/Street Address, Date of Birth,
// Tax ID Number, Identification Number, Nationality) have form inputs. This
// test verifies each input is a correctly wired controlled input:
//   (1) typing into each input reflects its own value on screen;
//   (2) the inputs are independent — writing one never bleeds into another
//       (no cross-binding to the wrong state setter);
//   (3) clearing a field resets it back to empty.

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

// The five optional identity inputs and a distinct value for each.
const IDENTITY_FIELDS = [
  {
    testid: "input-declarant-residential-address",
    value: "221B Baker Street, London",
  },
  { testid: "input-declarant-dob", value: "1990-04-15" },
  { testid: "input-declarant-tax-id", value: "TAX-998877" },
  { testid: "input-declarant-id-number", value: "P1234567" },
  { testid: "input-declarant-nationality", value: "British" },
] as const;

describe("ProofOfFundsDeclaration — optional identity inputs are controlled", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("binds each input to its own value with no cross-binding", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Type into every optional identity input.
    for (const field of IDENTITY_FIELDS) {
      fireEvent.change(screen.getByTestId(field.testid), {
        target: { value: field.value },
      });
    }

    // Each input reflects ONLY its own typed value — proves each onChange is
    // wired to the correct state setter and the inputs are independent.
    for (const field of IDENTITY_FIELDS) {
      const input = screen.getByTestId(field.testid) as HTMLInputElement;
      expect(input.value).toBe(field.value);
    }
  });

  it("does not leak a value into the other identity inputs", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Type into just one field and confirm the other four remain empty.
    for (const target of IDENTITY_FIELDS) {
      // Reset all inputs to empty before isolating this one.
      for (const field of IDENTITY_FIELDS) {
        fireEvent.change(screen.getByTestId(field.testid), {
          target: { value: "" },
        });
      }

      fireEvent.change(screen.getByTestId(target.testid), {
        target: { value: target.value },
      });

      for (const field of IDENTITY_FIELDS) {
        const input = screen.getByTestId(field.testid) as HTMLInputElement;
        if (field.testid === target.testid) {
          expect(input.value).toBe(target.value);
        } else {
          expect(input.value).toBe("");
        }
      }
    }
  });

  it("clears a field back to empty", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    for (const field of IDENTITY_FIELDS) {
      const input = screen.getByTestId(field.testid) as HTMLInputElement;

      fireEvent.change(input, { target: { value: field.value } });
      expect(input.value).toBe(field.value);

      fireEvent.change(input, { target: { value: "" } });
      expect(input.value).toBe("");
    }
  });
});
