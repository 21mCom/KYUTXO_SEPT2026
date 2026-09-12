// @vitest-environment jsdom
//
// Coverage for the cost-basis derivation and PROVENANCE SUMMARY totals of the
// Acquisition & Provenance appendix in the Proof of Funds Declaration PDF.
//
// The appendix derives each address's "Cost Basis" cell and the
// "Total Cost Basis" summary line via three branches:
//   (1) a user-supplied costBasisUsd  -> "USD <amount> (user-supplied)";
//   (2) a historical price looked up from the vault price store via
//       getLatestPriceOnOrBefore -> "<currency> <balanceSats/1e8 * close>"
//       plus a "Rate: ..." note line;
//   (3) "Not recorded" when neither a costBasisUsd nor price data exists.
// None of these paths were pinned by a test, so a refactor could silently
// produce a wrong cost basis or summary total on a document a bank relies on.
//
// The per-row cost basis is emitted into the provenance table body (column
// index 5), rendered through jspdf-autotable. The PROVENANCE SUMMARY totals
// and the per-entry rate note are emitted via doc.text. So this test mocks
// jspdf to capture every text() call AND jspdf-autotable to capture the table
// body, then asserts both the cell and the summary line.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// Records returned by getRecordsByType("address"); shaped per test case.
let mockAddressRecords: any[] = [];

// Price row returned by getLatestPriceOnOrBefore; null disables the lookup.
let mockPriceRow: { close: number; date: string; source?: string } | null = null;

// Captures every jspdf-autotable invocation so the test can find the
// provenance table by its header row and read a specific body cell.
const autoTableCalls: { head: any; body: any }[] = [];

// Captures every doc.text(...) string so the test can assert summary lines.
const textCalls: string[] = [];

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
    text(text: any) {
      if (Array.isArray(text)) {
        for (const t of text) textCalls.push(String(t));
      } else {
        textCalls.push(String(text));
      }
    }
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
  // 500,000 sats = 0.005 BTC.
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
  getLatestPriceOnOrBefore: vi.fn(async () => mockPriceRow),
}));

// Returns the body of the provenance table (header contains
// "Counterparty / Source"), or undefined if it was never rendered.
function findProvenanceBody(): any[] | undefined {
  const call = autoTableCalls.find(
    (c) => Array.isArray(c.head?.[0]) && c.head[0].includes("Counterparty / Source"),
  );
  return call?.body;
}

// Drives a Radix <Select> via the keyboard (pointer events don't open it under
// jsdom): focus the trigger, press Enter to open, then click the matching option.
async function selectOption(triggerTestId: string, optionLabel: RegExp) {
  const trigger = screen.getByTestId(triggerTestId);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: optionLabel });
  fireEvent.click(option);
}

async function renderAndGeneratePdf(opts?: {
  // Declarant-supplied exchange rate (BTC per 1 fiat unit) typed into the Fiat
  // Valuation card. When set, the PDF prints "Current Value" / gain-loss lines.
  fiatRate?: string;
  // When set, switches the provenance appendix currency so it differs from the
  // declaration's (USD) fiat currency, exercising the gain/loss currency guard.
  provenanceCurrency?: RegExp;
}) {
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

  if (opts?.fiatRate !== undefined) {
    fireEvent.change(screen.getByTestId("input-fiat-rate"), {
      target: { value: opts.fiatRate },
    });
  }

  // Turn on the Acquisition & Provenance appendix.
  fireEvent.click(screen.getByTestId("switch-include-provenance"));

  if (opts?.provenanceCurrency) {
    await selectOption("select-provenance-currency", opts.provenanceCurrency);
  }

  const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
  await waitFor(() => {
    expect(pdfButton.disabled).toBe(false);
  });
  fireEvent.click(pdfButton);

  await waitFor(() => {
    expect(findProvenanceBody()).toBeTruthy();
  });
}

describe("ProofOfFundsDeclaration — provenance appendix cost basis & totals", () => {
  beforeEach(() => {
    autoTableCalls.length = 0;
    textCalls.length = 0;
    mockAddressRecords = [];
    mockPriceRow = null;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
    // jsdom lacks these; Radix <Select> calls them when opening its listbox.
    Element.prototype.scrollIntoView = vi.fn();
    (Element.prototype as any).hasPointerCapture = vi.fn();
    (Element.prototype as any).releasePointerCapture = vi.fn();
    (Element.prototype as any).setPointerCapture = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses a user-supplied costBasisUsd for the cell and the summary total", async () => {
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "",
        date: "2021-03-15",
        costBasisUsd: 12345.67,
        tags: [],
        categories: [],
      },
    ];

    await renderAndGeneratePdf();

    const body = findProvenanceBody()!;
    expect(body).toHaveLength(1);
    // Column index 5 is "Cost Basis (USD)".
    expect(body[0][5]).toBe("USD 12,345.67 (user-supplied)");

    // The PROVENANCE SUMMARY total must echo the same user-supplied value.
    expect(
      textCalls.some((t) => t === "Total Cost Basis: USD 12,345.67"),
    ).toBe(true);
  });

  it("computes the cost basis from a historical price and emits the rate note", async () => {
    mockPriceRow = { close: 50000, date: "2020-01-01", source: "CoinGecko" };
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "",
        date: "2020-01-02",
        // no costBasisUsd -> falls through to the price lookup
        tags: [],
        categories: [],
      },
    ];

    await renderAndGeneratePdf();

    const body = findProvenanceBody()!;
    expect(body).toHaveLength(1);
    // 0.005 BTC * 50,000 = 250.00
    expect(body[0][5]).toBe("USD 250.00");

    // The summary total reflects the computed basis.
    expect(
      textCalls.some((t) => t === "Total Cost Basis: USD 250.00"),
    ).toBe(true);

    // A rate note line documents the price source and date.
    expect(
      textCalls.some(
        (t) =>
          t.includes("Rate: USD 50,000 on 2020-01-01") &&
          t.includes("source: CoinGecko"),
      ),
    ).toBe(true);
  });

  it("shows 'Not recorded' when there is neither a costBasisUsd nor price data", async () => {
    // Price lookup returns null (mockPriceRow stays null from beforeEach).
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "",
        date: "2019-07-01",
        // no costBasisUsd, no price data available
        tags: [],
        categories: [],
      },
    ];

    await renderAndGeneratePdf();

    const body = findProvenanceBody()!;
    expect(body).toHaveLength(1);
    expect(body[0][5]).toBe("Not recorded");

    // With no cost basis at all, the summary must NOT print a Total Cost Basis.
    expect(textCalls.some((t) => t.startsWith("Total Cost Basis:"))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Unrealized Gain/Loss line: fiatTotal - totalCostBasis, with a percentage of
  // (gainLoss / totalCostBasis) * 100, only when the declaration fiat currency
  // matches the provenance fiat currency and totalCostBasis > 0.
  //
  // Balance is 0.005 BTC (500,000 sats from the address-stats mock), so with a
  // declarant-supplied rate of 60,000 USD/BTC the current value is 300.00 USD.
  // ---------------------------------------------------------------------------

  it("emits a positive Unrealized Gain/Loss for a gain", async () => {
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "",
        date: "2021-03-15",
        costBasisUsd: 100, // total cost basis = 100.00
        tags: [],
        categories: [],
      },
    ];

    // 0.005 BTC * 60,000 = 300.00 current value; gain = 300 - 100 = +200.00 (+200.0%).
    await renderAndGeneratePdf({ fiatRate: "60000" });

    expect(
      textCalls.some((t) => t === "Total Cost Basis: USD 100.00"),
    ).toBe(true);
    expect(
      textCalls.some(
        (t) => t === "Unrealized Gain/Loss: +USD 200.00 (+200.0%)",
      ),
    ).toBe(true);
  });

  it("emits a negative Unrealized Gain/Loss for a loss", async () => {
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "",
        date: "2021-03-15",
        costBasisUsd: 400, // total cost basis = 400.00
        tags: [],
        categories: [],
      },
    ];

    // 0.005 BTC * 60,000 = 300.00 current value; loss = 300 - 400 = -100.00 (-25.0%).
    await renderAndGeneratePdf({ fiatRate: "60000" });

    expect(
      textCalls.some((t) => t === "Total Cost Basis: USD 400.00"),
    ).toBe(true);
    expect(
      textCalls.some(
        (t) => t === "Unrealized Gain/Loss: USD -100.00 (-25.0%)",
      ),
    ).toBe(true);
  });

  it("omits Unrealized Gain/Loss when the fiat currency differs from the provenance currency", async () => {
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "",
        date: "2021-03-15",
        costBasisUsd: 100,
        tags: [],
        categories: [],
      },
    ];

    // Declaration currency stays USD; provenance currency is switched to EUR, so
    // the gain/loss guard (fiatCurrency === provenanceFiatCurrency) fails.
    await renderAndGeneratePdf({ fiatRate: "60000", provenanceCurrency: /EUR/ });

    // The Current Value line still prints (fiat rate is valid)...
    expect(textCalls.some((t) => t.startsWith("Current Value:"))).toBe(true);
    // ...and a cost basis exists, but the gain/loss line is suppressed.
    expect(
      textCalls.some((t) => t.startsWith("Unrealized Gain/Loss:")),
    ).toBe(false);
  });

  it("omits Unrealized Gain/Loss when there is no cost basis (totalCostBasis is 0)", async () => {
    // No costBasisUsd and no price data -> totalCostBasis stays 0.
    mockAddressRecords = [
      {
        id: 1,
        type: "address",
        inputString: ADDR,
        label: "",
        date: "2019-07-01",
        tags: [],
        categories: [],
      },
    ];

    // A valid fiat rate still prints the Current Value line, isolating the
    // omission to the totalCostBasis > 0 guard.
    await renderAndGeneratePdf({ fiatRate: "60000" });

    expect(textCalls.some((t) => t.startsWith("Current Value:"))).toBe(true);
    expect(textCalls.some((t) => t.startsWith("Total Cost Basis:"))).toBe(false);
    expect(
      textCalls.some((t) => t.startsWith("Unrealized Gain/Loss:")),
    ).toBe(false);
  });
});
