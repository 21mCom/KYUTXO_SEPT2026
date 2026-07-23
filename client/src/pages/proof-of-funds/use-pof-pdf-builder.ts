import { useState, useCallback } from "react";
import QRCode from "qrcode";
import { useToast } from "@/hooks/use-toast";
import { formatBTC, truncateAddress } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { mergeEvidencePdfs, type PdfExhibit } from "@/lib/pdfMerge";
import { buildAttestationLines } from "@/lib/attestationLines";
import {
  AML_APPENDIX_STRINGS,
  buildScreeningDateLine,
  buildAddressesScreenedLine,
  buildDirectMatchResultLine,
  buildEntityListDescription,
  buildNearestEntityLine,
} from "@/lib/amlAppendixStrings";
import { computeStatsForAddresses } from "@/lib/data/address-stats";
import { getRecordsByType } from "@/lib/data/record-crud";
import { getLatestPriceOnOrBefore } from "@/lib/data/price-data-crud";
import { getAttachmentsByRecordId } from "@/lib/data/attachments-crud";
import { ACQUISITION_METHOD_OPTIONS, COUNTERPARTY_TYPE_OPTIONS } from "@/lib/db-types";
import {
  buildChallengeMessage,
  signatureFormatLabel,
  type SignatureFormat,
  type FreshnessAnchor,
} from "@/lib/signatureVerify";
import {
  lookupEntities,
  getActiveEntityCount,
  getActiveEntitySource,
  ENTITY_CATEGORY_LABELS,
} from "@/lib/privacy-entity-list";
import { runAmlScreening, type AmlDirectMatch, type AmlScreeningResult } from "./aml-screening";
import {
  type BalanceSummary,
  type AddressRow,
  type ControlState,
  formatUnix,
  todayString,
} from "./address-helpers";
import {
  type EvidenceItem,
  hashBytesHex,
  imageBytesToDataUrl,
  formatEvidenceSize,
} from "./evidence-helpers";
import {
  type ExplorerId,
  getExplorer,
} from "./explorer-helpers";
import {
  KYUTXO_APP_VERSION,
  DECLARATION_INTRO_PARAGRAPHS,
} from "./declaration-prefs";

export interface UsePofPdfBuilderParams {
  declarantName: string;
  declarantContact: string;
  declarantResidentialAddress: string;
  declarantDob: string;
  declarantTaxId: string;
  declarantIdNumber: string;
  declarantNationality: string;
  declarationDate: string;
  declarationNonce: string;
  purpose: string;
  statement: string;
  summary: BalanceSummary | null;
  doneRows: AddressRow[];
  totalSats: number;
  fiatValid: boolean;
  fiatTotal: number | null;
  fiatCurrency: string;
  fiatRateNum: number;
  controlStates: Record<string, ControlState>;
  evidenceItems: EvidenceItem[];
  includeProvenance: boolean;
  provenanceFiatCurrency: string;
  includeQr: boolean;
  qrExplorerId: ExplorerId;
  qrPreviews: Record<string, string>;
  includeAml: boolean;
  amlPepStatus: "not-stated" | "yes" | "no";
  amlTaxJurisdiction: string;
  amlSourceOfWealth: string;
  amlSourceOfFunds: string;
  amlTaxStatement: string;
  amlScreeningResult: AmlScreeningResult | null;
  includeIntro: boolean;
  includeAttestation: boolean;
  attestationPlaceOfSigning: string;
  attestationWitnessLine: string;
  includeGlossary: boolean;
  verifierReference: string;
  freshnessAnchorEnabled: boolean;
  freshnessAnchor: FreshnessAnchor | null;
}

export function usePofPdfBuilder(params: UsePofPdfBuilderParams) {
  const { toast } = useToast();
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isGeneratingSamplePdf, setIsGeneratingSamplePdf] = useState(false);

  const {
    declarantName,
    declarantContact,
    declarantResidentialAddress,
    declarantDob,
    declarantTaxId,
    declarantIdNumber,
    declarantNationality,
    declarationDate,
    declarationNonce,
    purpose,
    statement,
    summary,
    doneRows,
    totalSats,
    fiatValid,
    fiatTotal,
    fiatCurrency,
    fiatRateNum,
    controlStates,
    evidenceItems,
    includeProvenance,
    provenanceFiatCurrency,
    includeQr,
    qrExplorerId,
    qrPreviews,
    includeAml,
    amlPepStatus,
    amlTaxJurisdiction,
    amlSourceOfWealth,
    amlSourceOfFunds,
    amlTaxStatement,
    amlScreeningResult,
    includeIntro,
    includeAttestation,
    attestationPlaceOfSigning,
    attestationWitnessLine,
    includeGlossary,
    verifierReference,
    freshnessAnchorEnabled,
    freshnessAnchor,
  } = params;


  // ── Shared PDF builder — called by both generatePdf and generateSamplePdf ──
  // When isSample=true: uses placeholder data, adds a watermark on every page,
  // emits a specimen fingerprint label, and skips real DB / AML lookups — but
  // uses the SAME section ordering, page structure, and conditional gates as the
  // real path so users can approve the exact layout before filling in their data.
  const buildPofPdf = useCallback(async (isSample: boolean) => {
    const jsPDFModule = await import("jspdf");
    const autoTableModule = await import("jspdf-autotable");
    const jsPDF = jsPDFModule.default;
    const autoTable = autoTableModule.default;

    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 14;
    const contentW = pageW - margin * 2;
    let y = 20;

    const addLine = (text: string, size = 10, bold = false, color: [number, number, number] = [0, 0, 0]) => {
      doc.setFontSize(size);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(sanitizePdfText(text), contentW) as string[];
      doc.text(lines, margin, y);
      y += lines.length * size * 0.5;
    };

    const addWrapped = (text: string, size = 9, color: [number, number, number] = [0, 0, 0]) => {
      doc.setFontSize(size);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(sanitizePdfText(text), contentW) as string[];
      doc.text(lines, margin, y);
      y += lines.length * size * 0.45 + 2;
    };

    const addSpacer = (h = 4) => { y += h; };

    const checkPageBreak = (needed = 20) => {
      const pageH = doc.internal.pageSize.getHeight();
      if (y + needed > pageH - 15) {
        doc.addPage();
        y = 20;
      }
    };

    // ── Sample placeholder data (used only when isSample=true) ──────────────
    const SAMPLE_NONCE = "SAMPLE0000000000";
    const SAMPLE_DATE_STR = declarationDate || new Date().toISOString().slice(0, 10);
    const SAMPLE_NAME = "Jane Q. Sample";
    const SAMPLE_CONTACT = "jane.sample@example.com";
    const SAMPLE_RESIDENTIAL = "123 Sample Street, Example City, EX1 2AB";
    const SAMPLE_DOB = "1985-01-01";
    const SAMPLE_TAX_ID = "SAMPLE-TAX-123";
    const SAMPLE_ID_NUMBER = "SAMPLE-ID-456789";
    const SAMPLE_NATIONALITY = "Sampleland";
    const SAMPLE_PURPOSE = "Format preview only — not a valid declaration";
    const SAMPLE_STATEMENT_TEXT =
      "This is a specimen statement for layout preview only. " +
      "All information in this document is entirely fictitious and must not be used as evidence of any kind.";

    // Typed row shape that carries verified-state inline (avoids repeated controlStates lookups)
    interface EffRow {
      raw: string;
      balanceSats: number;
      verified: boolean;
      verifiedSig?: string;
      verifiedFormat?: SignatureFormat;
    }

    const SAMPLE_EFF_ROWS: EffRow[] = [
      {
        raw: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        balanceSats: 125_000_000,
        verified: true,
        verifiedSig: "SAMPLE_SIGNATURE_PLACEHOLDER_NOT_VALID_DO_NOT_USE==",
        verifiedFormat: "legacy" as SignatureFormat,
      },
      { raw: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", balanceSats: 75_000_000, verified: false },
    ];

    // ── Effective data (switches between real and sample) ────────────────────
    const effName = isSample ? SAMPLE_NAME : declarantName;
    const effContact = isSample ? SAMPLE_CONTACT : declarantContact;
    const effResidential = isSample ? SAMPLE_RESIDENTIAL : declarantResidentialAddress;
    const effDob = isSample ? SAMPLE_DOB : declarantDob;
    const effTaxId = isSample ? SAMPLE_TAX_ID : declarantTaxId;
    const effIdNumber = isSample ? SAMPLE_ID_NUMBER : declarantIdNumber;
    const effNationality = isSample ? SAMPLE_NATIONALITY : declarantNationality;
    const effDate = isSample ? SAMPLE_DATE_STR : declarationDate;
    const effPurpose = isSample ? SAMPLE_PURPOSE : purpose;
    const effStatement = isSample ? SAMPLE_STATEMENT_TEXT : statement;
    const effNonce = isSample ? SAMPLE_NONCE : declarationNonce;

    const effRows: EffRow[] = isSample
      ? SAMPLE_EFF_ROWS
      : doneRows.map((r) => ({
          raw: r.raw,
          balanceSats: r.balanceSats ?? 0,
          verified: controlStates[r.raw]?.status === "verified",
          verifiedSig: controlStates[r.raw]?.verifiedSig,
          verifiedFormat: controlStates[r.raw]?.verifiedFormat,
        }));

    const effVerifiedRows = effRows.filter((r) => r.verified);
    const hasVerified = effVerifiedRows.length > 0;
    const allVerified = effRows.length > 0 && effVerifiedRows.length === effRows.length;
    const effTotalSats = isSample ? 200_000_000 : totalSats;
    const effFiatValid = isSample ? true : fiatValid;
    const effFiatRate = isSample ? 65_000 : fiatRateNum;
    const effFiatCurrency = isSample ? "USD" : fiatCurrency;
    const effFiatTotal: number | null = isSample
      ? (200_000_000 / 1e8) * 65_000
      : fiatTotal;
    const effSummary = isSample ? null : summary;

    // ── Content fingerprint ───────────────────────────────────────────────────
    const generationTimestamp = new Date();
    const generationIso = generationTimestamp.toISOString();

    let contentFingerprint: string;
    let canonicalPayload = "";

    if (isSample) {
      contentFingerprint = "SPECIMEN — NOT A VALID FINGERPRINT (sample PDF)";
    } else {
      // Gather verified addresses (needed for canonical payload)
      const verifiedRows = doneRows.filter((r) => controlStates[r.raw]?.status === "verified");
      const hasVerified = verifiedRows.length > 0;
      const allVerified = doneRows.length > 0 && verifiedRows.length === doneRows.length;

      // Canonical content covers every field that materially affects what is rendered
      // in the PDF — core declaration fields, all address data, proof-of-control
      // challenge messages and signatures for verified addresses, all optional-section
      // user inputs and toggle states, and the generation UTC ISO timestamp.
      // This exact string (lines joined by "\n", UTF-8 encoded) is the SHA-256 preimage.
      // The preimage is reproduced verbatim inside the Document Integrity section of the
      // PDF so any third party can recompute the fingerprint independently.
      const canonicalLinesList: string[] = [
        "KYUTXO-POF-v1",
        `TOOL: KYUTXO v${KYUTXO_APP_VERSION}`,
        `REF: ${declarationNonce}`,
        `DECLARANT: ${declarantName}`,
        declarantContact.trim() ? `CONTACT: ${declarantContact.trim()}` : "",
        declarantResidentialAddress.trim() ? `RESIDENTIAL: ${declarantResidentialAddress.trim()}` : "",
        declarantDob.trim() ? `DOB: ${declarantDob.trim()}` : "",
        declarantTaxId.trim() ? `TAX_ID: ${declarantTaxId.trim()}` : "",
        declarantIdNumber.trim() ? `ID_NUMBER: ${declarantIdNumber.trim()}` : "",
        declarantNationality.trim() ? `NATIONALITY: ${declarantNationality.trim()}` : "",
        `DATE: ${declarationDate}`,
        `PURPOSE: ${purpose}`,
        statement.trim() ? `STATEMENT: ${statement.trim()}` : "",
        "ADDRESSES:",
        ...doneRows.map((r) => {
          const cs = controlStates[r.raw];
          const ctrl = cs?.status === "verified" ? "VERIFIED" : "UNVERIFIED";
          return `${r.raw}: ${r.balanceSats ?? 0} sat [${ctrl}]`;
        }),
        `TOTAL: ${totalSats} sat`,
        summary ? `SOURCE: ${summary.asOfLabel}` : "",
        summary?.blockHeight ? `BLOCK: ${summary.blockHeight}` : "",
        summary?.timestamp ? `TIMESTAMP: ${summary.timestamp}` : "",
        fiatValid ? `FIAT_RATE: ${fiatRateNum} ${fiatCurrency}` : "",
        // Proof-of-control: include challenge message and submitted signature for each
        // verified address. The challenge message is deterministically derived from the
        // declaration fields, so these lines are fully reproducible from the printed document.
        ...verifiedRows.flatMap((r) => {
          const cs = controlStates[r.raw]!;
          const challengeMsg = buildChallengeMessage({
            address: r.raw,
            declarantName,
            declarationDate,
            purpose,
            nonce: declarationNonce,
          });
          return [
            `CTRL_${r.raw}_CHALLENGE: ${challengeMsg}`,
            `CTRL_${r.raw}_SIG: ${cs.verifiedSig ?? ""}`,
          ];
        }),
        `SECTION_QR: ${includeQr ? `ON:${qrExplorerId}` : "OFF"}`,
        `SECTION_PROVENANCE: ${includeProvenance ? `ON:${provenanceFiatCurrency}` : "OFF"}`,
        includeAml ? `SECTION_AML: ON` : "SECTION_AML: OFF",
        includeAml ? `AML_PEP: ${amlPepStatus}` : "",
        includeAml && amlSourceOfWealth.trim() ? `AML_WEALTH: ${amlSourceOfWealth.trim()}` : "",
        includeAml && amlSourceOfFunds.trim() ? `AML_FUNDS: ${amlSourceOfFunds.trim()}` : "",
        includeAml && amlTaxJurisdiction.trim() ? `AML_TAX_JUR: ${amlTaxJurisdiction.trim()}` : "",
        includeAml && amlTaxStatement.trim() ? `AML_TAX_STMT: ${amlTaxStatement.trim()}` : "",
        `SECTION_ATTESTATION: ${includeAttestation ? "ON" : "OFF"}`,
        includeAttestation && attestationPlaceOfSigning.trim() ? `ATTEST_PLACE: ${attestationPlaceOfSigning.trim()}` : "",
        includeAttestation && attestationWitnessLine.trim() ? `ATTEST_WITNESS: ${attestationWitnessLine.trim()}` : "",
        `SECTION_INTRO: ${includeIntro ? "ON" : "OFF"}`,
        `SECTION_GLOSSARY: ${includeGlossary ? "ON" : "OFF"}`,
        `EVIDENCE_COUNT: ${evidenceItems.length}`,
        ...evidenceItems.map(
          (it, i) =>
            `EVIDENCE_ITEM_${String(i + 1).padStart(3, "0")}: ${it.kind}|${it.name}|${it.sha256}|${it.caption.trim()}`,
        ),
        `GENERATED: ${generationIso}`,
      ].filter(Boolean);
      canonicalPayload = canonicalLinesList.join("\n");
      // Fingerprint failure is treated as a hard error — silently substituting a
      // placeholder would give a false sense of integrity. crypto.subtle is available
      // in all modern browsers so failure here indicates a serious environment problem.
      const enc = new TextEncoder();
      const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(canonicalPayload));
      contentFingerprint = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } // end if (!isSample) fingerprint block

    // ── Sample notice banner (sample mode only) ───────────────────────────────
    if (isSample) {
      doc.setFillColor(255, 210, 210);
      doc.setDrawColor(200, 80, 80);
      doc.rect(margin, y - 4, contentW, 13, "FD");
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(160, 0, 0);
      const noticeLines = doc.splitTextToSize(
        sanitizePdfText(
          "SAMPLE / SPECIMEN — NOT A VALID DECLARATION. This document is a layout preview only. All data is fictitious."
        ),
        contentW - 4
      ) as string[];
      doc.text(noticeLines, margin + 2, y + 2.5);
      y += noticeLines.length * 8.5 * 0.45 + 10;
      doc.setTextColor(0, 0, 0);
    }

      // ── Title ──────────────────────────────────────────────────────────────
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text("PROOF OF FUNDS DECLARATION", margin, y);
      y += 10;

      doc.setLineWidth(0.5);
      doc.line(margin, y, margin + contentW, y);
      y += 5;

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

      const tableStartY = y;
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

      y = (doc as any).lastAutoTable.finalY + 6;

      // ── Totals ─────────────────────────────────────────────────────────────
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text(`TOTAL: ${formatBTC(effTotalSats)} BTC`, margin, y);
      y += 5;

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
        doc.text(fiatLines, margin, y);
        y += fiatLines.length * 4;
        doc.setTextColor(120, 80, 0);
        const disclaimerLines = doc.splitTextToSize(
          sanitizePdfText(
            "DISCLAIMER: Exchange rate supplied by declarant. This is not a market quote or financial advice."
          ),
          contentW
        ) as string[];
        doc.text(disclaimerLines, margin, y);
        doc.setTextColor(0, 0, 0);
        y += disclaimerLines.length * 4 + 1;
      }

      addSpacer(4);

      // ── Balance-Verification QR Codes ──────────────────────────────────────
      if (includeQr && effRows.length > 0) {
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
          const blockTop = y;

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
          y = Math.max(blockTop + qrSize, ty + urlLines.length * 7.5 * 0.45) + qrGap;
        }

        addSpacer(2);
      }

      // ── Acquisition & Provenance Section ──────────────────────────────────
      if (includeProvenance && effRows.length > 0) {
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
              address: SAMPLE_EFF_ROWS[0].raw,
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
              address: SAMPLE_EFF_ROWS[1].raw,
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
        y = 20;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("APPENDIX: ACQUISITION & PROVENANCE", margin, y);
        y += 8;
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 5;

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
        doc.text(provenanceIntroLines, margin, y);
        y += provenanceIntroLines.length * 8.5 * 0.45 + 5;

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
          startY: y,
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

        y = (doc as any).lastAutoTable.finalY + 5;

        // Price rate notes (one per entry that has a note)
        const priceNotes = provenanceEntries.filter((e) => e.priceInfo);
        if (priceNotes.length > 0) {
          checkPageBreak(10 + priceNotes.length * 5);
          doc.setFontSize(7.5);
          doc.setFont("helvetica", "italic");
          doc.setTextColor(100, 100, 100);
          for (const e of priceNotes) {
            const noteText = `${truncateAddress(e.address, 8, 8)}: ${e.priceInfo}`;
            doc.text(sanitizePdfText(noteText), margin, y);
            y += 4;
          }
          doc.setTextColor(0, 0, 0);
          y += 2;
        }

        // Summary line
        checkPageBreak(35);
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("PROVENANCE SUMMARY", margin, y);
        y += 5;

        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.text(sanitizePdfText(`Total BTC (declared addresses): ${formatBTC(effTotalSats)} BTC`), margin, y);
        y += 4.5;

        if (hasCostBasis) {
          const costStr = totalCostBasis.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          doc.text(sanitizePdfText(`Total Cost Basis: ${provenanceFiatCurrency} ${costStr}`), margin, y);
          y += 4.5;
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
            y
          );
          y += 4.5;

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
              y
            );
            y += 4.5;
          }
        }

        y += 3;

        // Supporting documents list
        checkPageBreak(20);
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("SUPPORTING DOCUMENTS", margin, y);
        y += 5;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");

        if (allSupportingDocs.length === 0) {
          doc.setTextColor(100, 100, 100);
          doc.text("No file attachments are linked to the declared records in vault.", margin, y);
          doc.setTextColor(0, 0, 0);
          y += 5;
        } else {
          for (const name of allSupportingDocs) {
            checkPageBreak(8);
            doc.text(sanitizePdfText(`\u2022 ${name}`), margin + 3, y);
            y += 4.5;
          }
          y += 2;
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
        doc.text(provNoteLines, margin, y);
        y += provNoteLines.length * 7.5 * 0.45 + 4;
        doc.setTextColor(0, 0, 0);
      }

      // ── AML / Risk Screening Appendix ─────────────────────────────────────
      if (includeAml && effRows.length > 0) {
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
        y = 20;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("APPENDIX: AML / RISK SCREENING", margin, y);
        y += 8;
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 5;

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
          doc.text(AML_APPENDIX_STRINGS.noDirectMatchesResult, margin, y);
          doc.setTextColor(0, 0, 0);
          y += 5;
          addWrapped(AML_APPENDIX_STRINGS.noDirectMatchesDetail, 9);
        } else {
          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(160, 0, 0);
          doc.text(
            buildDirectMatchResultLine(amlResult.directMatches.length),
            margin,
            y
          );
          doc.setTextColor(0, 0, 0);
          y += 5;

          autoTable(doc, {
            startY: y,
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
          y = (doc as any).lastAutoTable.finalY + 5;
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
          doc.text(AML_APPENDIX_STRINGS.noProximityMatchResult, margin, y);
          doc.setTextColor(0, 0, 0);
          y += 5;
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
          doc.text(proxLines, margin, y);
          y += proxLines.length * 9 * 0.45 + 2;
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

      // ── Standard Disclaimers ───────────────────────────────────────────────
      checkPageBreak(50);
      addLine("DISCLAIMERS", 11, true);
      addSpacer(2);

      const verifiedFormats = new Set(
        effVerifiedRows
          .map((r) => r.verifiedFormat)
          .filter((f): f is SignatureFormat => !!f)
      );
      const formatPhrase =
        verifiedFormats.has("legacy") && verifiedFormats.has("bip322")
          ? "Bitcoin Signed Message and BIP-322 signatures"
          : verifiedFormats.has("bip322")
          ? "BIP-322 signatures"
          : "Bitcoin Signed Message signatures";

      const controlDisclaimerLine = allVerified
        ? `2. Cryptographic proof-of-control is included for all addresses via ${formatPhrase}. An appendix contains the challenge messages and signatures for independent re-verification.`
        : hasVerified
        ? `2. Cryptographic proof-of-control is included for ${effVerifiedRows.length} of ${effRows.length} address${effRows.length !== 1 ? "es" : ""} via ${formatPhrase}. The remaining addresses are self-declared. An appendix contains the challenge messages and signatures for verified addresses.`
        : "2. No cryptographic proof-of-control is included. All addresses are self-declared by the declarant.";

      const disclaimers = [
        "1. This is a declaration produced by the declarant personally attesting to ownership of the above Bitcoin addresses.",
        controlDisclaimerLine,
        "3. Balances reflect the data source indicated above and may not represent real-time on-chain state.",
        "4. This document was generated offline using KYUTXO. No data was transmitted to third parties during generation.",
        "5. This document does not constitute financial, legal, or tax advice.",
      ];
      for (const d of disclaimers) {
        addWrapped(d);
        addSpacer(1);
      }

      addSpacer(6);

      // ── Signature Block ────────────────────────────────────────────────────
      checkPageBreak(30);
      addLine("SIGNATURE", 11, true);
      addSpacer(4);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(0, 0, 0);
      doc.text("Declarant signature: ___________________________________", margin, y);
      y += 8;
      doc.text(`Date: ${sanitizePdfText(effDate)}`, margin, y);
      y += 6;
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      doc.text(
        sanitizePdfText(
          `Generated by KYUTXO on ${generationTimestamp.toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}`
        ),
        margin,
        y
      );
      doc.setTextColor(0, 0, 0);
      y += 5;

      // ── Document Integrity (always-on) ────────────────────────────────────
      checkPageBreak(55);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text("DOCUMENT INTEGRITY", margin, y);
      y += 5;
      doc.setLineWidth(0.3);
      doc.line(margin, y, margin + contentW, y);
      y += 4;

      doc.setFontSize(8.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(0, 0, 0);

      // Generation metadata
      // NOTE: Generated timestamp is displayed as UTC ISO 8601 — this is exactly the
      // value in the canonical payload so the fingerprint is unambiguously reproducible.
      const metaLines: [string, string][] = [
        ["Tool:", `KYUTXO v${KYUTXO_APP_VERSION} (Proof of Funds Declaration)`],
        ["Generated (UTC ISO 8601):", generationIso],
        ["Declaration Reference:", effNonce],
      ];

      // Blockchain time-anchor
      if (effSummary?.blockHeight) {
        const anchorLabel = effSummary.timestamp
          ? `Block ${effSummary.blockHeight.toLocaleString()} — ${formatUnix(effSummary.timestamp)}`
          : `Block ${effSummary.blockHeight.toLocaleString()}`;
        metaLines.push(["On-chain data current as of:", anchorLabel]);
      } else if (effSummary?.timestamp) {
        metaLines.push(["On-chain data as of:", formatUnix(effSummary.timestamp)]);
      }

      // Content fingerprint (red in sample mode to make the specimen label visually obvious)
      if (isSample) {
        metaLines.push(["Content Fingerprint (SHA-256):", ""]);
      } else {
        metaLines.push(["Content Fingerprint (SHA-256):", contentFingerprint]);
      }

      const metaLabelW = 65;
      const metaValueW = contentW - metaLabelW;
      for (const [label, value] of metaLines) {
        checkPageBreak(10);
        doc.setFont("helvetica", "bold");
        doc.text(sanitizePdfText(label), margin, y);
        doc.setFont("helvetica", "normal");
        if (label.startsWith("Content Fingerprint") && isSample) {
          doc.setTextColor(180, 0, 0);
          doc.setFont("helvetica", "bold");
          doc.text(sanitizePdfText(contentFingerprint), margin + metaLabelW, y);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0, 0, 0);
          y += 4.5;
        } else {
          const valLines = doc.splitTextToSize(sanitizePdfText(value), metaValueW) as string[];
          doc.text(valLines, margin + metaLabelW, y);
          y += Math.max(valLines.length * 8.5 * 0.45, 4.5);
        }
      }
      y += 2;

      doc.setFontSize(7.5);
      doc.setFont("helvetica", "italic");
      doc.setTextColor(100, 100, 100);

      if (isSample) {
        // In sample mode, skip the canonical payload box and explain why
        const sampleFpNote =
          "SPECIMEN — No canonical payload is printed for sample PDFs. " +
          "The Content Fingerprint above is a placeholder label, not a valid SHA-256 hash. " +
          "A real declaration includes the verbatim preimage here so any reviewer can independently verify the fingerprint.";
        const sampleFpLines = doc.splitTextToSize(sanitizePdfText(sampleFpNote), contentW) as string[];
        doc.text(sampleFpLines, margin, y);
        doc.setTextColor(0, 0, 0);
        y += sampleFpLines.length * 7.5 * 0.45 + 4;
      } else {
        const fingerprintNote =
          "The Content Fingerprint is SHA-256(UTF-8(canonical payload)), where the canonical payload " +
          "is the verbatim preimage printed below (lines joined by newline \"\\n\"). " +
          "It covers: tool version, reference ID, all declarant fields, date, purpose, statement, " +
          "all declared addresses with balances and control status, proof-of-control challenge messages " +
          "and signatures for verified addresses, blockchain anchor, fiat rate, all section toggle states " +
          "and their user-entered fields, and the UTC ISO 8601 generation timestamp. " +
          "A reviewer can copy the preimage below, UTF-8 encode it, SHA-256 hash it, and verify the hex matches the fingerprint above. " +
          "Page numbering in the footer confirms no pages have been removed.";
        const fpNoteLines = doc.splitTextToSize(sanitizePdfText(fingerprintNote), contentW) as string[];
        doc.text(fpNoteLines, margin, y);
        doc.setTextColor(0, 0, 0);
        y += fpNoteLines.length * 7.5 * 0.45 + 4;

        // ── Canonical payload (verbatim preimage) ───────────────────────────
        // Printed in full so any third party can recompute the fingerprint independently
        // without possessing any information not visible in this document.
        checkPageBreak(20);
        doc.setFontSize(7.5);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("Fingerprint Preimage (canonical payload, reproduced verbatim):", margin, y);
        y += 4.5;

        // Print payload in Courier at small size, with a light background box
        doc.setFont("courier", "normal");
        doc.setFontSize(6.5);
        doc.setTextColor(30, 30, 30);
        const payloadWrapped = doc.splitTextToSize(
          sanitizePdfText(canonicalPayload),
          contentW - 4
        ) as string[];
        const payloadBoxH = payloadWrapped.length * 6.5 * 0.42 + 4;
        checkPageBreak(payloadBoxH + 4);
        doc.setFillColor(248, 248, 248);
        doc.setDrawColor(200, 200, 200);
        doc.rect(margin, y - 1.5, contentW, payloadBoxH, "FD");
        doc.text(payloadWrapped, margin + 2, y + 1);
        y += payloadBoxH + 4;
        doc.setTextColor(0, 0, 0);
      }

      // ── Optional Attestation Block ─────────────────────────────────────────
      if (includeAttestation) {
        checkPageBreak(70);
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("FORMAL ATTESTATION", margin, y);
        y += 5;
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 5;

        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0, 0, 0);
        const attestText =
          `I, ${sanitizePdfText(effName)}, hereby solemnly declare and attest that the foregoing ` +
          "information — including all Bitcoin addresses, reported balances, and supporting details — is true, " +
          "accurate, and complete to the best of my knowledge and belief. I am the lawful owner or authorised " +
          "signatory of the declared addresses and the funds associated with them. I understand that knowingly " +
          "making a false declaration may result in civil and/or criminal liability under applicable law.";
        const attestLines = doc.splitTextToSize(sanitizePdfText(attestText), contentW) as string[];
        doc.text(attestLines, margin, y);
        y += attestLines.length * 9 * 0.45 + 8;

        // Signature line
        checkPageBreak(50);
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.text("Declarant signature: _______________________________________________", margin, y);
        y += 8;
        doc.text(`Full name: ${sanitizePdfText(effName)}`, margin, y);
        y += 7;

        const placeSigned = attestationPlaceOfSigning.trim();
        if (placeSigned) {
          doc.text(`Place of signing: ${sanitizePdfText(placeSigned)}`, margin, y);
          y += 7;
        } else {
          doc.text("Place of signing: _______________________________________________", margin, y);
          y += 7;
        }

        doc.text(`Date: ${sanitizePdfText(effDate)}`, margin, y);
        y += 10;

        // Optional witness / notary line
        const witnessLine = attestationWitnessLine.trim();
        if (witnessLine) {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(9);
          const wLines = doc.splitTextToSize(sanitizePdfText(`Witness / Notary: ${witnessLine}`), contentW) as string[];
          doc.text(wLines, margin, y);
          doc.setFont("helvetica", "normal");
          y += wLines.length * 9 * 0.45 + 5;
        } else {
          doc.text("Witness / Notary signature: ____________________________________", margin, y);
          y += 7;
          doc.text("Witness / Notary name and capacity: ____________________________", margin, y);
          y += 7;
          doc.text("Date: _______________", margin, y);
          y += 7;
        }

        doc.setFontSize(7.5);
        doc.setFont("helvetica", "italic");
        doc.setTextColor(100, 100, 100);
        doc.text(
          sanitizePdfText(`Declaration Reference: ${effNonce}`),
          margin, y
        );
        doc.setTextColor(0, 0, 0);
        y += 8;
      }

      // ── Appendix: Proof-of-Control Evidence ───────────────────────────────
      if (hasVerified) {
        doc.addPage();
        y = 20;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("APPENDIX: PROOF-OF-CONTROL EVIDENCE", margin, y);
        y += 8;

        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 6;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        const introLines = doc.splitTextToSize(
          sanitizePdfText(
            "The following section contains the challenge message and corresponding wallet signature for each address where cryptographic proof-of-control was provided. " +
            "Legacy addresses use Bitcoin Signed Message signatures; Taproot (bc1p…) addresses use BIP-322 Simple signatures. " +
            "The signature was produced by the declarant using their own wallet or hardware device — no private keys were shared with KYUTXO. " +
            "To independently verify, use a Bitcoin message-verification tool that supports the signature format shown for each address, with the address, message, and signature shown below."
          ),
          contentW
        ) as string[];
        doc.text(introLines, margin, y);
        y += introLines.length * 8.5 * 0.45 + 6;

        // ── How to independently verify ──────────────────────────────────────
        checkPageBreak(70);
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("HOW TO INDEPENDENTLY VERIFY", margin, y);
        y += 6;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        const howToIntroLines = doc.splitTextToSize(
          sanitizePdfText(
            "Each address below has a Challenge Message and a Wallet Signature. You can confirm, without KYUTXO and without any network access, that the holder of each address signed that exact message. " +
            "Use any standard Bitcoin signed-message verification tool and supply three inputs: the Address, the Challenge Message (verbatim, including line breaks), and the Wallet Signature (base64)."
          ),
          contentW
        ) as string[];
        doc.text(howToIntroLines, margin, y);
        y += howToIntroLines.length * 8.5 * 0.45 + 4;

        const verifyMethods = [
          "1. bitcoin-cli (Bitcoin Core): run  bitcoin-cli verifymessage \"<address>\" \"<signature>\" \"<challenge message>\"  — it returns true when the signature is valid for that address and message.",
          "2. Electrum: open Tools > Sign/Verify Message, paste the Address, Challenge Message, and Signature, then click Verify.",
          "3. Any other Bitcoin signed-message verifier (e.g. Sparrow's Verify Message tool, or any offline tool that accepts an address, a message, and a signature) will work the same way.",
        ];
        for (const m of verifyMethods) {
          checkPageBreak(16);
          const mLines = doc.splitTextToSize(sanitizePdfText(m), contentW - 3) as string[];
          doc.setFontSize(8.5);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0, 0, 0);
          doc.text(mLines, margin + 3, y);
          y += mLines.length * 8.5 * 0.45 + 2;
        }
        y += 3;

        // ── Challenge message & nonce format explanation ─────────────────────
        checkPageBreak(50);
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("CHALLENGE MESSAGE FORMAT", margin, y);
        y += 6;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0, 0, 0);
        const formatDesc = [
          `The Challenge Message is the human-readable text that was signed for each address. It records the declarant, purpose, date, a unique Declaration Reference (nonce: ${effNonce}), and the address itself.`,
          "The Declaration Reference is a random value generated specifically for this declaration; because it is embedded in every signed message, the signatures cannot be silently reused for a different declaration.",
          "When verifying, the message must be supplied exactly as shown — every character and line break is part of what was signed, so changing even one character will cause verification to fail.",
        ];
        if (!isSample && verifierReference.trim()) {
          formatDesc.push(
            `Verifier Reference: "${verifierReference.trim()}" — a free-text identifier provided by the requesting party and embedded in each signed message, binding the signatures to this specific request.`
          );
        }
        if (!isSample && freshnessAnchor) {
          formatDesc.push(
            `Block Anchor: height ${freshnessAnchor.height}, hash ${freshnessAnchor.hash} (fetched ${freshnessAnchor.fetchedAt}). ` +
            `This anchor proves each signature was created at or after block ${freshnessAnchor.height}. ` +
            "It does not prove an exact timestamp — the verifier can confirm the block on any public explorer."
          );
        }
        const formatLines = doc.splitTextToSize(
          sanitizePdfText(formatDesc.join(" ")),
          contentW
        ) as string[];
        doc.text(formatLines, margin, y);
        y += formatLines.length * 8.5 * 0.45 + 6;

        for (const row of effVerifiedRows) {
          checkPageBreak(60);

          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(0, 0, 0);
          const addrHeadingLines = doc.splitTextToSize(
            sanitizePdfText(`Address: ${row.raw}`),
            contentW
          ) as string[];
          doc.text(addrHeadingLines, margin, y);
          y += addrHeadingLines.length * 5;

          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(80, 80, 80);
          const sigFormatLines = doc.splitTextToSize(
            sanitizePdfText(
              `Signature Format: ${signatureFormatLabel(row.verifiedFormat ?? "legacy")}`
            ),
            contentW
          ) as string[];
          doc.text(sigFormatLines, margin, y);
          doc.setTextColor(0, 0, 0);
          y += sigFormatLines.length * 5;

          const challengeMsg = buildChallengeMessage({
            address: row.raw,
            declarantName: effName,
            declarationDate: effDate,
            purpose: effPurpose,
            nonce: effNonce,
            verifierReference: isSample ? undefined : (verifierReference || undefined),
            freshnessAnchor: isSample ? undefined : (freshnessAnchor ?? undefined),
          });

          doc.setFontSize(8);
          doc.setFont("helvetica", "bold");
          doc.text("Challenge Message:", margin, y);
          y += 4;

          doc.setFont("courier", "normal");
          doc.setFontSize(7.5);
          const msgLines = doc.splitTextToSize(sanitizePdfText(challengeMsg), contentW - 4) as string[];
          doc.setFillColor(245, 245, 245);
          doc.rect(margin, y - 1, contentW, msgLines.length * 7.5 * 0.42 + 4, "F");
          doc.text(msgLines, margin + 2, y + 1.5);
          y += msgLines.length * 7.5 * 0.42 + 6;

          checkPageBreak(20);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8);
          doc.setTextColor(0, 0, 0);
          doc.text(
            row.verifiedFormat === "bip322"
              ? "BIP-322 Witness (base64):"
              : "Wallet Signature (base64):",
            margin,
            y
          );
          y += 4;

          doc.setFont("courier", "normal");
          doc.setFontSize(7.5);
          const sigLines = doc.splitTextToSize(sanitizePdfText(row.verifiedSig ?? ""), contentW - 4) as string[];
          doc.setFillColor(245, 245, 245);
          doc.rect(margin, y - 1, contentW, sigLines.length * 7.5 * 0.42 + 4, "F");
          doc.text(sigLines, margin + 2, y + 1.5);
          y += sigLines.length * 7.5 * 0.42 + 6;

          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(0, 130, 0);
          doc.text(
            sanitizePdfText("Status: Control Verified — signature matches this address."),
            margin,
            y
          );
          doc.setTextColor(0, 0, 0);
          y += 8;
          doc.setLineWidth(0.2);
          doc.setDrawColor(200, 200, 200);
          doc.line(margin, y, margin + contentW, y);
          y += 5;
        }
      }

      // ── Optional Glossary ──────────────────────────────────────────────────
      if (includeGlossary) {
        doc.addPage();
        y = 20;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("APPENDIX: GLOSSARY OF TERMS", margin, y);
        y += 8;
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 5;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(60, 60, 60);
        const glossaryIntroLines = doc.splitTextToSize(
          sanitizePdfText(
            "This glossary provides plain-language explanations of technical terms used in this declaration, " +
            "for the benefit of non-technical reviewers."
          ),
          contentW
        ) as string[];
        doc.text(glossaryIntroLines, margin, y);
        y += glossaryIntroLines.length * 8.5 * 0.45 + 5;
        doc.setTextColor(0, 0, 0);

        const glossaryTerms: [string, string][] = [
          [
            "Bitcoin",
            "A decentralized digital currency that operates on a peer-to-peer network without a central authority. Transactions are recorded on a public ledger called the blockchain.",
          ],
          [
            "Bitcoin Address",
            "A unique identifier — similar to a bank account number — used to receive Bitcoin. An address is derived from a cryptographic key pair. Common formats begin with '1', '3', or 'bc1'.",
          ],
          [
            "Balance",
            "The total amount of Bitcoin currently held at an address, measured in BTC or satoshis, as reported by the blockchain at the time of declaration.",
          ],
          [
            "BTC",
            "The symbol for Bitcoin. One BTC equals 100,000,000 satoshis (sat). Balances in this document are expressed in BTC unless otherwise noted.",
          ],
          [
            "Satoshi (sat)",
            "The smallest unit of Bitcoin. 1 BTC = 100,000,000 satoshis. Named after Bitcoin's pseudonymous creator, Satoshi Nakamoto.",
          ],
          [
            "Blockchain",
            "A public, append-only ledger that permanently records all Bitcoin transactions. Each block of transactions is cryptographically linked to the previous one, making the history tamper-evident.",
          ],
          [
            "Block",
            "A batch of confirmed Bitcoin transactions added to the blockchain. Each block is identified by its height (position in the chain). Block height is used in this document as a time-anchor for reported balances.",
          ],
          [
            "Confirmation",
            "A transaction is 'confirmed' once it has been included in a block and broadcast across the network. Each subsequent block mined on top adds another confirmation, increasing finality.",
          ],
          [
            "UTXO (Unspent Transaction Output)",
            "The fundamental accounting unit of Bitcoin. Each received Bitcoin amount creates a UTXO; spending Bitcoin consumes one or more UTXOs as inputs and creates new UTXOs as outputs. An address's balance is the sum of its UTXOs.",
          ],
          [
            "xpub (Extended Public Key)",
            "A public key from which an entire sequence of Bitcoin addresses can be derived without exposing private keys. Sharing an xpub allows read-only balance monitoring across all derived addresses.",
          ],
          [
            "Proof of Control",
            "Cryptographic evidence that the declarant holds the private key corresponding to a Bitcoin address, demonstrated by signing a unique challenge message with that key using their wallet.",
          ],
          [
            "Bitcoin Signed Message",
            "A standard format for signing a text message with a Bitcoin private key, producing a base64-encoded signature that can be independently verified against the address. Supported by most Bitcoin wallets.",
          ],
          [
            "BIP-322",
            "Bitcoin Improvement Proposal 322 — a newer signing standard that supports modern address types including Taproot (bc1p…) addresses, using Schnorr signatures.",
          ],
          [
            "Hop",
            "A single transaction step between two Bitcoin addresses in the transaction graph. A '2-hop' connection means there are two intermediate transactions between the declared address and a named counterparty.",
          ],
          [
            "SHA-256",
            "A cryptographic hash function that produces a fixed-length (256-bit / 64-character hex) fingerprint from any input. Even a single character change in the input produces a completely different hash, making it useful for detecting document alterations.",
          ],
          [
            "Declaration Reference (Nonce)",
            "A randomly generated, unique identifier assigned to this declaration at the time of generation. It is embedded in every signed challenge message to prevent signatures from being reused across different declarations.",
          ],
          [
            "PEP (Politically Exposed Person)",
            "An individual who holds or has held a prominent public function (e.g. head of state, senior government official, senior judicial or military official). Financial institutions apply enhanced due diligence to PEPs.",
          ],
          [
            "AML (Anti-Money Laundering)",
            "Laws, regulations, and procedures designed to prevent criminals from disguising illegally obtained funds as legitimate income. AML compliance requires financial institutions to screen customers and their transaction histories.",
          ],
          [
            "KYC (Know Your Customer)",
            "A set of identity verification procedures financial institutions use to confirm the identity of their clients and assess the risk of illegal activity such as money laundering or fraud.",
          ],
        ];

        for (const [term, definition] of glossaryTerms) {
          const defLines = doc.splitTextToSize(sanitizePdfText(definition), contentW - 4) as string[];
          const neededHeight = 5 + defLines.length * 8.5 * 0.45 + 4;
          checkPageBreak(neededHeight + 2);

          doc.setFontSize(8.5);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(0, 0, 0);
          doc.text(sanitizePdfText(term), margin, y);
          y += 4.5;

          doc.setFont("helvetica", "normal");
          doc.setTextColor(50, 50, 50);
          doc.text(defLines, margin + 4, y);
          doc.setTextColor(0, 0, 0);
          y += defLines.length * 8.5 * 0.45 + 3;
        }
      }

      // ── Supporting Evidence appendix (real declarations only) ──────────────
      // Image exhibits are embedded here; PDF exhibits are listed in the index
      // and then merged onto the end of the dossier (after this jsPDF document)
      // in the output step below. Skipped entirely in sample mode so specimen
      // PDFs never carry attachments and stay fully watermarked.
      if (!isSample && evidenceItems.length > 0) {
        doc.addPage();
        y = 20;
        addLine("APPENDIX: SUPPORTING EVIDENCE", 13, true);
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
            doc.addImage(it.dataUrl!, fmt, margin, y, dispW, dispH);
            y += dispH + 3;
            if (it.caption.trim()) {
              addWrapped(`Caption: ${it.caption.trim()}`, 8, [60, 60, 60]);
            }
            addWrapped(`SHA-256: ${it.sha256}`, 7, [120, 120, 120]);
            addSpacer(4);
          }
        }
      }

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
  }, [
    declarantName,
    evidenceItems,
    declarantContact,
    declarantResidentialAddress,
    declarantDob,
    declarantTaxId,
    declarantIdNumber,
    declarantNationality,
    declarationDate,
    declarationNonce,
    purpose,
    statement,
    summary,
    doneRows,
    totalSats,
    fiatValid,
    fiatTotal,
    fiatCurrency,
    fiatRateNum,
    controlStates,
    toast,
    includeProvenance,
    provenanceFiatCurrency,
    includeQr,
    qrExplorerId,
    includeAml,
    amlPepStatus,
    amlTaxJurisdiction,
    amlSourceOfWealth,
    amlSourceOfFunds,
    amlTaxStatement,
    includeIntro,
    includeAttestation,
    attestationPlaceOfSigning,
    attestationWitnessLine,
    includeGlossary,
  ]);

  const generatePdf = useCallback(async () => {
    setIsGeneratingPdf(true);
    try {
      await buildPofPdf(false);
      toast({ title: "PDF Downloaded", description: "Your Proof of Funds Declaration has been saved." });
    } catch (err) {
      console.error("[ProofOfFunds] PDF generation failed:", err);
      toast({
        variant: "destructive",
        title: "PDF Export Failed",
        description: err instanceof Error ? err.message : "An unexpected error occurred during PDF generation.",
      });
    } finally {
      setIsGeneratingPdf(false);
    }
  }, [buildPofPdf, toast]);

  const generateSamplePdf = useCallback(async () => {
    setIsGeneratingSamplePdf(true);
    try {
      await buildPofPdf(true);
      toast({ title: "Sample PDF Downloaded", description: "The specimen format preview has been saved. It is not a valid declaration." });
    } catch (err) {
      console.error("[ProofOfFunds] Sample PDF generation failed:", err);
      toast({
        variant: "destructive",
        title: "Sample PDF Export Failed",
        description: err instanceof Error ? err.message : "An unexpected error occurred during sample PDF generation.",
      });
    } finally {
      setIsGeneratingSamplePdf(false);
    }
  }, [buildPofPdf, toast]);

  return { generatePdf, generateSamplePdf, isGeneratingPdf, isGeneratingSamplePdf };
}
