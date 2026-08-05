// @vitest-environment jsdom
//
// Coverage for the on-screen Step 7 AML / Risk Screening *preview* panel of the
// Proof of Funds Declaration. Task #1385 covered `runAmlScreening` and the PDF
// `if (includeAml)` block, but the live preview — rendered while the user fills
// the form, driven by the `useEffect` on `includeAml` / `doneAddressKey` — had
// no coverage. If the preview and the PDF ever diverge (e.g. the preview shows
// "No direct matches" while the PDF table lists matches), a user could sign off
// on a misleading document.
//
// Each test below drives the component with a known fixture, lets the screening
// effect compute, asserts the on-screen preview text for that fixture, then
// generates the PDF (jsPDF mocked to capture every emitted string) and asserts
// the PDF emits the *same* direct-match / hop-distance / entity-list-source
// state. This pins the preview to the PDF so neither can silently drift.
//
// The DB-touching dependencies of runAmlScreening are dynamically imported
// inside the function (settings-crud, record-queries, transaction-crud) plus the
// module-level privacy-entity-list lookups; all are mocked through small mutable
// hooks so each test can shape the fixture it needs (mirroring the appendix
// test's harness).

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

// jsPDF replacement that records every string handed to doc.text() so the test
// can assert the appendix emitted the same state the on-screen preview showed.
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

// The preview branch strings interpolate values across several text nodes, so a
// single-text-node matcher (getByText) is brittle. The preview is the only place
// these strings appear in the DOM (the PDF is mocked, never rendered), so a
// whole-body substring check is both sufficient and unambiguous.
function previewHas(substr: string): boolean {
  return (document.body.textContent ?? "").includes(substr);
}

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
  resetMocks();
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  cleanup();
});

async function setupComponentAndTurnAmlOn() {
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

  // Turning the toggle on triggers the screening useEffect.
  fireEvent.click(screen.getByTestId("switch-include-aml"));

  // Wait for the preview to transition from the running spinner to a result.
  await waitFor(() => {
    expect(previewHas("Screening complete")).toBe(true);
  });
}

async function generatePdf() {
  const pdfButton = screen.getByTestId("button-generate-pdf") as HTMLButtonElement;
  await waitFor(() => {
    expect(pdfButton.disabled).toBe(false);
  });
  fireEvent.click(pdfButton);
  await waitFor(() => {
    expect(pdfHas(AML_APPENDIX_HEADING)).toBe(true);
  });
}

describe("ProofOfFundsDeclaration — on-screen AML preview matches the PDF", () => {
  it("(a) preview shows no-direct-match + no-graph-data (bundled list), matching the PDF", async () => {
    mockActiveSource = "bundled";
    mockActiveCount = 9_999;
    mockLookupEntities = () => new Map();
    mockGetParticipantsByAddresses = async () => [];

    await setupComponentAndTurnAmlOn();

    // ── On-screen preview ──
    expect(previewHas("Screening complete — 1 address checked")).toBe(true);
    expect(
      previewHas("Entity list: Bundled (KYUTXO default) — 9,999 known addresses"),
    ).toBe(true);
    expect(
      previewHas(
        "No direct matches — none of the declared addresses appear in the entity list.",
      ),
    ).toBe(true);
    // No transaction data → the hop-analysis note (covers the "no graph data" branch).
    expect(
      previewHas(
        "No transaction data available for hop analysis — sync addresses to enable this.",
      ),
    ).toBe(true);
    // The contradictory branches must NOT appear.
    expect(previewHas("direct match detected")).toBe(false);
    expect(previewHas("Nearest flagged entity:")).toBe(false);

    // ── PDF for the same fixture ──
    // The PDF routes text through sanitizePdfText, which remaps the em-dash
    // (U+2014) to its WinAnsi byte (0x97); match dash-free substrings here to
    // stay encoding-agnostic. The underlying state (entity-list source + count)
    // must still be identical to the preview.
    await generatePdf();
    expect(pdfHas("Bundled (KYUTXO default)")).toBe(true);
    expect(pdfHas("9,999 known addresses")).toBe(true);
    expect(pdfHas("No direct matches detected.")).toBe(true);
    expect(
      pdfHas("No transaction history is available for these addresses"),
    ).toBe(true);
    // PDF must not claim a match the preview said was absent.
    expect(pdfHas("direct match(es) detected")).toBe(false);
    expect(pdfHas("Nearest flagged entity:")).toBe(false);
  });

  it("(b) preview shows a direct match + imported-snapshot label/date line, matching the PDF", async () => {
    mockActiveSource = "imported";
    mockActiveCount = 42;
    mockSettings = {
      entityListSnapshot: {
        importedAt: 1_700_000_000_000, // → 2023-11-14
        sourceLabel: "my-list.json",
      },
    };
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

    await setupComponentAndTurnAmlOn();

    // ── On-screen preview: imported-snapshot label + date line ──
    expect(
      previewHas(
        "Entity list: User-imported snapshot — 42 known addresses, file: my-list.json, imported: 2023-11-14",
      ),
    ).toBe(true);
    expect(previewHas("1 direct match detected: Flagged Exchange")).toBe(true);
    expect(previewHas("No direct matches —")).toBe(false);

    // ── PDF for the same fixture ──
    // sanitizePdfText remaps the preview's em-dash to its WinAnsi byte, so match
    // dash-free substrings here; the imported-snapshot label/date state must
    // still match.
    await generatePdf();
    expect(pdfHas("User-imported snapshot")).toBe(true);
    expect(pdfHas("42 known addresses")).toBe(true);
    expect(pdfHas("file: my-list.json")).toBe(true);
    expect(pdfHas("imported: 2023-11-14")).toBe(true);
    expect(pdfHas("1 direct match(es) detected")).toBe(true);
    // The matched entity name renders into an autoTable cell (not doc.text), so
    // it is captured by the preview assertion above rather than pdfTextLines.
    expect(pdfHas("No direct matches detected.")).toBe(false);
  });

  it("(c) preview shows an indirect hop distance, matching the PDF", async () => {
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

    await setupComponentAndTurnAmlOn();

    // ── On-screen preview: nearest-hop line + clean direct-match branch ──
    expect(
      previewHas(
        "Nearest flagged entity: 1 hop away — Proximity Mixer (Mixer / CoinJoin Service)",
      ),
    ).toBe(true);
    expect(previewHas("No direct matches —")).toBe(true);
    // hasGraphData is true, so the "no transaction data" note must be absent.
    expect(
      previewHas("No transaction data available for hop analysis"),
    ).toBe(false);

    // ── PDF for the same fixture ──
    await generatePdf();
    expect(pdfHas("Nearest flagged entity:")).toBe(true);
    expect(pdfHas("1 hop away")).toBe(true);
    expect(pdfHas("Proximity Mixer")).toBe(true);
    expect(pdfHas("Mixer / CoinJoin Service")).toBe(true);
    expect(pdfHas("No direct matches detected.")).toBe(true);
    expect(
      pdfHas("No transaction history is available for these addresses"),
    ).toBe(false);
  });
});
