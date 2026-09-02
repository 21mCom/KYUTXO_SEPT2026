// Shared context + types for the Proof of Funds PDF section builders.
// Every per-section module receives the same PdfLayout (jsPDF doc + cursor +
// text helpers) and the same PofPdfData (effective declaration data), so the
// composer in use-pof-pdf-builder.ts stays a thin sequence of section calls.
import { sanitizePdfText } from "@/lib/pdfText";
import { type SignatureFormat, type FreshnessAnchor } from "@/lib/signatureVerify";
import { type AmlScreeningResult } from "./aml-screening";
import { type BalanceSummary, type AddressRow, type ControlState } from "./address-helpers";
import { type EvidenceItem } from "./evidence-helpers";
import { type ExplorerId } from "./explorer-helpers";

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

// Typed row shape that carries verified-state inline (avoids repeated controlStates lookups)
export interface EffRow {
  raw: string;
  balanceSats: number;
  verified: boolean;
  verifiedSig?: string;
  verifiedFormat?: SignatureFormat;
}

// Effective declaration data — switches between real params and sample
// placeholders. Computed once in pof-pdf-data.ts and passed to every section.
export interface PofPdfData {
  isSample: boolean;
  params: UsePofPdfBuilderParams;
  effName: string;
  effContact: string;
  effResidential: string;
  effDob: string;
  effTaxId: string;
  effIdNumber: string;
  effNationality: string;
  effDate: string;
  effPurpose: string;
  effStatement: string;
  effNonce: string;
  effRows: EffRow[];
  effVerifiedRows: EffRow[];
  hasVerified: boolean;
  allVerified: boolean;
  effTotalSats: number;
  effFiatValid: boolean;
  effFiatRate: number;
  effFiatCurrency: string;
  effFiatTotal: number | null;
  effSummary: BalanceSummary | null;
  generationTimestamp: Date;
  generationIso: string;
  contentFingerprint: string;
  canonicalPayload: string;
  sampleEffRows: EffRow[];
}

// jsPDF document + layout cursor + shared text helpers. Sections mutate `y`
// directly (this.y) exactly like the pre-split monolithic builder did.
export class PdfLayout {
  y = 20;

  constructor(
    public doc: any,
    public autoTable: any,
    public pageW: number,
    public margin: number,
    public contentW: number,
  ) {}

  addLine = (text: string, size = 10, bold = false, color: [number, number, number] = [0, 0, 0]) => {
    const { doc, contentW, margin } = this;
    doc.setFontSize(size);
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(sanitizePdfText(text), contentW) as string[];
    doc.text(lines, margin, this.y);
    this.y += lines.length * size * 0.5;
  };

  addWrapped = (text: string, size = 9, color: [number, number, number] = [0, 0, 0]) => {
    const { doc, contentW, margin } = this;
    doc.setFontSize(size);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(sanitizePdfText(text), contentW) as string[];
    doc.text(lines, margin, this.y);
    this.y += lines.length * size * 0.45 + 2;
  };

  addSpacer = (h = 4) => {
    this.y += h;
  };

  checkPageBreak = (needed = 20) => {
    const pageH = this.doc.internal.pageSize.getHeight();
    if (this.y + needed > pageH - 15) {
      this.doc.addPage();
      this.y = 20;
    }
  };
}
