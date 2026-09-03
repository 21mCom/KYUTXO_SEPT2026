// @vitest-environment jsdom
//
// Precedence coverage for the "Counterparty / Source" column of the Acquisition
// & Provenance appendix in the Proof of Funds Declaration PDF.
//
// Task #1393 introduced an explicit `counterpartyName` field on address records
// and made the provenance appendix prefer it over the older
// walletName -> label -> counterpartyType fallback chain. Nothing pinned that
// precedence, so a future refactor of the derivation could silently revert to
// the overloaded walletName/label behaviour without anyone noticing.
//
// The counterparty value is emitted into the provenance table body, which is
// rendered through jspdf-autotable (NOT doc.text). So this test mocks
// jspdf-autotable to capture every call, locates the provenance table by its
// header row ("Counterparty / Source"), and asserts the cell in that column:
//
//   (1) when counterpartyName is set AND a different walletName/label exist,
//       the appendix uses counterpartyName (the new field wins);
//   (2) when counterpartyName is blank, the fallback chain still applies and
//       the appendix falls back to walletName.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// Records returned by getRecordsByType("address"); shaped per test case.
let mockAddressRecords: any[] = [];

// Captures every jspdf-autotable invocation so the test can find the
// provenance table by its header row and read a specific body cell.
const autoTableCalls: { head: any; body: any }[] = [];

vi.mock("jspdf", () => {
  class FakeJsPDF {
    internal = {
      getNumberOfPages: () => 1,
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
    setPage() {}
    splitTextToSize(text: string) {
      return [text];
    }
    text() {}
    save() {}
  }
  return { default: FakeJsPDF };
});

vi.mock("jspdf-autotable", () => ({
  default: (doc: any, options: any) => {
    autoTableCalls.push({ head: options?.head, body: options?.body });
    doc.lastAutoTable = { finalY: 120 };
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
  getRecordsByType: vi.fn(async () => mockAddressRecords),
}));

vi.mock("@/lib/data/attachments-crud", () => ({
  getAttachmentsByRecordId: vi.fn(async () => []),
}));

vi.mock("@/lib/data/price-data-crud", () => ({
  getLatestPriceOnOrBefore: vi.fn(async () => null),
}));

// Returns the body of the provenance table (header contains
// "Counterparty / Source"), or undefined if it was never rendered.
function findProvenanceBody(): any[] | undefined {
  const call = autoTableCalls.find(
    (c) => Array.isArray(c.head?.[0]) && c.head[0].includes("Counterparty / Source"),
  );
  return call?.body;
}

async function renderAndGeneratePdf() {
  const { default: ProofOfFundsDeclaration } = await import(
    "@/pages/ProofOfFundsDeclaration"
  );

  renderWithProviders(<ProofOfFundsDeclaration />);

  fireEvent.change(screen.getByTestId("input-declarant-name"), {
    target: { value: "Alice Example" },
  });
  fireEvent.change(screen.getByTestId("input-declaration-date"), {
    target: { value: "2026-06-30" },
  });
  fireEvent.change(screen.getByTestId("input-purpose"), {
    target: { value: "Bank account opening" },
  });

  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: ADDR },
  });
  fireEvent.click(screen.getByTestId("button-check-balances"));

  await waitFor(() => {
    expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
  });

  // Turn on the Acquisition & Provenance appendix.
  fireEvent.click(screen.getByTestId("switch-include-provenance"));

  const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
  await waitFor(() => {
    expect(pdfButton.disabled).toBe(false);
  });
  fireEvent.click(pdfButton);

  await waitFor(() => {
    expect(findProvenanceBody()).toBeTruthy();
  });
}

describe("ProofOfFundsDeclaration — provenance appendix counterparty name precedence", () => {
  beforeEach(() => {
    localStorage.clear();
    autoTableCalls.length = 0;
    mockAddressRecords = [];
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the explicit counterpartyName even when a different walletName/label are set", async () => {
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "Trading Label",
        walletName: "My Trading Wallet",
        counterpartyName: "Acme Exchange Ltd",
        counterpartyType: "exchange",
        tags: [],
        categories: [],
      },
    ];

    await renderAndGeneratePdf();

    const body = findProvenanceBody()!;
    expect(body).toHaveLength(1);
    // Column index 3 is "Counterparty / Source".
    expect(body[0][3]).toBe("Acme Exchange Ltd");
    // The overloaded fallbacks must NOT win when counterpartyName is present.
    expect(body[0][3]).not.toBe("My Trading Wallet");
    expect(body[0][3]).not.toBe("Trading Label");
    expect(body[0][3]).not.toBe("Exchange");
  });

  it("falls back to walletName when counterpartyName is blank", async () => {
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "Trading Label",
        walletName: "My Trading Wallet",
        counterpartyName: "   ", // blank after trim
        counterpartyType: "exchange",
        tags: [],
        categories: [],
      },
    ];

    await renderAndGeneratePdf();

    const body = findProvenanceBody()!;
    expect(body).toHaveLength(1);
    expect(body[0][3]).toBe("My Trading Wallet");
  });
});
