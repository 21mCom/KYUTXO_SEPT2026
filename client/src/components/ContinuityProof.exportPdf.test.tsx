// @vitest-environment jsdom
//
// Coverage for the per-segment PDF export on the Continuity Proof page. The
// JSON "Export Proof" button and the "Export PDF" button must both consume the
// SAME payload builder (buildSegmentProofPayload) so the two formats can never
// drift, every user-supplied string drawn into the PDF must pass through
// sanitizePdfText (Standard-14 Helvetica garbles non-WinAnsi punctuation), and
// a PDF generation failure must surface a destructive toast instead of failing
// silently.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Capture every string drawn into the PDF via doc.text(...) plus the filename
// passed to doc.save(...), so the tests can assert the rendered content and
// the download name without parsing binary PDF output. pdfState.failNextSave
// simulates a generation failure for the error-toast path.
const { pdfTextCalls, pdfSaveCalls, pdfState } = vi.hoisted(() => ({
  pdfTextCalls: [] as string[],
  pdfSaveCalls: [] as string[],
  pdfState: { failNextSave: false },
}));
vi.mock("jspdf", () => {
  class FakeJsPDF {
    internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
    setFontSize() {}
    setFont() {}
    setTextColor() {}
    setFillColor() {}
    setDrawColor() {}
    roundedRect() {}
    addPage() {}
    getNumberOfPages() {
      return 1;
    }
    splitTextToSize(text: unknown) {
      return [text];
    }
    text(str: unknown) {
      if (typeof str === "string") pdfTextCalls.push(str);
    }
    save(filename?: string) {
      if (pdfState.failNextSave) {
        pdfState.failNextSave = false;
        throw new Error("simulated save failure");
      }
      pdfSaveCalls.push(filename ?? "");
    }
  }
  return { jsPDF: FakeJsPDF, default: FakeJsPDF };
});

// The lineage engine is heavy (full table scans); stub the build/address
// entry points. CRUD reads stay real against fake-indexeddb.
// Toasts are asserted via the hook mock (repo convention) rather than the
// Radix toast DOM, which duplicates text into an aria-live region.
const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const buildAllLineageMock = vi.fn();
const buildAllCustodySegmentsMock = vi.fn();
const getSegmentsForAddressMock = vi.fn();
vi.mock("@/lib/lineageEngine", () => ({
  buildAllLineage: (...args: unknown[]) => buildAllLineageMock(...args),
  buildAllCustodySegments: (...args: unknown[]) => buildAllCustodySegmentsMock(...args),
  getSegmentsForAddress: (...args: unknown[]) => getSegmentsForAddressMock(...args),
  getLineageChainForAddress: async () => ({ chain: [], truncated: false }),
  getCustodyDuration: () => ({ totalDays: 0 }),
}));

import { renderWithProviders } from "@/test/testProviders";
import {
  bulkAddCustodySegments,
  clearAllLineageData,
} from "@/lib/data/lineage-crud";
import { sanitizePdfText } from "@/lib/pdfText";
import type { CustodySegment } from "@/lib/database";
import { ContinuityProof } from "./ContinuityProof";

// Punctuation outside the WinAnsi range (em-dash, curly quotes, ellipsis) is
// exactly what sanitizePdfText must remap before it reaches jsPDF.
const SEGMENT: CustodySegment = {
  segmentId: "seg-export-0001",
  originTxid: "a".repeat(64),
  originVout: 1,
  originAddress: "bc1qoriginexport",
  originDate: 1_700_000_000,
  originAmount: 250_000,
  currentAddress: "bc1qcurrentexport",
  currentAmount: 200_000,
  status: "active",
  hopCount: 2,
  evidenceTxids: ["b".repeat(64), "c".repeat(64)],
  narrative: "Bought from a friend — held through “the fork”… untouched",
  owner: "Alice “Ada” Example",
  walletName: "Vault — cold storage",
  seedName: "Seed 1",
  acquisitionMethod: "purchase",
  costBasisUsd: 1234.5,
  createdAt: 1_700_000_001,
  updatedAt: 1_700_000_001,
} as CustodySegment;

const objectUrlBlobs: Blob[] = [];
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(async () => {
  localStorage.clear();
  pdfTextCalls.length = 0;
  pdfSaveCalls.length = 0;
  pdfState.failNextSave = false;
  objectUrlBlobs.length = 0;
  buildAllLineageMock.mockReset();
  buildAllCustodySegmentsMock.mockReset();
  getSegmentsForAddressMock.mockReset();
  toastMock.mockReset();
  buildAllLineageMock.mockResolvedValue({ processed: 0, created: 0 });
  buildAllCustodySegmentsMock.mockResolvedValue({ processed: 0, created: 0 });
  getSegmentsForAddressMock.mockResolvedValue([]);
  // jsdom does not implement createObjectURL; capture the JSON blob instead.
  URL.createObjectURL = ((blob: Blob) => {
    objectUrlBlobs.push(blob);
    return "blob:mock";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  // Keep jsdom from attempting to navigate to the blob: URL.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await clearAllLineageData();
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  cleanup();
});

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function renderExpandedSegment() {
  await bulkAddCustodySegments([SEGMENT]);
  renderWithProviders(<ContinuityProof />);
  // The card mounts collapsed; click the header (the collapsible trigger) to
  // reveal the footer with the export buttons.
  const narrative = await screen.findByText(/Bought from a friend/);
  fireEvent.click(narrative);
  return {
    jsonButton: await screen.findByTestId(`button-export-segment-${SEGMENT.segmentId}`),
    pdfButton: await screen.findByTestId(`button-export-segment-pdf-${SEGMENT.segmentId}`),
  };
}

describe("ContinuityProof segment PDF export", () => {
  it("renders the same payload as the JSON export, with punctuation sanitized", async () => {
    const { jsonButton, pdfButton } = await renderExpandedSegment();

    fireEvent.click(jsonButton);
    expect(objectUrlBlobs).toHaveLength(1);
    const jsonPayload = JSON.parse(await readBlob(objectUrlBlobs[0]));

    fireEvent.click(pdfButton);
    await waitFor(() => {
      expect(pdfSaveCalls).toEqual([`custody-proof-${SEGMENT.segmentId}.pdf`]);
    });

    // The JSON export still carries the full segment proof object.
    expect(jsonPayload.segmentId).toBe(SEGMENT.segmentId);
    expect(jsonPayload.origin.txid).toBe(SEGMENT.originTxid);
    expect(jsonPayload.origin.vout).toBe(1);
    expect(jsonPayload.origin.address).toBe(SEGMENT.originAddress);
    expect(jsonPayload.origin.amount).toBe("0.00250000 BTC");
    expect(jsonPayload.current).toEqual({
      address: SEGMENT.currentAddress,
      amount: "0.00200000 BTC",
    });
    expect(jsonPayload.custody.status).toBe("active");
    expect(jsonPayload.custody.hopCount).toBe(2);
    expect(jsonPayload.evidence.txids).toEqual(SEGMENT.evidenceTxids);
    expect(jsonPayload.metadata.owner).toBe(SEGMENT.owner);
    expect(jsonPayload.metadata.costBasisUsd).toBe(1234.5);
    expect(typeof jsonPayload.generatedAt).toBe("string");

    // The PDF drew the same payload fields (through sanitizePdfText).
    const pdfText = pdfTextCalls.join("\n");
    expect(pdfText).toContain(jsonPayload.segmentId);
    expect(pdfText).toContain(jsonPayload.origin.txid);
    expect(pdfText).toContain(jsonPayload.origin.address);
    expect(pdfText).toContain(jsonPayload.origin.amount);
    expect(pdfText).toContain(jsonPayload.current.address);
    expect(pdfText).toContain(jsonPayload.current.amount);
    expect(pdfText).toContain("ACTIVE");
    expect(pdfText).toContain("2");
    for (const txid of jsonPayload.evidence.txids) {
      expect(pdfText).toContain(txid);
    }
    expect(pdfText).toContain(sanitizePdfText(SEGMENT.owner!));
    expect(pdfText).toContain(sanitizePdfText(SEGMENT.walletName!));
    expect(pdfText).toContain(sanitizePdfText(SEGMENT.seedName!));
    expect(pdfText).toContain("purchase");
    expect(pdfText).toContain("USD 1234.50");

    // Non-WinAnsi punctuation (em-dash, curly quotes, ellipsis) must have
    // been remapped to WinAnsi bytes, never passed through raw.
    expect(pdfText).toContain(sanitizePdfText(SEGMENT.narrative!));
    expect(pdfText).not.toContain("—");
    expect(pdfText).not.toContain("“");
    expect(pdfText).not.toContain("…");

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Exported",
          description: "Custody proof exported to PDF file.",
        }),
      );
    });
  });

  it("surfaces a destructive toast when PDF generation fails", async () => {
    const { pdfButton } = await renderExpandedSegment();

    pdfState.failNextSave = true;
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "PDF Export Failed",
          description: "simulated save failure",
        }),
      );
    });
    expect(pdfSaveCalls).toHaveLength(0);
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: "Custody proof exported to PDF file." }),
    );
  });

  it("handles a sparse segment restored from an older backup", async () => {
    // evidenceTxids is typed required but may be absent in stored rows.
    const sparse = { ...SEGMENT, segmentId: "seg-export-sparse" } as Record<string, unknown>;
    delete sparse.evidenceTxids;
    delete sparse.narrative;
    delete sparse.currentAddress;
    delete sparse.owner;
    delete sparse.walletName;
    delete sparse.seedName;
    delete sparse.acquisitionMethod;
    delete sparse.costBasisUsd;
    await bulkAddCustodySegments([sparse as unknown as CustodySegment]);

    renderWithProviders(<ContinuityProof />);
    const header = await screen.findByTestId(`text-segment-count`);
    await waitFor(() => expect(header.textContent).toBe("1"));
    // Expand via the card header (narrative is absent for this sparse row).
    fireEvent.click(screen.getByText(/0\.00250000 BTC/));

    const pdfButton = await screen.findByTestId(`button-export-segment-pdf-seg-export-sparse`);
    fireEvent.click(pdfButton);

    await waitFor(() => {
      expect(pdfSaveCalls).toEqual(["custody-proof-seg-export-sparse.pdf"]);
    });
    const pdfText = pdfTextCalls.join("\n");
    expect(pdfText).toContain("seg-export-sparse");
    expect(pdfText).toContain("No evidence transactions recorded.");
    expect(pdfText).not.toContain("undefined");
  });
});
