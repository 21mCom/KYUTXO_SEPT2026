// @vitest-environment jsdom
//
// Coverage for the optional declarant identity fields in the Proof of Funds
// Declaration PDF.
//
// Five optional identity fields (Residential/Street Address, Date of Birth,
// Tax ID Number, Identification Number, Nationality) were added to the
// declarant section. The PDF builder only emits a labelled line for a field
// when that field is non-blank — omitted fields must produce no label and no
// placeholder text at all.
//
// This test fills a MIX of the optional fields (residential address, tax ID,
// nationality) and intentionally leaves the others blank (date of birth,
// identification number). It then generates the PDF (jsPDF is mocked so every
// `doc.text(...)` string is captured) and asserts:
//   (1) each FILLED field's label appears exactly once in the PDF text;
//   (2) each BLANK field's label appears nowhere in the PDF text;
//   (3) the required fields (Full Name, Declaration Date, Purpose) are present
//       and unaffected.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

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
    // Mirror the real plugin's contract: leave a finalY the caller reads from.
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

// Count how many captured PDF lines start with a given label prefix.
function labelCount(label: string): number {
  return pdfTextLines.filter((l) => l.startsWith(label)).length;
}

describe("ProofOfFundsDeclaration — optional identity fields in PDF", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("emits a label for each filled optional field and none for blank ones", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Seed a single valid address and run the offline balance check so a "done"
    // row exists (the PDF requires at least one resolved balance).
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

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

    // Generate the PDF.
    const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(labelCount("Full Name:")).toBe(1);
    });

    // Required fields present and unaffected.
    expect(labelCount("Full Name:")).toBe(1);
    expect(labelCount("Declaration Date:")).toBe(1);
    expect(labelCount("Purpose:")).toBe(1);
    expect(pdfTextLines).toContain("Full Name: Alice Example");
    expect(pdfTextLines).toContain("Declaration Date: 2026-06-30");
    expect(pdfTextLines).toContain("Purpose: Bank account opening");

    // Filled optional fields — each label appears exactly once, with its value.
    expect(labelCount("Residential / Street Address:")).toBe(1);
    expect(labelCount("Tax ID Number:")).toBe(1);
    expect(labelCount("Nationality:")).toBe(1);
    expect(pdfTextLines).toContain(
      "Residential / Street Address: 221B Baker Street, London",
    );
    expect(pdfTextLines).toContain("Tax ID Number: TAX-998877");
    expect(pdfTextLines).toContain("Nationality: British");

    // Blank optional fields — no label, no placeholder text whatsoever.
    expect(labelCount("Date of Birth:")).toBe(0);
    expect(labelCount("Identification Number:")).toBe(0);
    expect(pdfTextLines.some((l) => l.includes("Date of Birth"))).toBe(false);
    expect(pdfTextLines.some((l) => l.includes("Identification Number"))).toBe(
      false,
    );
  });

  it("emits no optional identity labels when all optional fields are blank", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Bob Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Audit" },
    });

    const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(labelCount("Full Name:")).toBe(1);
    });

    // None of the five optional identity labels should appear.
    expect(labelCount("Residential / Street Address:")).toBe(0);
    expect(labelCount("Date of Birth:")).toBe(0);
    expect(labelCount("Tax ID Number:")).toBe(0);
    expect(labelCount("Identification Number:")).toBe(0);
    expect(labelCount("Nationality:")).toBe(0);
  });
});
