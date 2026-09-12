// @vitest-environment jsdom
//
// Coverage for ProofOfFundsDeclaration's optional Introduction / Preface.
//
// When enabled, the PDF builder draws a plain-language "INTRODUCTION" section at
// the very top of the declaration — before the declarant details — explaining
// that Bitcoin is a digital bearer asset, that the blockchain is a publicly
// verifiable (pseudonymous) ledger, and that ownership is established through
// control of the private keys.
//
// This test seeds one valid address (offline balance), fills the minimal
// required fields, and asserts:
//   (1) by default the introduction is off, so the PDF carries none of its text;
//   (2) toggling the option on shows the preview block in the form;
//   (3) generating the PDF then draws the introduction text, positioned BEFORE
//       the "DECLARANT DETAILS" heading.
//
// The PDF text is captured by wrapping the REAL jsPDF instance's text() call so
// the assertions reflect what jsPDF would actually paint (after the real
// splitTextToSize wrapping), not a hand-rolled stub.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// Capture every line the PDF builder draws via the REAL jsPDF instance. Only
// text() (recording) and save() (no-op) are wrapped; splitTextToSize() etc. keep
// their genuine jsPDF behavior so the captured lines match real output.
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
// an empty string so the PDF builder skips the QR image (it isn't enabled here
// anyway) without hanging.
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => ""),
  },
}));

// A short sentinel phrase from each intro paragraph. Joining the drawn lines
// with spaces reconstructs phrases that may have wrapped across two lines.
const INTRO_SENTINELS = [
  "digital bearer asset",
  "pseudonymous ledger",
  "supporting evidence may include blockchain explorer records",
];

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

describe("ProofOfFundsDeclaration — optional introduction / preface", () => {
  beforeEach(() => {
    pdfState.drawn.length = 0;
    localStorage.clear();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("omits the introduction from the PDF by default", async () => {
    await seedAndPrepare();

    // The switch is off by default and no preview is shown.
    expect(
      screen
        .getByTestId("switch-include-intro")
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByTestId("text-intro-preview")).toBeNull();

    await waitFor(() => {
      expect(
        (screen.getByTestId("button-generate-pdf") as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("button-generate-pdf"));

    // Wait until the builder has drawn the document (the declarant heading is
    // always present), then assert none of the intro sentinels were drawn.
    await waitFor(() => {
      expect(pdfState.drawn.some((l) => l.includes("DECLARANT DETAILS"))).toBe(
        true,
      );
    });

    const joined = pdfState.drawn.join(" ");
    for (const sentinel of INTRO_SENTINELS) {
      expect(joined).not.toContain(sentinel);
    }
    expect(pdfState.drawn.some((l) => l.includes("INTRODUCTION"))).toBe(false);
  });

  it("draws the introduction at the top of the PDF when enabled", async () => {
    await seedAndPrepare();

    // Enable the optional introduction; a preview block appears in the form.
    fireEvent.click(screen.getByTestId("switch-include-intro"));
    await waitFor(() => {
      expect(screen.getByTestId("text-intro-preview")).toBeTruthy();
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId("button-generate-pdf") as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("button-generate-pdf"));

    await waitFor(() => {
      expect(pdfState.drawn.some((l) => l.includes("INTRODUCTION"))).toBe(true);
    });

    // (1) Every intro sentinel was drawn (joining handles words split by wrap).
    const joined = pdfState.drawn.join(" ");
    for (const sentinel of INTRO_SENTINELS) {
      expect(joined).toContain(sentinel);
    }

    // (2) The INTRODUCTION heading precedes DECLARANT DETAILS in draw order.
    const introIdx = pdfState.drawn.findIndex((l) =>
      l.includes("INTRODUCTION"),
    );
    const declarantIdx = pdfState.drawn.findIndex((l) =>
      l.includes("DECLARANT DETAILS"),
    );
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(declarantIdx).toBeGreaterThan(introIdx);
  });
});
