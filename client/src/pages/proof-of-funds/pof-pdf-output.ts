// Final output step: page X of Y footers, SPECIMEN watermark (sample mode),
// filename, and save (with pdf-lib merge when PDF exhibits are attached).
// Extracted verbatim from the pre-split builder — zero behavior change.
import { sanitizePdfText } from "@/lib/pdfText";
import { mergeEvidencePdfs, type PdfExhibit } from "@/lib/pdfMerge";
import type { PdfLayout, PofPdfData } from "./pof-pdf-context";

export async function finalizeAndSavePdf(L: PdfLayout, d: PofPdfData) {
  const { doc, margin, pageW } = L;
  const { isSample, effNonce, effName, effDate } = d;
  const { evidenceItems } = d.params;

  // ── Page X of Y footers (applied to every page after all content) ──────
  const totalPages = (doc.internal as any).getNumberOfPages();
  const pageHFt = doc.internal.pageSize.getHeight();
  const footerY = pageHFt - 8;
  const shortRef = effNonce.length > 20
    ? `${effNonce.slice(0, 10)}…${effNonce.slice(-8)}`
    : effNonce;
  const hasPdfExhibits =
    !isSample && evidenceItems.some((it) => it.kind === "pdf");

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    doc.setPage(pageNum);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(120, 120, 120);
    doc.text(
      sanitizePdfText(
        `Page ${pageNum} of ${totalPages}${hasPdfExhibits ? " + exhibits" : ""}`,
      ),
      margin,
      footerY
    );
    doc.text(
      sanitizePdfText(`Ref: ${shortRef}`),
      pageW / 2,
      footerY,
      { align: "center" }
    );
    doc.text(
      sanitizePdfText(isSample ? "PROOF OF FUNDS DECLARATION — SPECIMEN" : "PROOF OF FUNDS DECLARATION"),
      pageW - margin,
      footerY,
      { align: "right" }
    );
    doc.setTextColor(0, 0, 0);
  }

  // ── Diagonal watermark on every page (sample mode only) ───────────────
  if (isSample) {
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      doc.setPage(pageNum);
      doc.setFontSize(52);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(220, 0, 0);
      doc.setGState(new (doc as any).GState({ opacity: 0.08 }));
      const cx = pageW / 2;
      const cy = pageHFt / 2;
      doc.text("SPECIMEN", cx, cy, { align: "center", angle: 45 });
      doc.setGState(new (doc as any).GState({ opacity: 1 }));
      doc.setTextColor(0, 0, 0);
    }
  }

  const safeName = sanitizePdfText(effName.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, ""));
  const baseFileName = isSample
    ? `proof-of-funds-SAMPLE-${safeName || "specimen"}-${effDate}.pdf`
    : `proof-of-funds-${safeName || "declaration"}-${effDate}.pdf`;

  // PDF exhibits can only be appended after the jsPDF document is complete:
  // jsPDF cannot import external PDF pages, so we hand the finished dossier
  // bytes plus each uploaded PDF to pdf-lib and download the combined file.
  // Image exhibits are already embedded above, so they need no merge. Sample
  // mode never attaches exhibits, so it always takes the plain save path.
  const pdfExhibits: PdfExhibit[] = isSample
    ? []
    : evidenceItems
        .filter((it) => it.kind === "pdf")
        .map((it) => ({ name: it.name, bytes: it.bytes }));

  if (pdfExhibits.length > 0) {
    const baseBytes = new Uint8Array(
      doc.output("arraybuffer") as ArrayBuffer,
    );
    const mergedBytes = await mergeEvidencePdfs(baseBytes, pdfExhibits);
    const blob = new Blob([mergedBytes as BlobPart], {
      type: "application/pdf",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = baseFileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  } else {
    doc.save(baseFileName);
  }
}
