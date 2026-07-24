// AML / Risk Screening appendix. Extracted verbatim from the pre-split
// builder — zero behavior change.
import { truncateAddress } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { buildAttestationLines } from "@/lib/attestationLines";
import {
  AML_APPENDIX_STRINGS,
  buildScreeningDateLine,
  buildAddressesScreenedLine,
  buildDirectMatchResultLine,
  buildEntityListDescription,
  buildNearestEntityLine,
} from "@/lib/amlAppendixStrings";
import { runAmlScreening } from "./aml-screening";
import type { PdfLayout, PofPdfData } from "./pof-pdf-context";

export async function renderAmlSection(L: PdfLayout, d: PofPdfData) {
  const { doc, autoTable, margin, contentW } = L;
  const { addLine, addWrapped, addSpacer, checkPageBreak } = L;
  const { isSample, effRows, effDate } = d;
  const {
    includeAml,
    doneRows,
    amlPepStatus,
    amlSourceOfWealth,
    amlSourceOfFunds,
    amlTaxJurisdiction,
    amlTaxStatement,
  } = d.params;

  if (!(includeAml && effRows.length > 0)) return;

  const amlResult = isSample
    ? {
        screeningDate: effDate,
        screenedCount: effRows.length,
        directMatches: [] as Array<{ address: string; entityName: string; categoryLabel: string }>,
        hasGraphData: false,
        nearestHopDistance: null as null | number,
        nearestHopEntityName: null as string | null,
        nearestHopCategoryLabel: null as string | null,
        entityListSource: "bundled" as const,
        entityListCount: 0,
        entityListImportedAt: null as null | number,
        entityListSourceLabel: null as string | null,
      }
    : await runAmlScreening(doneRows.map((r) => r.raw));

  doc.addPage();
  L.y = 20;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("APPENDIX: AML / RISK SCREENING", margin, L.y);
  L.y += 8;
  doc.setLineWidth(0.5);
  doc.line(margin, L.y, margin + contentW, L.y);
  L.y += 5;

  addLine(AML_APPENDIX_STRINGS.screeningParametersHeading, 10, true);
  addSpacer(2);
  addLine(
    sanitizePdfText(buildScreeningDateLine(amlResult.screeningDate)),
    9
  );
  addSpacer(1);
  addLine(
    buildEntityListDescription(amlResult, sanitizePdfText),
    9
  );
  addSpacer(1);
  addLine(buildAddressesScreenedLine(amlResult.screenedCount), 9);
  addSpacer(5);

  checkPageBreak(30);
  addLine(AML_APPENDIX_STRINGS.directMatchResultsHeading, 10, true);
  addSpacer(2);
  if (amlResult.directMatches.length === 0) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 120, 0);
    doc.text(AML_APPENDIX_STRINGS.noDirectMatchesResult, margin, L.y);
    doc.setTextColor(0, 0, 0);
    L.y += 5;
    addWrapped(AML_APPENDIX_STRINGS.noDirectMatchesDetail, 9);
  } else {
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(160, 0, 0);
    doc.text(
      buildDirectMatchResultLine(amlResult.directMatches.length),
      margin,
      L.y
    );
    doc.setTextColor(0, 0, 0);
    L.y += 5;

    autoTable(doc, {
      startY: L.y,
      head: [["Address", "Entity Name", "Category"]],
      body: amlResult.directMatches.map((m) => [
        sanitizePdfText(truncateAddress(m.address, 8, 8)),
        sanitizePdfText(m.entityName),
        sanitizePdfText(m.categoryLabel),
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, font: "helvetica", cellPadding: 2, overflow: "linebreak" },
      headStyles: { fillColor: [120, 0, 0], textColor: [255, 255, 255], fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: contentW * 0.38, font: "courier" },
        1: { cellWidth: contentW * 0.40 },
        2: { cellWidth: contentW * 0.22 },
      },
      didDrawPage: () => {},
    });
    L.y = (doc as any).lastAutoTable.finalY + 5;
  }
  addSpacer(5);

  checkPageBreak(25);
  addLine(AML_APPENDIX_STRINGS.indirectProximityAnalysisHeading, 10, true);
  addSpacer(2);
  if (!amlResult.hasGraphData) {
    addWrapped(AML_APPENDIX_STRINGS.noGraphDataDetail, 9, [80, 80, 80]);
  } else if (amlResult.nearestHopDistance === null) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 120, 0);
    doc.text(AML_APPENDIX_STRINGS.noProximityMatchResult, margin, L.y);
    doc.setTextColor(0, 0, 0);
    L.y += 5;
    addWrapped(AML_APPENDIX_STRINGS.noProximityMatchDetail, 9);
  } else {
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 0);
    const proximityLine = buildNearestEntityLine(
      {
        nearestHopDistance: amlResult.nearestHopDistance,
        nearestHopEntityName: amlResult.nearestHopEntityName,
        nearestHopCategoryLabel: amlResult.nearestHopCategoryLabel,
      },
      sanitizePdfText
    );
    const proxLines = doc.splitTextToSize(sanitizePdfText(proximityLine), contentW) as string[];
    doc.text(proxLines, margin, L.y);
    L.y += proxLines.length * 9 * 0.45 + 2;
  }
  addSpacer(5);

  checkPageBreak(60);
  addLine(AML_APPENDIX_STRINGS.declarantSelfAttestationsHeading, 10, true);
  addSpacer(2);

  // Built from the SAME shared builder as the on-screen attestation
  // preview (see `attestationPreviewLines`), differing only by the
  // sanitizePdfText transform applied here to user-supplied values, so the
  // preview can never silently drift from what this section renders.
  const attestationLines = buildAttestationLines(
    {
      pepStatus: isSample ? "no" : amlPepStatus,
      sourceOfWealth: isSample ? "Sample employment income" : amlSourceOfWealth,
      sourceOfFunds: isSample ? "Sample savings" : amlSourceOfFunds,
      taxJurisdiction: isSample ? "Sampleland" : amlTaxJurisdiction,
      taxStatement: isSample ? "" : amlTaxStatement,
    },
    sanitizePdfText,
  );
  for (const line of attestationLines) {
    addWrapped(line, 9);
    addSpacer(2);
  }

  addWrapped(AML_APPENDIX_STRINGS.generalAttestation, 9);
  addSpacer(6);

  checkPageBreak(35);
  addLine(AML_APPENDIX_STRINGS.screeningDisclaimerHeading, 10, true);
  addSpacer(2);
  addWrapped(AML_APPENDIX_STRINGS.screeningDisclaimer, 8, [80, 80, 80]);
}
