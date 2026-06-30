// @vitest-environment jsdom
//
// Coverage for the optional declarant identity fields in the on-screen
// Declaration Preview (the live summary rendered before the PDF is exported).
//
// The page renders a "Declaration Preview" that mirrors the PDF builder: each
// optional identity field (Residential/Street Address, Date of Birth, Tax ID
// Number, Identification Number, Nationality) only contributes a row when it is
// non-blank. A blank field must produce no label and no value — otherwise the
// on-screen preview could drift from the exported PDF.
//
// This test fills a MIX of the optional fields and leaves the others blank,
// then asserts:
//   (1) each FILLED field's label AND value render in the preview;
//   (2) each BLANK field's label appears nowhere in the preview;
//   (3) the required fields (Full Name, Declaration Date, Purpose) render.
// A second test confirms that when all optional fields are blank, none of the
// five optional labels appear in the preview.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
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

describe("ProofOfFundsDeclaration — optional identity fields in on-screen preview", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a row for each filled optional field and none for blank ones", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Required fields.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    // Fill a MIX of optional identity fields; leave DOB and ID Number blank.
    fireEvent.change(screen.getByTestId("input-declarant-residential-address"), {
      target: { value: "221B Baker Street, London" },
    });
    fireEvent.change(screen.getByTestId("input-declarant-tax-id"), {
      target: { value: "TAX-998877" },
    });
    fireEvent.change(screen.getByTestId("input-declarant-nationality"), {
      target: { value: "British" },
    });

    const preview = await screen.findByTestId("declarant-preview");

    // Required fields render with their values.
    expect(within(preview).getByTestId("preview-declarant-name").textContent).toBe(
      "Alice Example",
    );
    expect(within(preview).getByTestId("preview-declaration-date").textContent).toBe(
      "2026-06-30",
    );
    expect(within(preview).getByTestId("preview-purpose").textContent).toBe(
      "Bank account opening",
    );

    // Filled optional fields — label and value both render in the preview.
    expect(
      within(preview).getByTestId("preview-declarant-residential-address").textContent,
    ).toBe("221B Baker Street, London");
    expect(within(preview).getByTestId("preview-declarant-tax-id").textContent).toBe(
      "TAX-998877",
    );
    expect(within(preview).getByTestId("preview-declarant-nationality").textContent).toBe(
      "British",
    );
    expect(within(preview).getByText("Residential / Street Address:")).toBeTruthy();
    expect(within(preview).getByText("Tax ID Number:")).toBeTruthy();
    expect(within(preview).getByText("Nationality:")).toBeTruthy();

    // Blank optional fields — no row, no stray label, no value anywhere.
    expect(within(preview).queryByTestId("preview-declarant-dob")).toBeNull();
    expect(within(preview).queryByTestId("preview-declarant-id-number")).toBeNull();
    expect(within(preview).queryByText("Date of Birth:")).toBeNull();
    expect(within(preview).queryByText("Identification Number:")).toBeNull();
  });

  it("renders no optional identity rows when all optional fields are blank", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Only the required fields are filled — every optional identity field is left blank.
    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Bob Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Audit" },
    });

    const preview = await screen.findByTestId("declarant-preview");

    // Required fields still render.
    expect(within(preview).getByTestId("preview-declarant-name").textContent).toBe(
      "Bob Example",
    );

    // None of the five optional identity labels or values appear.
    expect(within(preview).queryByTestId("preview-declarant-residential-address")).toBeNull();
    expect(within(preview).queryByTestId("preview-declarant-dob")).toBeNull();
    expect(within(preview).queryByTestId("preview-declarant-tax-id")).toBeNull();
    expect(within(preview).queryByTestId("preview-declarant-id-number")).toBeNull();
    expect(within(preview).queryByTestId("preview-declarant-nationality")).toBeNull();
    expect(within(preview).queryByText("Residential / Street Address:")).toBeNull();
    expect(within(preview).queryByText("Date of Birth:")).toBeNull();
    expect(within(preview).queryByText("Tax ID Number:")).toBeNull();
    expect(within(preview).queryByText("Identification Number:")).toBeNull();
    expect(within(preview).queryByText("Nationality:")).toBeNull();
  });

  it("adds an identity row only after its field is filled in", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Carol Example" },
    });

    // Date of Birth starts blank → no preview row.
    let preview = await screen.findByTestId("declarant-preview");
    expect(within(preview).queryByTestId("preview-declarant-dob")).toBeNull();

    // Fill Date of Birth → its row appears with the value.
    fireEvent.change(screen.getByTestId("input-declarant-dob"), {
      target: { value: "1990-04-15" },
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("declarant-preview")).getByTestId(
          "preview-declarant-dob",
        ).textContent,
      ).toBe("1990-04-15");
    });

    // Clear it again → the row disappears (no stray label left behind).
    fireEvent.change(screen.getByTestId("input-declarant-dob"), {
      target: { value: "" },
    });
    await waitFor(() => {
      preview = screen.getByTestId("declarant-preview");
      expect(within(preview).queryByTestId("preview-declarant-dob")).toBeNull();
      expect(within(preview).queryByText("Date of Birth:")).toBeNull();
    });
  });
});
