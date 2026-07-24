// Acquisition & Provenance appendix. Extracted verbatim from the pre-split
// builder — zero behavior change.
import { formatBTC, truncateAddress } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { getRecordsByType } from "@/lib/data/record-crud";
import { getLatestPriceOnOrBefore } from "@/lib/data/price-data-crud";
import { getAttachmentsByRecordId } from "@/lib/data/attachments-crud";
import { ACQUISITION_METHOD_OPTIONS, COUNTERPARTY_TYPE_OPTIONS } from "@/lib/db-types";
import type { PdfLayout, PofPdfData } from "./pof-pdf-context";

export async function renderProvenanceSection(L: PdfLayout, d: PofPdfData) {
  const { doc, autoTable, margin, contentW } = L;
  const { checkPageBreak } = L;
  const {
    isSample,
    effRows,
    effTotalSats,
    effFiatValid,
    effFiatTotal,
    effFiatCurrency,
    effFiatRate,
    sampleEffRows,
  } = d;
  const { includeProvenance, provenanceFiatCurrency, doneRows } = d.params;

  if (!(includeProvenance && effRows.length > 0)) return;

  interface ProvenanceEntry {
    address: string;
    label: string;
    acquisitionDate: string;
    acquisitionMethod: string;
    counterpartyName: string;
    btcAmountSats: number;
    costBasisFiat: string;
    priceInfo: string;
    hasRecord: boolean;
    attachmentNames: string[];
  }

  let provenanceEntries: ProvenanceEntry[];
  let allSupportingDocs: string[];
  let totalCostBasis: number;
  let hasCostBasis: boolean;

  if (isSample) {
    // Hardcoded fictitious entries — one per sample address
    provenanceEntries = [
      {
        address: sampleEffRows[0].raw,
        label: "Sample Long-Term Hold",
        acquisitionDate: "2021-03-15",
        acquisitionMethod: "Exchange Purchase",
        counterpartyName: "Kraken (sample)",
        btcAmountSats: 125_000_000,
        costBasisFiat: "USD 72,500.00 (user-supplied)",
        priceInfo: "",
        hasRecord: true,
        attachmentNames: ["sample-purchase-receipt.pdf"],
      },
      {
        address: sampleEffRows[1].raw,
        label: "Sample Mining Reward",
        acquisitionDate: "2020-05-01",
        acquisitionMethod: "Mining",
        counterpartyName: "Self-Mined (sample)",
        btcAmountSats: 75_000_000,
        costBasisFiat: "USD 37,000.00 (user-supplied)",
        priceInfo: "",
        hasRecord: true,
        attachmentNames: ["sample-mining-record.csv"],
      },
    ];
    allSupportingDocs = ["sample-purchase-receipt.pdf", "sample-mining-record.csv"];
    totalCostBasis = 109_500;
    hasCostBasis = true;
  } else {
    // Real DB lookup path
    provenanceEntries = [];
    allSupportingDocs = [];
    totalCostBasis = 0;
    hasCostBasis = false;

    const allAddrRecords = await getRecordsByType("address");
    const recordByAddress = new Map<string, (typeof allAddrRecords)[0]>();
    for (const rec of allAddrRecords) {
      recordByAddress.set(rec.inputString, rec);
    }

    for (const row of doneRows) {
      const rec = recordByAddress.get(row.raw);
      const balanceSats = row.balanceSats ?? 0;

      if (!rec) {
        provenanceEntries.push({
          address: row.raw,
          label: "",
          acquisitionDate: "No vault record",
          acquisitionMethod: "No vault record",
          counterpartyName: "No vault record",
          btcAmountSats: balanceSats,
          costBasisFiat: "Not recorded",
          priceInfo: "",
          hasRecord: false,
          attachmentNames: [],
        });
        continue;
      }

      // Acquisition date
      const acquisitionDate = rec.date ? rec.date : "Not recorded";

      // Acquisition method label
      const methodOpt = ACQUISITION_METHOD_OPTIONS.find((o) => o.value === rec.acquisitionMethod);
      const acquisitionMethod = methodOpt?.label ?? (rec.acquisitionMethod ? rec.acquisitionMethod : "Not recorded");

      // Counterparty / source name
      const counterpartyTypeOpt = COUNTERPARTY_TYPE_OPTIONS.find((o) => o.value === rec.counterpartyType);
      const counterpartyName =
        (rec.counterpartyName?.trim() || "") !== ""
          ? rec.counterpartyName!.trim()
          : (rec.walletName?.trim() || "") !== ""
          ? rec.walletName!.trim()
          : (rec.label?.trim() || "") !== ""
          ? rec.label.trim()
          : counterpartyTypeOpt
          ? counterpartyTypeOpt.label
          : "Not recorded";

      // Cost basis / fiat value at acquisition
      let costBasisFiat = "Not recorded";
      let priceInfo = "";

      if (rec.costBasisUsd !== undefined && rec.costBasisUsd > 0) {
        const formatted = rec.costBasisUsd.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        costBasisFiat = `USD ${formatted} (user-supplied)`;
        totalCostBasis += rec.costBasisUsd;
        hasCostBasis = true;
      } else if (rec.date) {
        const priceRow = await getLatestPriceOnOrBefore(rec.date, provenanceFiatCurrency, "BTC");
        if (priceRow) {
          const computedBasis = (balanceSats / 1e8) * priceRow.close;
          const formatted = computedBasis.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          costBasisFiat = `${provenanceFiatCurrency} ${formatted}`;
          const rateSource = priceRow.source ? priceRow.source : "vault price store";
          priceInfo = `Rate: ${provenanceFiatCurrency} ${priceRow.close.toLocaleString()} on ${priceRow.date} (source: ${rateSource})`;
          totalCostBasis += computedBasis;
          hasCostBasis = true;
        } else {
          costBasisFiat = "Not recorded";
          priceInfo = `No ${provenanceFiatCurrency} price data for ${rec.date} (source: vault price store)`;
        }
      }

      // Attachments linked to this record
      const attachments = rec.id !== undefined ? await getAttachmentsByRecordId(rec.id) : [];
      const attachmentNames = attachments.map((a) => a.filename);
      allSupportingDocs.push(...attachmentNames);

      provenanceEntries.push({
        address: row.raw,
        label: rec.label || "",
        acquisitionDate,
        acquisitionMethod,
        counterpartyName,
        btcAmountSats: balanceSats,
        costBasisFiat,
        priceInfo,
        hasRecord: true,
        attachmentNames,
      });
    }
  } // end if (isSample) else

  // Start a new page for the provenance appendix
  doc.addPage();
  L.y = 20;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("APPENDIX: ACQUISITION & PROVENANCE", margin, L.y);
  L.y += 8;
  doc.setLineWidth(0.5);
  doc.line(margin, L.y, margin + contentW, L.y);
  L.y += 5;

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  const provenanceIntroLines = doc.splitTextToSize(
    sanitizePdfText(
      "The following table documents the acquisition history for the declared Bitcoin addresses. " +
      "Data is sourced from the declarant's KYUTXO vault records. Addresses without vault records " +
      "or acquisition metadata are shown as \"Not recorded\". Historical fiat values are estimates " +
      "based on stored price data; they may not reflect the actual transaction price."
    ),
    contentW
  ) as string[];
  doc.text(provenanceIntroLines, margin, L.y);
  L.y += provenanceIntroLines.length * 8.5 * 0.45 + 5;

  // Per-source table
  const provTableHead = [[
    "Address",
    "Date Acquired",
    "Acquisition Method",
    "Counterparty / Source",
    `BTC Amount`,
    `Cost Basis (${provenanceFiatCurrency})`,
  ]];
  const provTableBody = provenanceEntries.map((e) => [
    sanitizePdfText(truncateAddress(e.address, 8, 8)),
    sanitizePdfText(e.acquisitionDate),
    sanitizePdfText(e.acquisitionMethod),
    sanitizePdfText(e.counterpartyName),
    sanitizePdfText(`${formatBTC(e.btcAmountSats)} BTC`),
    sanitizePdfText(e.costBasisFiat),
  ]);

  autoTable(doc, {
    startY: L.y,
    head: provTableHead,
    body: provTableBody,
    margin: { left: margin, right: margin },
    styles: { fontSize: 7, font: "helvetica", cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [40, 40, 40], textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: contentW * 0.19, font: "courier" },
      1: { cellWidth: contentW * 0.13 },
      2: { cellWidth: contentW * 0.17 },
      3: { cellWidth: contentW * 0.19 },
      4: { cellWidth: contentW * 0.14, halign: "right" },
      5: { cellWidth: contentW * 0.18, halign: "right" },
    },
    didDrawPage: () => {},
  });

  L.y = (doc as any).lastAutoTable.finalY + 5;

  // Price rate notes (one per entry that has a note)
  const priceNotes = provenanceEntries.filter((e) => e.priceInfo);
  if (priceNotes.length > 0) {
    checkPageBreak(10 + priceNotes.length * 5);
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(100, 100, 100);
    for (const e of priceNotes) {
      const noteText = `${truncateAddress(e.address, 8, 8)}: ${e.priceInfo}`;
      doc.text(sanitizePdfText(noteText), margin, L.y);
      L.y += 4;
    }
    doc.setTextColor(0, 0, 0);
    L.y += 2;
  }

  // Summary line
  checkPageBreak(35);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("PROVENANCE SUMMARY", margin, L.y);
  L.y += 5;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(sanitizePdfText(`Total BTC (declared addresses): ${formatBTC(effTotalSats)} BTC`), margin, L.y);
  L.y += 4.5;

  if (hasCostBasis) {
    const costStr = totalCostBasis.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    doc.text(sanitizePdfText(`Total Cost Basis: ${provenanceFiatCurrency} ${costStr}`), margin, L.y);
    L.y += 4.5;
  }

  if (effFiatValid && effFiatTotal !== null) {
    const currentStr = effFiatTotal.toLocaleString("en-US", {
      style: "currency",
      currency: effFiatCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    doc.text(
      sanitizePdfText(
        `Current Value: ${currentStr} ${effFiatCurrency} (at declarant-supplied rate of ${effFiatRate.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${effFiatCurrency}/BTC)`
      ),
      margin,
      L.y
    );
    L.y += 4.5;

    if (hasCostBasis && effFiatCurrency === provenanceFiatCurrency && totalCostBasis > 0) {
      const gainLoss = effFiatTotal - totalCostBasis;
      const pct = ((gainLoss / totalCostBasis) * 100).toFixed(1);
      const gainStr = gainLoss.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      doc.text(
        sanitizePdfText(
          `Unrealized Gain/Loss: ${gainLoss >= 0 ? "+" : ""}${effFiatCurrency} ${gainStr} (${gainLoss >= 0 ? "+" : ""}${pct}%)`
        ),
        margin,
        L.y
      );
      L.y += 4.5;
    }
  }

  L.y += 3;

  // Supporting documents list
  checkPageBreak(20);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("SUPPORTING DOCUMENTS", margin, L.y);
  L.y += 5;

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");

  if (allSupportingDocs.length === 0) {
    doc.setTextColor(100, 100, 100);
    doc.text("No file attachments are linked to the declared records in vault.", margin, L.y);
    doc.setTextColor(0, 0, 0);
    L.y += 5;
  } else {
    for (const name of allSupportingDocs) {
      checkPageBreak(8);
      doc.text(sanitizePdfText(`\u2022 ${name}`), margin + 3, L.y);
      L.y += 4.5;
    }
    L.y += 2;
  }

  // Disclaimer note
  checkPageBreak(15);
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(100, 100, 100);
  const provNoteLines = doc.splitTextToSize(
    sanitizePdfText(
      "Disclaimer: Acquisition data is taken from the declarant's KYUTXO vault records at the time of generation. " +
      "Historical fiat values are estimates from stored price history and may not equal the actual price paid. " +
      "User-supplied cost basis figures are as entered by the declarant. " +
      "This section is informational only and does not constitute financial, tax, or legal advice."
    ),
    contentW
  ) as string[];
  doc.text(provNoteLines, margin, L.y);
  L.y += provNoteLines.length * 7.5 * 0.45 + 4;
  doc.setTextColor(0, 0, 0);
}
