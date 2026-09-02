// Thin composer for the Proof of Funds PDF. The heavy lifting lives in
// per-section modules (pof-pdf-section-*.ts), each taking the same
// PdfLayout + PofPdfData inputs, so a change to one section cannot
// accidentally rewrite another. Section order here IS the document order.
import { useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { PdfLayout, type UsePofPdfBuilderParams } from "./pof-pdf-context";
import { computePofPdfData } from "./pof-pdf-data";
import { renderDeclarationBody } from "./pof-pdf-section-declaration";
import { renderQrSection } from "./pof-pdf-section-qr";
import { renderProvenanceSection } from "./pof-pdf-section-provenance";
import { renderAmlSection } from "./pof-pdf-section-aml";
import {
  renderDisclaimersAndSignature,
  renderDocumentIntegrity,
  renderFormalAttestation,
} from "./pof-pdf-section-signature";
import { renderProofOfControlSection } from "./pof-pdf-section-proof-of-control";
import { renderGlossarySection } from "./pof-pdf-section-glossary";
import { renderEvidenceSection } from "./pof-pdf-section-evidence";
import { finalizeAndSavePdf } from "./pof-pdf-output";

export { type UsePofPdfBuilderParams } from "./pof-pdf-context";

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

    const layout = new PdfLayout(doc, autoTable, pageW, margin, contentW);
    const data = await computePofPdfData(params, isSample);

    renderDeclarationBody(layout, data);
    await renderQrSection(layout, data);
    await renderProvenanceSection(layout, data);
    await renderAmlSection(layout, data);
    renderDisclaimersAndSignature(layout, data);
    renderDocumentIntegrity(layout, data);
    renderFormalAttestation(layout, data);
    renderProofOfControlSection(layout, data);
    renderGlossarySection(layout, data);
    renderEvidenceSection(layout, data);
    await finalizeAndSavePdf(layout, data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    verifierReference,
    freshnessAnchorEnabled,
    freshnessAnchor,
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
