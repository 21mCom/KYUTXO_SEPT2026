// @vitest-environment jsdom
//
// Coverage for the AML / Risk Screening appendix of the Proof of Funds
// Declaration. The appendix was added with no automated coverage, so a
// regression could silently produce a broken or blank PDF section without any
// visible error.
//
// Two layers are exercised here:
//
//   1. runAmlScreening (pure-ish async function, now exported) is driven with a
//      mocked DB returning a known fixture, and the returned result shape is
//      asserted for (a) the no-transaction-history case and (b) the
//      indirect-hop case where a flagged counterparty surfaces in the graph.
//
//   2. The PDF callback path (the `if (includeAml)` block in generatePdf) is
//      driven end-to-end through the full component (jsPDF mocked to capture
//      every emitted string) under each of the three hasGraphData / match
//      combinations, asserting the block never throws and emits the expected
//      headings, result lines, self-attestation lines and the disclaimer.
//
// The DB-touching dependencies of runAmlScreening are dynamically imported
// inside the function (settings-crud, record-queries, transaction-crud) plus
// the module-level privacy-entity-list lookups; all are mocked through small
// mutable hooks so each test can shape the fixture it needs.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { AML_APPENDIX_HEADING } from "@/pages/proof-of-funds/pof-pdf-strings";

const DECLARED_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const FLAGGED_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

// ── Mutable mock hooks (set per-test before exercising the code) ─────────────
let mockLookupEntities: (addrs: string[]) => Map<string, any> = () => new Map();
let mockActiveSource: "bundled" | "imported" = "bundled";
let mockActiveCount = 12_345;
let mockGetParticipantsByAddresses: (addrs: string[]) => Promise<any[]> =
  async () => [];
let mockGetParticipantsByTxids: (txids: string[]) => Promise<any[]> =
  async () => [];
let mockSettings: any = undefined;

// jsPDF replacement that records every string handed to doc.text() and counts
// addPage() so the test can assert the appendix was emitted and never threw.
const pdfTextLines: string[] = [];

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
    setPage() {}
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
    doc.lastAutoTable = { finalY: 120 };
  },
}));

vi.mock("@/lib/data/address-stats", () => ({
  computeStatsForAddresses: vi.fn(async (addresses: string[]) => {
    const map = new Map<string, { balanceSats: number }>();
    for (const a of addresses) map.set(a, { balanceSats: 750_000 });
    return map;
  }),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByType: vi.fn(async () => []),
}));

vi.mock("@/lib/privacy-entity-list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-entity-list")>();
  return {
    ...actual,
    lookupEntities: (addrs: string[]) => mockLookupEntities(addrs),
    getActiveEntitySource: () => mockActiveSource,
    getActiveEntityCount: () => mockActiveCount,
  };
});

vi.mock("@/lib/data/record-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-queries")>();
  return {
    ...actual,
    getParticipantsByAddresses: (addrs: string[]) =>
      mockGetParticipantsByAddresses(addrs),
    getParticipantsByAddressesWithOutpointSpends: (addrs: string[]) =>
      mockGetParticipantsByAddresses(addrs),
  };
});

vi.mock("@/lib/data/transaction-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/transaction-crud")>();
  return {
    ...actual,
    getParticipantsByTxids: (txids: string[]) =>
      mockGetParticipantsByTxids(txids),
  };
});

vi.mock("@/lib/data/settings-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/settings-crud")>();
  return {
    ...actual,
    getSettings: async () => mockSettings,
  };
});

function pdfHas(substr: string): boolean {
  return pdfTextLines.some((l) => l.includes(substr));
}

function resetMocks() {
  mockLookupEntities = () => new Map();
  mockActiveSource = "bundled";
  mockActiveCount = 12_345;
  mockGetParticipantsByAddresses = async () => [];
  mockGetParticipantsByTxids = async () => [];
  mockSettings = undefined;
}

beforeEach(() => {
  pdfTextLines.length = 0;
  localStorage.clear();
  resetMocks();
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  cleanup();
});

// ─── 1. runAmlScreening result-shape unit tests ─────────────────────────────

describe("runAmlScreening — result shape", () => {
  it("returns hasGraphData=false with no matches when no transaction history exists", async () => {
    // No entity matches anywhere, and the address has no participants on file.
    mockLookupEntities = () => new Map();
    mockGetParticipantsByAddresses = async () => [];
    mockActiveSource = "bundled";
    mockActiveCount = 9999;

    const { runAmlScreening } = await import("@/pages/ProofOfFundsDeclaration");
    const result = await runAmlScreening([DECLARED_ADDR]);

    expect(result).toMatchObject({
      entityListSource: "bundled",
      entityListCount: 9999,
      entityListImportedAt: null,
      entityListSourceLabel: null,
      screenedCount: 1,
      directMatches: [],
      nearestHopDistance: null,
      nearestHopEntityName: null,
      nearestHopCategoryLabel: null,
      hasGraphData: false,
    });
    expect(typeof result.screeningDate).toBe("string");
    expect(result.screeningDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("surfaces a direct match and an indirect hop distance from the transaction graph", async () => {
    // Declared address itself is clean, but a counterparty one hop away in the
    // graph is a flagged mixer. The declared address also itself appears in the
    // list to exercise the directMatches branch.
    mockActiveSource = "imported";
    mockActiveCount = 42;
    mockSettings = {
      entityListSnapshot: { importedAt: 1_700_000_000_000, sourceLabel: "my-list.json" },
    };
    mockLookupEntities = (addrs: string[]) => {
      const m = new Map<string, any>();
      if (addrs.includes(DECLARED_ADDR)) {
        m.set(DECLARED_ADDR, {
          address: DECLARED_ADDR,
          name: "Sanctioned Co",
          category: "exchange",
          sourceNote: "test note",
        });
      }
      if (addrs.includes(FLAGGED_ADDR)) {
        m.set(FLAGGED_ADDR, {
          address: FLAGGED_ADDR,
          name: "Test Mixer",
          category: "mixer",
          sourceNote: "test mixer note",
        });
      }
      return m;
    };
    mockGetParticipantsByAddresses = async () => [
      { txid: "tx1", address: DECLARED_ADDR },
    ];
    mockGetParticipantsByTxids = async () => [
      { txid: "tx1", address: DECLARED_ADDR },
      { txid: "tx1", address: FLAGGED_ADDR },
    ];

    const { runAmlScreening } = await import("@/pages/ProofOfFundsDeclaration");
    const result = await runAmlScreening([DECLARED_ADDR]);

    expect(result.hasGraphData).toBe(true);
    expect(result.entityListSource).toBe("imported");
    expect(result.entityListCount).toBe(42);
    expect(result.entityListImportedAt).toBe(1_700_000_000_000);
    expect(result.entityListSourceLabel).toBe("my-list.json");
    expect(result.directMatches).toHaveLength(1);
    expect(result.directMatches[0]).toMatchObject({
      address: DECLARED_ADDR,
      entityName: "Sanctioned Co",
      categoryLabel: "Exchange",
    });
    expect(result.nearestHopDistance).toBe(1);
    expect(result.nearestHopEntityName).toBe("Test Mixer");
    expect(result.nearestHopCategoryLabel).toBe("Mixer / CoinJoin Service");
  });
});

// ─── 2. PDF `if (includeAml)` block — three hasGraphData/match combinations ──

async function setupComponentAndCheckBalances() {
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
    target: { value: DECLARED_ADDR },
  });
  fireEvent.click(screen.getByTestId("button-check-balances"));

  await waitFor(() => {
    expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
  });
}

async function generatePdf() {
  fireEvent.click(screen.getByTestId("switch-include-aml"));

  const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
  await waitFor(() => {
    expect(pdfButton.disabled).toBe(false);
  });
  fireEvent.click(pdfButton);

  await waitFor(() => {
    expect(pdfHas(AML_APPENDIX_HEADING)).toBe(true);
  });
}

describe("ProofOfFundsDeclaration — AML appendix PDF block", () => {
  it("(a) renders no-direct-match + no-graph-data without throwing", async () => {
    mockLookupEntities = () => new Map();
    mockGetParticipantsByAddresses = async () => [];

    await setupComponentAndCheckBalances();
    await generatePdf();

    expect(pdfHas("SCREENING PARAMETERS")).toBe(true);
    expect(pdfHas("DIRECT MATCH RESULTS")).toBe(true);
    expect(pdfHas("No direct matches detected.")).toBe(true);
    expect(pdfHas("INDIRECT PROXIMITY ANALYSIS")).toBe(true);
    expect(
      pdfHas("No transaction history is available for these addresses"),
    ).toBe(true);
    // Self-attestations + disclaimer always render.
    expect(pdfHas("DECLARANT SELF-ATTESTATIONS")).toBe(true);
    expect(pdfHas("PEP Status:")).toBe(true);
    expect(pdfHas("SCREENING DISCLAIMER")).toBe(true);
    expect(pdfHas("LIMITATIONS OF THIS SCREENING")).toBe(true);
  });

  it("(b) renders the direct-match red-header table path without throwing", async () => {
    mockLookupEntities = (addrs: string[]) => {
      const m = new Map<string, any>();
      if (addrs.includes(DECLARED_ADDR)) {
        m.set(DECLARED_ADDR, {
          address: DECLARED_ADDR,
          name: "Flagged Exchange",
          category: "darknet",
          sourceNote: "test",
        });
      }
      return m;
    };
    mockGetParticipantsByAddresses = async () => [];

    await setupComponentAndCheckBalances();
    await generatePdf();

    expect(pdfHas("direct match(es) detected")).toBe(true);
    expect(pdfHas("No direct matches detected.")).toBe(false);
    expect(pdfHas("DECLARANT SELF-ATTESTATIONS")).toBe(true);
    expect(pdfHas("LIMITATIONS OF THIS SCREENING")).toBe(true);
  });

  it("(c) renders an indirect hop distance and all self-attestation fields without throwing", async () => {
    mockLookupEntities = (addrs: string[]) => {
      const m = new Map<string, any>();
      // Declared address is clean; the counterparty in the graph is flagged.
      if (addrs.includes(FLAGGED_ADDR)) {
        m.set(FLAGGED_ADDR, {
          address: FLAGGED_ADDR,
          name: "Proximity Mixer",
          category: "mixer",
          sourceNote: "test",
        });
      }
      return m;
    };
    mockGetParticipantsByAddresses = async () => [
      { txid: "tx1", address: DECLARED_ADDR },
    ];
    mockGetParticipantsByTxids = async () => [
      { txid: "tx1", address: DECLARED_ADDR },
      { txid: "tx1", address: FLAGGED_ADDR },
    ];

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
      target: { value: DECLARED_ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));
    await waitFor(() => {
      expect(screen.getByTestId("textarea-signature-0")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("switch-include-aml"));

    // Fill the self-attestation free-text fields so the PDF renders the
    // declarant-supplied values (rather than "not provided").
    await waitFor(() => {
      expect(screen.getByTestId("textarea-aml-source-of-wealth")).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId("textarea-aml-source-of-wealth"), {
      target: { value: "Employment income" },
    });
    fireEvent.change(screen.getByTestId("textarea-aml-source-of-funds"), {
      target: { value: "Salary purchases on a regulated exchange" },
    });
    fireEvent.change(screen.getByTestId("input-aml-tax-jurisdiction"), {
      target: { value: "United Kingdom" },
    });
    fireEvent.change(screen.getByTestId("input-aml-tax-statement"), {
      target: { value: "All taxes filed and paid." },
    });

    const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
    await waitFor(() => {
      expect(pdfButton.disabled).toBe(false);
    });
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(pdfHas(AML_APPENDIX_HEADING)).toBe(true);
    });

    expect(pdfHas("Nearest flagged entity:")).toBe(true);
    expect(pdfHas("Proximity Mixer")).toBe(true);
    // All self-attestation fields render the declarant-supplied values.
    expect(pdfHas("PEP Status:")).toBe(true);
    expect(pdfHas("Source of Wealth: Employment income")).toBe(true);
    expect(
      pdfHas("Source of Funds: Salary purchases on a regulated exchange"),
    ).toBe(true);
    expect(pdfHas("United Kingdom")).toBe(true);
    expect(pdfHas("All taxes filed and paid.")).toBe(true);
    // Disclaimer paragraph present.
    expect(pdfHas("LIMITATIONS OF THIS SCREENING")).toBe(true);
  });
});
