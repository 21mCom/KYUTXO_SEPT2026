// Declaration body: sample notice banner, title, optional introduction,
// declarant details, statement, data source attestation, address balances
// table, and totals. Extracted verbatim from the pre-split builder.
import { formatBTC } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { DECLARATION_INTRO_PARAGRAPHS } from "./declaration-prefs";
import type { PdfLayout, PofPdfData } from "./pof-pdf-context";

export function renderDeclarationBody(L: PdfLayout, d: PofPdfData) {
  const { doc, autoTable, margin, contentW } = L;
  const { addLine, addWrapped, addSpacer, checkPageBreak } = L;
  const {
    isSample,
    effName,
    effContact,
    effResidential,
    effDob,
    effTaxId,
    effIdNumber,
    effNationality,
    effDate,
    effPurpose,
    effStatement,
    effNonce,
    effRows,
    effTotalSats,
    effFiatValid,
    effFiatTotal,
    effFiatCurrency,
    effFiatRate,
    effSummary,
  } = d;
  const { includeIntro } = d.params;

  // ── Sample notice banner (sample mode only) ───────────────────────────────
  if (isSample) {
    doc.setFillColor(255, 210, 210);
    doc.setDrawColor(200, 80, 80);
    doc.rect(margin, L.y - 4, contentW, 13, "FD");
    doc.setFontSize(8.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(160, 0, 0);
    const noticeLines = doc.splitTextToSize(
      sanitizePdfText(
        "SAMPLE / SPECIMEN — NOT A VALID DECLARATION. This document is a layout preview only. All data is fictitious."
      ),
      contentW - 4
    ) as string[];
    doc.text(noticeLines, margin + 2, L.y + 2.5);
    L.y += noticeLines.length * 8.5 * 0.45 + 10;
    doc.setTextColor(0, 0, 0);
  }

  // ── Title ──────────────────────────────────────────────────────────────
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("PROOF OF FUNDS DECLARATION", margin, L.y);
  L.y += 10;

  doc.setLineWidth(0.5);
  doc.line(margin, L.y, margin + contentW, L.y);
  L.y += 5;

  // ── Optional Introduction / Preface ─────────────────────────────────────
  // Rendered at the very top, before the declarant details, when enabled.
  if (includeIntro) {
    checkPageBreak(30);
    addLine("INTRODUCTION", 11, true);
    addSpacer(2);
    for (const paragraph of DECLARATION_INTRO_PARAGRAPHS) {
      checkPageBreak(24);
      addWrapped(paragraph);
      addSpacer(2);
    }
    addSpacer(3);
  }

  // ── Declarant Details ──────────────────────────────────────────────────
  addLine("DECLARANT DETAILS", 11, true);
  addSpacer(2);
  addLine(`Full Name: ${effName}`, 10);
  addSpacer(1);
  if (effContact.trim()) {
    addLine(`Contact / Address: ${effContact}`, 10);
    addSpacer(1);
  }
  if (effResidential.trim()) {
    addLine(`Residential / Street Address: ${effResidential}`, 10);
    addSpacer(1);
  }
  if (effDob.trim()) {
    addLine(`Date of Birth: ${effDob}`, 10);
    addSpacer(1);
  }
  if (effTaxId.trim()) {
    addLine(`Tax ID Number: ${effTaxId}`, 10);
    addSpacer(1);
  }
  if (effIdNumber.trim()) {
    addLine(`Identification Number: ${effIdNumber}`, 10);
    addSpacer(1);
  }
  if (effNationality.trim()) {
    addLine(`Nationality: ${effNationality}`, 10);
    addSpacer(1);
  }
  addLine(`Declaration Date: ${effDate}`, 10);
  addSpacer(1);
  addLine(`Purpose: ${effPurpose}`, 10);
  addSpacer(1);
  addLine(`Declaration Reference: ${effNonce}`, 10);
  addSpacer(4);

  // ── Statement ──────────────────────────────────────────────────────────
  if (effStatement.trim()) {
    addLine("DECLARATION STATEMENT", 11, true);
    addSpacer(2);
    addWrapped(effStatement);
    addSpacer(4);
  }

  // ── Data Source Attestation ────────────────────────────────────────────
  addLine("DATA SOURCE ATTESTATION", 11, true);
  addSpacer(2);
  if (effSummary) {
    addWrapped(effSummary.asOfLabel);
  } else if (isSample) {
    addWrapped("Sample data — balance figures are fictitious placeholders, not sourced from the blockchain.");
  }
  addSpacer(4);

  // ── Address Balances Table ─────────────────────────────────────────────
  addLine("BITCOIN ADDRESS BALANCES", 11, true);
  addSpacer(2);

  const tableStartY = L.y;
  const tableBody = effRows.map((r) => {
    const ctrlLabel = r.verified ? "Control Verified" : "Self-Declared (Unverified)";
    return [
      sanitizePdfText(r.raw),
      `${formatBTC(r.balanceSats)} BTC`,
      sanitizePdfText(ctrlLabel),
    ];
  });

  autoTable(doc, {
    startY: tableStartY,
    head: [["Bitcoin Address", "Balance (BTC)", "Control Status"]],
    body: tableBody,
    margin: { left: margin, right: margin },
    styles: { fontSize: 7.5, font: "helvetica", cellPadding: 2 },
    headStyles: { fillColor: [40, 40, 40], textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: contentW * 0.55, font: "courier" },
      1: { cellWidth: contentW * 0.22, halign: "right" },
      2: { cellWidth: contentW * 0.23 },
    },
    didParseCell: (data: any) => {
      if (data.column.index === 2 && data.section === "body") {
        const row = effRows[data.row.index];
        if (row?.verified) {
          data.cell.styles.textColor = [0, 120, 0];
        }
      }
    },
    didDrawPage: () => { /* allow page breaks */ },
  });

  L.y = (doc as any).lastAutoTable.finalY + 6;

  // ── Totals ─────────────────────────────────────────────────────────────
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(`TOTAL: ${formatBTC(effTotalSats)} BTC`, margin, L.y);
  L.y += 5;

  if (effFiatValid && effFiatTotal !== null) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    const fiatLineSuffix = isSample ? " — SAMPLE RATE" : "";
    const fiatLine = `Fiat equivalent: ${effFiatTotal.toLocaleString("en-US", {
      style: "currency",
      currency: effFiatCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} (at ${sanitizePdfText(effFiatCurrency)} ${sanitizePdfText(effFiatRate.toLocaleString("en-US", { maximumFractionDigits: 2 }))} per BTC)${fiatLineSuffix}`;
    const fiatLines = doc.splitTextToSize(sanitizePdfText(fiatLine), contentW) as string[];
    doc.text(fiatLines, margin, L.y);
    L.y += fiatLines.length * 4;
    doc.setTextColor(120, 80, 0);
    const disclaimerLines = doc.splitTextToSize(
      sanitizePdfText(
        "DISCLAIMER: Exchange rate supplied by declarant. This is not a market quote or financial advice."
      ),
      contentW
    ) as string[];
    doc.text(disclaimerLines, margin, L.y);
    doc.setTextColor(0, 0, 0);
    L.y += disclaimerLines.length * 4 + 1;
  }

  addSpacer(4);
}
