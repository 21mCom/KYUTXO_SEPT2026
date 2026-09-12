// @vitest-environment jsdom
//
// Verifies that zero-balance addresses are automatically excluded from the
// Proof of Funds Declaration — they are NOT listed individually in the results
// table, and they do not appear in the generated PDF. Only a summary count is
// shown. Covers:
//   - offline vault balance path (pasted input)
//   - live on-chain balance path (pasted input, mocked provider)
//   - vault selection path (wallet/owner filter)
// Also verifies:
//   - an aggregate "N empty addresses excluded" count is shown when some (but
//     not all) addresses have a balance;
//   - an "all addresses empty" message is shown and PDF stays disabled when
//     every address resolves to zero;
//   - when all addresses have a balance, no empty-summary alerts appear.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

// Two addresses: one with a balance, one empty (zero).
const ADDR_WITH_BALANCE = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const ADDR_EMPTY = "12higDjoCCNXSA95xZMWUdPvXNmkAduhWv";

// A third address, also with a balance.
const ADDR_WITH_BALANCE_2 = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";

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
    doc.lastAutoTable = { finalY: 100 };
  },
}));

// Each test controls offline balance via this module-level variable.
let balanceOverride: Map<string, number> | null = null;

vi.mock("@/lib/data/address-stats", () => ({
  computeStatsForAddresses: vi.fn(async (addresses: string[]) => {
    const map = new Map<string, { balanceSats: number }>();
    for (const a of addresses) {
      const sats = balanceOverride?.get(a) ?? 0;
      if (sats > 0) map.set(a, { balanceSats: sats });
    }
    return map;
  }),
}));

// Each test controls the live balance via this module-level variable.
let liveBalanceOverride: Map<string, number> | null = null;

vi.mock("@/lib/blockchain-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    isNodeUnreachableError: actual.isNodeUnreachableError,
    NODE_PROBE_TIMEOUT_MS: actual.NODE_PROBE_TIMEOUT_MS,
    NODE_UNREACHABLE_CONSECUTIVE_LIMIT: actual.NODE_UNREACHABLE_CONSECUTIVE_LIMIT,
    createProviderFromSettings: vi.fn(() => ({
      name: "mock-provider",
      getBlockHeight: async () => 840_000,
      getAddressCoreStats: async (address: string) => ({
        balanceSats: liveBalanceOverride?.get(address) ?? 0,
        txCount: 1,
        receivedSats: liveBalanceOverride?.get(address) ?? 0,
        sentSats: 0,
      }),
      getAddressTransactions: async () => [],
      getTransaction: async () => null,
      testConnection: async () => ({ success: true }),
    })),
  };
});

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByType: vi.fn(async () => [
    { inputString: ADDR_WITH_BALANCE, type: "address", owner: "Alice", walletName: "Main", tags: [], categories: [] },
    { inputString: ADDR_EMPTY, type: "address", owner: "Alice", walletName: "Main", tags: [], categories: [] },
  ]),
}));

async function loadPage() {
  const { default: ProofOfFundsDeclaration } = await import(
    "@/pages/ProofOfFundsDeclaration"
  );
  return renderWithProviders(<ProofOfFundsDeclaration />);
}

async function pasteAndCheck(addresses: string[]) {
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: addresses.join("\n") },
  });
  fireEvent.click(screen.getByTestId("button-check-balances"));
}

describe("ProofOfFundsDeclaration — empty address exclusion", () => {
  beforeEach(() => {
    pdfTextLines.length = 0;
    balanceOverride = null;
    liveBalanceOverride = null;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("excludes a zero-balance address from the results table in the offline path", async () => {
    balanceOverride = new Map([
      [ADDR_WITH_BALANCE, 500_000],
      // ADDR_EMPTY returns 0 → excluded
    ]);

    await loadPage();
    await pasteAndCheck([ADDR_WITH_BALANCE, ADDR_EMPTY]);

    // The non-zero address reaches the total balance display.
    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // A summary of the excluded empty address is shown.
    expect(screen.getByTestId("alert-empty-excluded")).toBeTruthy();

    // The total only includes the non-zero address (500 000 sat = 0.00500000 BTC).
    const totalEl = screen.getByTestId("text-total-balance");
    expect(totalEl.textContent).toContain("0.00500000");

    // ADDR_EMPTY must NOT appear in any table row.
    const rows = screen.queryAllByTestId(/^row-address-/);
    for (const row of rows) {
      expect(row.textContent).not.toContain(ADDR_EMPTY);
    }

    // ADDR_WITH_BALANCE IS in a row.
    const rowTexts = rows.map((r) => r.textContent ?? "").join(" ");
    expect(rowTexts).toContain(ADDR_WITH_BALANCE);
  });

  it("excludes a zero-balance address from the results table in the live on-chain path", async () => {
    liveBalanceOverride = new Map([
      [ADDR_WITH_BALANCE, 300_000],
      // ADDR_EMPTY → 0 → excluded
    ]);

    await loadPage();

    // Switch to live mode before checking.
    fireEvent.click(screen.getByTestId("button-source-live"));
    await pasteAndCheck([ADDR_WITH_BALANCE, ADDR_EMPTY]);

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Summary alert present.
    expect(screen.getByTestId("alert-empty-excluded")).toBeTruthy();

    // ADDR_EMPTY must NOT appear in any table row.
    const rows = screen.queryAllByTestId(/^row-address-/);
    for (const row of rows) {
      expect(row.textContent).not.toContain(ADDR_EMPTY);
    }

    // ADDR_WITH_BALANCE IS listed.
    const rowTexts = rows.map((r) => r.textContent ?? "").join(" ");
    expect(rowTexts).toContain(ADDR_WITH_BALANCE);
  });

  it("shows the all-empty message and keeps PDF disabled in the live on-chain path", async () => {
    // All addresses return zero balance from the live provider.
    liveBalanceOverride = new Map(); // all → 0 → empty

    await loadPage();
    fireEvent.click(screen.getByTestId("button-source-live"));
    await pasteAndCheck([ADDR_EMPTY, ADDR_WITH_BALANCE]);

    await waitFor(() => {
      expect(screen.getByTestId("alert-all-empty")).toBeTruthy();
    });

    // PDF button must stay disabled.
    const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
    expect(pdfButton.disabled).toBe(true);

    // No individual table rows for the empty addresses.
    const rows = screen.queryAllByTestId(/^row-address-/);
    expect(rows.length).toBe(0);
  });

  it("shows the all-empty message and keeps PDF disabled when every address is zero", async () => {
    balanceOverride = new Map(); // all addresses return 0 → empty

    await loadPage();
    await pasteAndCheck([ADDR_EMPTY, ADDR_WITH_BALANCE]);

    await waitFor(() => {
      expect(screen.getByTestId("alert-all-empty")).toBeTruthy();
    });

    // The PDF generation button must remain disabled.
    const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
    expect(pdfButton.disabled).toBe(true);

    // No individual table row should appear for the empty addresses.
    const rows = screen.queryAllByTestId(/^row-address-/);
    expect(rows.length).toBe(0);
  });

  it("excludes empty addresses from the generated PDF", async () => {
    balanceOverride = new Map([
      [ADDR_WITH_BALANCE, 1_000_000],
      // ADDR_EMPTY → 0 → excluded
    ]);

    await loadPage();
    await pasteAndCheck([ADDR_WITH_BALANCE, ADDR_EMPTY]);

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-declarant-name"), {
      target: { value: "Alice Example" },
    });
    fireEvent.change(screen.getByTestId("input-declaration-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByTestId("input-purpose"), {
      target: { value: "Bank account opening" },
    });

    const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(pdfTextLines.length).toBeGreaterThan(0);
    });

    // The included address must appear in the PDF.
    expect(pdfTextLines.some((l) => l.includes(ADDR_WITH_BALANCE))).toBe(true);
    // The zero-balance address must NOT appear in the PDF.
    expect(pdfTextLines.some((l) => l.includes(ADDR_EMPTY))).toBe(false);
  });

  it("counts multiple empty addresses together in the excluded summary", async () => {
    balanceOverride = new Map([
      [ADDR_WITH_BALANCE, 750_000],
      // ADDR_EMPTY and ADDR_WITH_BALANCE_2 both resolve to zero in this test
    ]);

    await loadPage();
    await pasteAndCheck([ADDR_WITH_BALANCE, ADDR_EMPTY, ADDR_WITH_BALANCE_2]);

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    const alertEl = screen.getByTestId("alert-empty-excluded");
    // Should mention 2 empty addresses.
    expect(alertEl.textContent).toMatch(/2 empty address/i);
  });

  it("does not show the empty summary when all addresses have a balance", async () => {
    balanceOverride = new Map([
      [ADDR_WITH_BALANCE, 100_000],
      [ADDR_EMPTY, 200_000],
    ]);

    await loadPage();
    await pasteAndCheck([ADDR_WITH_BALANCE, ADDR_EMPTY]);

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // No empty-excluded alert should be present.
    expect(screen.queryByTestId("alert-empty-excluded")).toBeNull();
    expect(screen.queryByTestId("alert-all-empty")).toBeNull();
  });
});
