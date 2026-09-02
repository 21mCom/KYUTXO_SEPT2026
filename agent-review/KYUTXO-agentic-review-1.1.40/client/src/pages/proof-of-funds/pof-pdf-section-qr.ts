// Balance-Verification QR Codes section. Extracted verbatim from the
// pre-split builder — zero behavior change.
import QRCode from "qrcode";
import { formatBTC } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { getExplorer } from "./explorer-helpers";
import type { PdfLayout, PofPdfData } from "./pof-pdf-context";

export async function renderQrSection(L: PdfLayout, d: PofPdfData) {
  const { doc, margin, contentW } = L;
  const { addLine, addWrapped, addSpacer, checkPageBreak } = L;
  const { effRows } = d;
  const { includeQr, qrExplorerId } = d.params;

  if (!(includeQr && effRows.length > 0)) return;

  const qrExplorer = getExplorer(qrExplorerId);

  // Pre-generate every QR code offline (data: URLs, no network).
  const qrMap = new Map<string, string>();
  for (const r of effRows) {
    try {
      qrMap.set(
        r.raw,
        await QRCode.toDataURL(qrExplorer.addressUrl(r.raw), {
          width: 400,
          margin: 1,
          errorCorrectionLevel: "M",
        })
      );
    } catch {
      // Skip a single failed code rather than aborting the whole PDF.
    }
  }

  checkPageBreak(30);
  addLine("BALANCE VERIFICATION QR CODES", 11, true);
  addSpacer(2);
  addWrapped(
    `Scan a code below to view that address on ${qrExplorer.host} and confirm its balance. ` +
      "These QR codes link to a public, third-party block explorer; opening them requires internet access " +
      "and shares the address with that explorer. KYUTXO made no network requests to generate this document.",
    8.5
  );
  addSpacer(2);

  const qrSize = 30; // mm
  const qrGap = 6;
  const textX = margin + qrSize + 4;
  const textW = contentW - qrSize - 4;

  for (const r of effRows) {
    const dataUrl = qrMap.get(r.raw);
    checkPageBreak(qrSize + qrGap);
    const blockTop = L.y;

    if (dataUrl) {
      doc.addImage(dataUrl, "PNG", margin, blockTop, qrSize, qrSize);
    }

    // Address + explorer URL to the right of the code.
    let ty = blockTop + 4;
    doc.setFont("courier", "normal");
    doc.setFontSize(8);
    doc.setTextColor(0, 0, 0);
    const addrLines = doc.splitTextToSize(sanitizePdfText(r.raw), textW) as string[];
    doc.text(addrLines, textX, ty);
    ty += addrLines.length * 8 * 0.45 + 2;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(0, 0, 0);
    doc.text(sanitizePdfText(`Balance: ${formatBTC(r.balanceSats)} BTC`), textX, ty);
    ty += 5;

    doc.setFontSize(7.5);
    doc.setTextColor(80, 80, 80);
    const urlLines = doc.splitTextToSize(
      sanitizePdfText(qrExplorer.addressUrl(r.raw)),
      textW
    ) as string[];
    doc.text(urlLines, textX, ty);

    doc.setTextColor(0, 0, 0);
    L.y = Math.max(blockTop + qrSize, ty + urlLines.length * 7.5 * 0.45) + qrGap;
  }

  addSpacer(2);
}
