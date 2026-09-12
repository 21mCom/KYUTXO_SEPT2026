// Unit coverage for the offline PDF merge helpers (pdf-lib, Uint8Array only).
//
// These build tiny in-memory PDFs with pdf-lib itself, then assert that
// mergeEvidencePdfs appends every exhibit's pages in order and that the
// validation helpers fail loudly on unreadable input.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mergeEvidencePdfs, countPdfPages, type PdfExhibit } from "@/lib/pdfMerge";

async function makePdf(pageCount: number, side = 200): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([side, side]);
  return doc.save();
}

describe("pdfMerge", () => {
  describe("countPdfPages", () => {
    it("returns the page count of a valid PDF", async () => {
      expect(await countPdfPages(await makePdf(3))).toBe(3);
    });

    it("throws a clear error on non-PDF bytes", async () => {
      await expect(countPdfPages(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
        /could not be read as a PDF/i,
      );
    });
  });

  describe("mergeEvidencePdfs", () => {
    it("returns base page count unchanged when no exhibits are supplied", async () => {
      const merged = await mergeEvidencePdfs(await makePdf(2), []);
      const out = await PDFDocument.load(merged);
      expect(out.getPageCount()).toBe(2);
    });

    it("appends exhibit pages: total = base + sum(exhibit pages)", async () => {
      const base = await makePdf(1);
      const ex1 = await makePdf(2);
      const ex2 = await makePdf(3);
      const merged = await mergeEvidencePdfs(base, [
        { name: "a.pdf", bytes: ex1 },
        { name: "b.pdf", bytes: ex2 },
      ]);
      const out = await PDFDocument.load(merged);
      expect(out.getPageCount()).toBe(6);
    });

    it("preserves exhibit order (verified via per-document page sizes)", async () => {
      const base = await makePdf(1, 200);
      const ex1 = await makePdf(2, 300);
      const ex2 = await makePdf(1, 400);
      const merged = await mergeEvidencePdfs(base, [
        { name: "first.pdf", bytes: ex1 },
        { name: "second.pdf", bytes: ex2 },
      ]);
      const out = await PDFDocument.load(merged);
      const widths = out.getPages().map((p) => Math.round(p.getWidth()));
      // base (200), then exhibit1's two pages (300, 300), then exhibit2 (400).
      expect(widths).toEqual([200, 300, 300, 400]);
    });

    it("aborts with a file-named error when an exhibit is unreadable", async () => {
      const base = await makePdf(1);
      const bad: PdfExhibit = {
        name: "broken.pdf",
        bytes: new Uint8Array([9, 9, 9]),
      };
      await expect(mergeEvidencePdfs(base, [bad])).rejects.toThrow(/broken\.pdf/);
    });
  });
});
