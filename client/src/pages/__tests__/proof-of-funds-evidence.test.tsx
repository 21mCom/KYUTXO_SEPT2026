// @vitest-environment jsdom
//
// Coverage for ProofOfFundsDeclaration's optional "Supporting Evidence" section.
//
// The declarant can attach images (embedded into the dossier) and PDF documents
// (merged as extra pages). This test exercises the image path end to end:
//   (1) with no evidence the PDF carries no evidence appendix and the canonical
//       fingerprint payload records EVIDENCE_COUNT: 0;
//   (2) after adding one image the form shows it in the list, and the generated
//       PDF draws the "APPENDIX: SUPPORTING EVIDENCE" heading plus the canonical
//       EVIDENCE_COUNT / EVIDENCE_ITEM lines that bind the file into the hash.
//
// The PDF text is captured by wrapping the REAL jsPDF instance's text() call so
// the assertions reflect what jsPDF would actually paint, not a stub. The
// pdf-lib merge itself is unit-tested in pdfMerge.test.ts; here it is mocked so
// the PDF-exhibit test can assert the page wiring (appendix, footer "+ exhibits",
// merge invocation) without re-parsing a real merged document in jsdom.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { PDFDocument } from "pdf-lib";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// A tiny but valid 1x1 PNG so jsPDF's getImageProperties/addImage can parse it.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function pngBytes(): Uint8Array {
  const bin = atob(PNG_1X1_BASE64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function makePdfFile(name: string): Promise<File> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const bytes = await doc.save();
  return new File([bytes], name, { type: "application/pdf" });
}

// Capture every line the PDF builder draws via the REAL jsPDF instance. Only
// text() (recording) and save() (no-op) are wrapped; everything else keeps its
// genuine jsPDF behavior so the captured lines match real output.
const pdfState = vi.hoisted(() => ({
  drawn: [] as string[],
}));

vi.mock("jspdf", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  const Real = actual.default;
  function Wrapped(this: any, ...args: unknown[]) {
    const inst: any = new Real(...args);
    const origText = inst.text.bind(inst);
    inst.text = (...a: unknown[]) => {
      const text = a[0];
      const parts = Array.isArray(text) ? (text as string[]) : [text as string];
      for (const line of parts) {
        if (typeof line === "string") pdfState.drawn.push(line);
      }
      return origText(...a);
    };
    inst.save = () => inst;
    return inst;
  }
  Wrapped.prototype = Real.prototype;
  return { ...actual, default: Wrapped };
});

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

// qrcode's toDataURL renders to a <canvas>, which jsdom doesn't implement; return
// an empty string so the PDF builder skips the QR image without hanging.
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => ""),
  },
}));

// The real pdf-lib merge is unit-tested separately; mock it here so the page test
// can verify the merge is invoked (and the appendix/footer wiring) without
// re-parsing a merged PDF in jsdom. countPdfPages is mocked to accept the small
// PDF the test uploads and report a fixed page count.
const mergeState = vi.hoisted(() => ({ called: 0 }));
vi.mock("@/lib/pdfMerge", () => ({
  mergeEvidencePdfs: vi.fn(async () => {
    mergeState.called += 1;
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  }),
  countPdfPages: vi.fn(async () => 2),
}));

async function seedAndPrepare() {
  const { default: ProofOfFundsDeclaration } = await import(
    "@/pages/ProofOfFundsDeclaration"
  );

  renderWithProviders(<ProofOfFundsDeclaration />);

  // Paste a single valid address and run the offline balance check so a "done"
  // row exists (the Generate PDF button is gated on doneRows.length > 0).
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: ADDR },
  });
  fireEvent.click(screen.getByTestId("button-check-balances"));
  await waitFor(() => {
    expect(screen.getByTestId("text-total-balance")).toBeTruthy();
  });

  // Minimal required fields so the PDF can be generated.
  fireEvent.change(screen.getByTestId("input-declarant-name"), {
    target: { value: "Alice Holder" },
  });
  fireEvent.change(screen.getByTestId("input-purpose"), {
    target: { value: "Proof of funds for a property purchase" },
  });
}

async function generateAndWait() {
  await waitFor(() => {
    expect(
      (screen.getByTestId("button-generate-pdf") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  fireEvent.click(screen.getByTestId("button-generate-pdf"));
  // The declarant heading is always drawn — wait for it to confirm the builder ran.
  await waitFor(() => {
    expect(pdfState.drawn.some((l) => l.includes("DECLARANT DETAILS"))).toBe(true);
  });
}

describe("ProofOfFundsDeclaration — optional supporting evidence", () => {
  beforeEach(() => {
    pdfState.drawn.length = 0;
    mergeState.called = 0;
    localStorage.clear();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
    // The PDF-exhibit download path builds a Blob URL; jsdom has no real
    // implementation, so stub both ends to keep the anchor download a no-op.
    (URL as any).createObjectURL = vi.fn(() => "blob:mock-evidence");
    (URL as any).revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("omits the evidence appendix and records EVIDENCE_COUNT: 0 when none added", async () => {
    await seedAndPrepare();

    expect(screen.getByTestId("text-evidence-count").textContent).toContain(
      "No files attached",
    );

    await generateAndWait();

    const joined = pdfState.drawn.join(" ");
    expect(
      pdfState.drawn.some((l) => l.includes("APPENDIX: SUPPORTING EVIDENCE")),
    ).toBe(false);
    expect(joined).not.toContain("EVIDENCE_ITEM_001");
    // The canonical payload still binds the (empty) evidence set into the hash.
    expect(joined).toContain("EVIDENCE_COUNT: 0");
  });

  it("draws the evidence appendix and binds the image into the fingerprint", async () => {
    await seedAndPrepare();

    // Attach a single image via the hidden file input.
    const file = new File([pngBytes()], "wallet-screenshot.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByTestId("input-evidence-file"), {
      target: { files: [file] },
    });

    // The list updates once hashing/processing completes. Evidence ids are
    // generated at runtime (ev-<ts>-<n>), so query rows by testid prefix.
    await waitFor(() => {
      expect(screen.getByTestId("text-evidence-count").textContent).toContain(
        "1 of",
      );
    });
    const nameEl = document.querySelector('[data-testid^="text-evidence-name-"]');
    expect(nameEl?.textContent).toContain("wallet-screenshot.png");
    // An image thumbnail (not a PDF chip) is shown.
    expect(document.querySelector('[data-testid^="img-evidence-"]')).toBeTruthy();

    // Add a caption so it flows into the canonical payload.
    const captionEl = document.querySelector(
      '[data-testid^="input-evidence-caption-"]',
    ) as HTMLInputElement;
    fireEvent.change(captionEl, {
      target: { value: "Exchange balance screenshot" },
    });

    await generateAndWait();

    const joined = pdfState.drawn.join(" ");
    // (1) The appendix heading is drawn.
    expect(
      pdfState.drawn.some((l) => l.includes("APPENDIX: SUPPORTING EVIDENCE")),
    ).toBe(true);
    // (2) The canonical payload binds the file into the fingerprint.
    expect(joined).toContain("EVIDENCE_COUNT: 1");
    expect(joined).toContain("EVIDENCE_ITEM_001");
  });

  it("merges PDF exhibits, marks the footer, and invokes the merge path", async () => {
    await seedAndPrepare();

    // Attach a single PDF document via the hidden file input.
    const file = await makePdfFile("bank-statement.pdf");
    fireEvent.change(screen.getByTestId("input-evidence-file"), {
      target: { files: [file] },
    });

    // The list updates once hashing + page-count processing completes.
    await waitFor(() => {
      expect(screen.getByTestId("text-evidence-count").textContent).toContain(
        "1 of",
      );
    });
    const nameEl = document.querySelector('[data-testid^="text-evidence-name-"]');
    expect(nameEl?.textContent).toContain("bank-statement.pdf");
    // A PDF chip is shown, not an image thumbnail.
    expect(document.querySelector('[data-testid^="img-evidence-"]')).toBeNull();

    await generateAndWait();

    const joined = pdfState.drawn.join(" ");
    // (1) The appendix heading is drawn and the PDF is bound into the hash.
    expect(
      pdfState.drawn.some((l) => l.includes("APPENDIX: SUPPORTING EVIDENCE")),
    ).toBe(true);
    expect(joined).toContain("EVIDENCE_COUNT: 1");
    expect(joined).toContain("EVIDENCE_ITEM_001");
    // (2) The footer notes that extra exhibit pages are merged in.
    expect(joined).toContain("+ exhibits");
    // (3) The pdf-lib merge path actually ran (output -> mergeEvidencePdfs).
    await waitFor(() => {
      expect(mergeState.called).toBeGreaterThan(0);
    });
  });
});
