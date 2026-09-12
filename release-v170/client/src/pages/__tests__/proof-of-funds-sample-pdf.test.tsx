// @vitest-environment jsdom
//
// Coverage for the sample/specimen PDF generation path in the Proof of Funds
// Declaration page (the "Generate Sample PDF" action added alongside the real
// "Generate & Download PDF" button).
//
// Assertions:
//   (1) The "Generate Sample PDF" button is enabled even when no addresses are
//       loaded and the declarant fields are empty.
//   (2) Clicking it produces a PDF whose text contains the SAMPLE / SPECIMEN
//       watermark notice and never a real 64-hex SHA-256 fingerprint.
//   (3) Placeholder data (Jane Q. Sample, fictitious addresses, SAMPLE nonce)
//       appears in the rendered PDF text.
//   (4) Optional sections that are toggled ON appear in the sample PDF;
//       sections that are toggled OFF do not appear.
//   (5) The sample PDF does NOT include any 64-character hex string in the
//       "Content Fingerprint" position (no real fingerprint can be embedded).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, waitFor } from "@testing-library/react";

import { clearAllRecords } from "@/lib/data/record-crud";
import { clearTransactions, clearParticipants } from "@/lib/data/transaction-crud";
import { renderWithProviders } from "@/test/testProviders";

// Capture PDF text lines from every doc.text() call.
const pdfTextLines: string[] = [];

// Track page additions to detect watermark stamping.
let pdfPageCount = 0;

vi.mock("jspdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jspdf")>();
  const Real = actual.jsPDF;
  function Wrapped(this: unknown, ...args: unknown[]) {
    const inst = new (Real as unknown as new (...a: unknown[]) => {
      save: (...a: unknown[]) => unknown;
      output: (type: string) => Blob;
      internal: { getNumberOfPages: () => number; pageSize: { getWidth: () => number; getHeight: () => number } };
    })(...args);

    const origText = inst.text.bind(inst);
    inst.text = function (text: string | string[], ...rest: unknown[]) {
      if (Array.isArray(text)) {
        for (const t of text) pdfTextLines.push(t);
      } else if (typeof text === "string") {
        pdfTextLines.push(text);
      }
      return (origText as (...a: unknown[]) => unknown)(text, ...rest);
    };

    const origAddPage = inst.addPage.bind(inst);
    inst.addPage = function (...a: unknown[]) {
      pdfPageCount++;
      return (origAddPage as (...a: unknown[]) => unknown)(...a);
    };

    inst.save = function () {
      return inst;
    };
    return inst;
  }
  (Wrapped as unknown as { prototype: unknown }).prototype = Real.prototype;
  return { ...actual, default: Wrapped, jsPDF: Wrapped };
});

import ProofOfFundsDeclaration from "@/pages/ProofOfFundsDeclaration";

beforeEach(async () => {
  localStorage.clear();
  pdfTextLines.length = 0;
  pdfPageCount = 0;

  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

describe("Proof of Funds — Generate Sample PDF", () => {
  it("sample button is enabled even with no addresses loaded and empty declarant fields", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);

    const sampleBtn = h.getByTestId("button-generate-sample-pdf") as HTMLButtonElement;
    expect(sampleBtn.disabled).toBe(false);

    // The real Generate button must still be disabled (canGeneratePdf = false).
    const realBtn = h.getByTestId("button-generate-pdf") as HTMLButtonElement;
    expect(realBtn.disabled).toBe(true);
  });

  it("sample PDF contains SPECIMEN watermark notice and placeholder data", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));

    await waitFor(() => {
      expect(pdfTextLines.some((l) => l.includes("SAMPLE"))).toBe(true);
    });

    // SAMPLE notice banner text is present.
    const allText = pdfTextLines.join(" ");
    expect(allText).toMatch(/SAMPLE.*SPECIMEN|SPECIMEN.*SAMPLE/i);

    // Placeholder declarant name.
    expect(allText).toContain("Jane Q. Sample");

    // Placeholder nonce is present (not a real random hex nonce).
    expect(allText).toContain("SAMPLE0000000000");

    // The two sample Bitcoin addresses appear.
    expect(allText).toContain("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect(allText).toContain("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2");
  });

  it("sample PDF never contains a genuine 64-hex SHA-256 fingerprint", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));

    await waitFor(() => {
      expect(pdfTextLines.some((l) => l.includes("SAMPLE"))).toBe(true);
    });

    // Find the line that follows "Content Fingerprint (SHA-256):" — it must NOT
    // be a 64-character lowercase hex string (i.e. not a real hash).
    const allText = pdfTextLines.join("\n");
    const fpIdx = allText.indexOf("Content Fingerprint (SHA-256):");
    expect(fpIdx).toBeGreaterThanOrEqual(0);

    const afterFp = allText.slice(fpIdx);
    // Must contain the SPECIMEN notice, not a hex digest.
    expect(afterFp).toContain("SPECIMEN");
    // Must NOT contain a standalone 64-character hex string.
    expect(afterFp).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  it("glossary section appears when toggled ON and is absent when toggled OFF", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);

    // Glossary is OFF by default — sample PDF must not contain glossary header.
    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));
    await waitFor(() => {
      expect(pdfTextLines.some((l) => l.includes("SAMPLE"))).toBe(true);
    });

    const withoutGlossary = [...pdfTextLines];
    expect(withoutGlossary.some((l) => l.includes("GLOSSARY OF TERMS"))).toBe(false);

    // Toggle glossary ON.
    pdfTextLines.length = 0;
    fireEvent.click(h.getByTestId("switch-include-glossary"));

    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));
    await waitFor(() => {
      const count = pdfTextLines.filter((l) => l.includes("SAMPLE")).length;
      expect(count).toBeGreaterThan(0);
    });

    expect(pdfTextLines.some((l) => l.includes("GLOSSARY OF TERMS"))).toBe(true);
  });

  it("AML section appears when toggled ON and is absent when toggled OFF", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);

    // AML is OFF by default.
    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));
    await waitFor(() => {
      expect(pdfTextLines.some((l) => l.includes("SAMPLE"))).toBe(true);
    });

    expect(pdfTextLines.some((l) => l.includes("AML / RISK SCREENING"))).toBe(false);

    // Toggle AML ON.
    pdfTextLines.length = 0;
    fireEvent.click(h.getByTestId("switch-include-aml"));

    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));
    await waitFor(() => {
      const count = pdfTextLines.filter((l) => l.includes("SAMPLE")).length;
      expect(count).toBeGreaterThan(0);
    });

    expect(pdfTextLines.some((l) => l.includes("AML / RISK SCREENING"))).toBe(true);
  });

  it("attestation section appears when toggled ON and is absent when toggled OFF", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);

    // Attestation is OFF by default (persisted pref from empty DB).
    // Generate once to capture the baseline.
    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));
    await waitFor(() => {
      expect(pdfTextLines.some((l) => l.includes("SAMPLE"))).toBe(true);
    });

    const noAttestation = pdfTextLines.some((l) => l.includes("FORMAL ATTESTATION"));

    // Toggle attestation (if OFF, turn ON; assert it appears, then turn off).
    pdfTextLines.length = 0;
    const attestSwitch = h.getByTestId("switch-include-attestation");
    fireEvent.click(attestSwitch);

    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));
    await waitFor(() => {
      const count = pdfTextLines.filter((l) => l.includes("SAMPLE")).length;
      expect(count).toBeGreaterThan(0);
    });

    const afterToggle = pdfTextLines.some((l) => l.includes("FORMAL ATTESTATION"));
    // After toggling, the attestation presence should have flipped.
    expect(afterToggle).toBe(!noAttestation);
  });

  it("sample PDF always contains a Proof-of-Control appendix for the sample verified address", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));

    await waitFor(() => {
      expect(pdfTextLines.some((l) => l.includes("SAMPLE"))).toBe(true);
    });

    expect(pdfTextLines.some((l) => l.includes("PROOF-OF-CONTROL EVIDENCE"))).toBe(true);
    expect(
      pdfTextLines.some((l) => l.includes("SAMPLE_SIGNATURE_PLACEHOLDER_NOT_VALID")),
    ).toBe(true);
  });

  it("placeholder AML attestation lines use sample source-of-wealth/funds in the AML section", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);

    fireEvent.click(h.getByTestId("switch-include-aml"));

    pdfTextLines.length = 0;
    fireEvent.click(h.getByTestId("button-generate-sample-pdf"));

    await waitFor(() => {
      const count = pdfTextLines.filter((l) => l.includes("SAMPLE")).length;
      expect(count).toBeGreaterThan(0);
    });

    const allText = pdfTextLines.join(" ");
    expect(allText).toContain("Sample employment income");
    expect(allText).toContain("Sample savings");
  });
});
