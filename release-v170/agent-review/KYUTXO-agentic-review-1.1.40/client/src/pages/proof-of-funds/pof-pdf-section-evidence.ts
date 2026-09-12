// Supporting Evidence appendix (real declarations only). Extracted verbatim
// from the pre-split builder — zero behavior change.
import { formatEvidenceSize } from "./evidence-helpers";
import { SUPPORTING_EVIDENCE_APPENDIX_HEADING } from "./pof-pdf-strings";
import type { PdfLayout, PofPdfData } from "./pof-pdf-context";

export function renderEvidenceSection(L: PdfLayout, d: PofPdfData) {
  const { doc, margin, contentW } = L;
  const { addLine, addWrapped, addSpacer, checkPageBreak } = L;
  const { isSample } = d;
  const { evidenceItems } = d.params;

  // ── Supporting Evidence appendix (real declarations only) ──────────────
  // Image exhibits are embedded here; PDF exhibits are listed in the index
  // and then merged onto the end of the dossier (after this jsPDF document)
  // in the output step below. Skipped entirely in sample mode so specimen
  // PDFs never carry attachments and stay fully watermarked.
  if (!(!isSample && evidenceItems.length > 0)) return;

  doc.addPage();
  L.y = 20;
  addLine(SUPPORTING_EVIDENCE_APPENDIX_HEADING, 13, true);
  addSpacer(2);
  addWrapped(
    "The declarant attached the following supporting evidence. Image files are embedded in this appendix. " +
      "PDF documents are merged onto the end of this dossier as additional pages, in the order listed below. " +
      "Each item's SHA-256 hash is recorded so a reviewer can independently confirm the attachment has not been altered.",
    9,
    [60, 60, 60],
  );
  addSpacer(3);

  // Exhibit index — every attachment, in upload order.
  addLine("Evidence index", 11, true);
  addSpacer(1);
  let exhibitNo = 0;
  evidenceItems.forEach((it, i) => {
    const isPdf = it.kind === "pdf";
    const exhibitLabel = isPdf ? `Exhibit ${++exhibitNo}` : "Embedded image";
    const meta = isPdf
      ? `PDF, ${formatEvidenceSize(it.size)}, ${it.pageCount ?? "?"} page${it.pageCount === 1 ? "" : "s"}`
      : `Image, ${formatEvidenceSize(it.size)}`;
    checkPageBreak(20);
    addLine(`${i + 1}. ${it.name}  [${exhibitLabel}]`, 9, true);
    addWrapped(meta, 8, [90, 90, 90]);
    if (it.caption.trim()) {
      addWrapped(`Caption: ${it.caption.trim()}`, 8, [60, 60, 60]);
    }
    addWrapped(`SHA-256: ${it.sha256}`, 7, [120, 120, 120]);
    if (isPdf) {
      addWrapped(
        `Merged as ${exhibitLabel} — its ${it.pageCount ?? "?"} page${it.pageCount === 1 ? "" : "s"} follow after this appendix.`,
        8,
        [90, 90, 90],
      );
    }
    addSpacer(2);
  });

  // Embedded images.
  const imageItems = evidenceItems.filter(
    (it) => it.kind === "image" && it.dataUrl,
  );
  if (imageItems.length > 0) {
    addSpacer(2);
    checkPageBreak(16);
    addLine("Embedded images", 11, true);
    addSpacer(2);
    const pageH = doc.internal.pageSize.getHeight();
    for (const it of imageItems) {
      const fmt =
        it.mime === "image/png"
          ? "PNG"
          : it.mime === "image/webp"
            ? "WEBP"
            : "JPEG";
      let dispW = contentW;
      let dispH = contentW * 0.75; // fallback ratio if properties unavailable
      try {
        const props = doc.getImageProperties(it.dataUrl!);
        if (props.width > 0 && props.height > 0) {
          dispW = contentW;
          dispH = (props.height / props.width) * dispW;
          const maxH = pageH - 50;
          if (dispH > maxH) {
            dispH = maxH;
            dispW = (props.width / props.height) * dispH;
          }
        }
      } catch {
        // Keep the fallback size if jsPDF can't read the image header.
      }
      const captionH = it.caption.trim() ? 8 : 0;
      checkPageBreak(8 + dispH + captionH + 8);
      addLine(it.name, 9, true);
      doc.addImage(it.dataUrl!, fmt, margin, L.y, dispW, dispH);
      L.y += dispH + 3;
      if (it.caption.trim()) {
        addWrapped(`Caption: ${it.caption.trim()}`, 8, [60, 60, 60]);
      }
      addWrapped(`SHA-256: ${it.sha256}`, 7, [120, 120, 120]);
      addSpacer(4);
    }
  }
}
