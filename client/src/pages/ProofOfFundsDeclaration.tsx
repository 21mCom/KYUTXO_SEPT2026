import { useState, useRef, useMemo, useEffect } from "react";
import { FileText, Loader2, Clock, Download } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { useLiveQuery } from "dexie-react-hooks";
import { formatBTC } from "@/lib/bitcoin";
import { buildAttestationLines } from "@/lib/attestationLines";
import { getRecordsByType } from "@/lib/data/record-crud";
import {
  generateDeclarationNonce,
  type FreshnessAnchor,
} from "@/lib/signatureVerify";
import { runAmlScreening, type AmlScreeningResult } from "./proof-of-funds/aml-screening";
export { runAmlScreening } from "./proof-of-funds/aml-screening";
import {
  type ControlState,
  todayString,
} from "./proof-of-funds/address-helpers";
import { type EvidenceItem } from "./proof-of-funds/evidence-helpers";
import {
  type ExplorerId,
  getExplorer,
} from "./proof-of-funds/explorer-helpers";
import {
  loadDeclarationPrefs,
  saveDeclarationPrefs,
} from "./proof-of-funds/declaration-prefs";
import { useBalanceCheck } from "./proof-of-funds/use-balance-check";
import { usePofPdfBuilder } from "./proof-of-funds/use-pof-pdf-builder";
import {
  AddressInputCard,
  BalanceSourceCard,
  BalanceResultsCard,
} from "./proof-of-funds/address-balance-cards";
import {
  DeclarantDetailsCard,
  FiatEquivalentCard,
} from "./proof-of-funds/declarant-fiat-cards";
import { QrCodesCard } from "./proof-of-funds/qr-codes-card";
import { AmlRiskCard } from "./proof-of-funds/aml-risk-card";
import { ProvenanceCard } from "./proof-of-funds/provenance-card";
import { ProofOfControlCard } from "./proof-of-funds/proof-of-control-card";
import { EvidenceCard } from "./proof-of-funds/evidence-card";
import { AttestationCard, GlossaryCard, IntroCard } from "./proof-of-funds/declaration-toggle-cards";

export default function ProofOfFundsDeclaration() {
  const { nodeSettings } = useNodeSettings();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { openRecordEdit } = useRecordPreview();

  // Address records, kept live so the provenance summary in Step 7 updates
  // immediately after a record is edited from the "Fill in missing fields"
  // quick-action.
  const addressRecords = useLiveQuery(() => getRecordsByType("address"), []);

  // Proof of control
  // Map of address -> per-address control verification state
  const [controlStates, setControlStates] = useState<Record<string, ControlState>>({});

  // Address input + balance resolution (Steps 1-2 and the results table).
  // All resolution state and logic lives in the hook; the reset callback also
  // clears the per-address proof-of-control states.
  const {
    addressTab,
    setAddressTab,
    pastedText,
    setPastedText,
    filterOwner,
    setFilterOwner,
    filterWallet,
    setFilterWallet,
    balanceSource,
    setBalanceSource,
    rows,
    dupes,
    isChecking,
    summary,
    providerError,
    runCheck,
    handleCancel,
    handleReset,
  } = useBalanceCheck({
    nodeSettings,
    onReset: () => setControlStates({}),
  });

  // Declarant form
  const [declarantName, setDeclarantName] = useState("");
  const [declarantContact, setDeclarantContact] = useState("");
  const [declarantResidentialAddress, setDeclarantResidentialAddress] = useState("");
  const [declarantDob, setDeclarantDob] = useState("");
  const [declarantTaxId, setDeclarantTaxId] = useState("");
  const [declarantIdNumber, setDeclarantIdNumber] = useState("");
  const [declarantNationality, setDeclarantNationality] = useState("");
  const [declarationDate, setDeclarationDate] = useState(todayString());
  const [purpose, setPurpose] = useState("");
  const [statement, setStatement] = useState("");

  // Declaration nonce — generated once per page session
  const [declarationNonce] = useState<string>(() => generateDeclarationNonce());

  // Optional add-ons for Step 5 (both off by default) — UI lives in ProofOfControlCard,
  // but the values live here because the PDF builder and the signature-invalidation
  // effect below depend on them.
  const [verifierReference, setVerifierReference] = useState("");
  const [freshnessAnchorEnabled, setFreshnessAnchorEnabled] = useState(false);
  const [freshnessAnchor, setFreshnessAnchor] = useState<FreshnessAnchor | null>(null);

  // When declarant identity fields OR proof-of-control add-ons change, any
  // previously-verified signatures are no longer valid (the challenge message
  // they signed has changed).
  const prevDeclarantRef = useRef({
    name: declarantName,
    date: declarationDate,
    purpose,
    verifierReference,
    freshnessAnchor: null as FreshnessAnchor | null,
    freshnessAnchorEnabled,
  });
  useEffect(() => {
    const prev = prevDeclarantRef.current;
    if (
      prev.name !== declarantName ||
      prev.date !== declarationDate ||
      prev.purpose !== purpose ||
      prev.verifierReference !== verifierReference ||
      prev.freshnessAnchor !== freshnessAnchor ||
      prev.freshnessAnchorEnabled !== freshnessAnchorEnabled
    ) {
      prevDeclarantRef.current = { name: declarantName, date: declarationDate, purpose, verifierReference, freshnessAnchor, freshnessAnchorEnabled };
      setControlStates((prev) => {
        const updated: Record<string, ControlState> = {};
        for (const [addr, cs] of Object.entries(prev)) {
          if (cs.status === "verified") {
            updated[addr] = { paste: cs.paste, status: "idle", staleAfterVerify: true };
          } else {
            updated[addr] = cs;
          }
        }
        return updated;
      });
    }
  }, [declarantName, declarationDate, purpose, verifierReference, freshnessAnchor, freshnessAnchorEnabled]);

  // Fiat. Restored from the persisted declaration preferences.
  const [fiatCurrency, setFiatCurrency] = useState(
    () => loadDeclarationPrefs().fiatCurrency,
  );
  const [fiatRate, setFiatRate] = useState(() => loadDeclarationPrefs().fiatRate);

  // Balance-verification QR codes (optional). Restored from persisted preferences.
  const [includeQr, setIncludeQr] = useState(() => loadDeclarationPrefs().includeQr);
  const [qrExplorerId, setQrExplorerId] = useState<ExplorerId>(
    () => loadDeclarationPrefs().qrExplorerId,
  );
  // address -> generated QR data URL for the on-screen preview
  const [qrPreviews, setQrPreviews] = useState<Record<string, string>>({});

  // Acquisition & Provenance section (optional, off by default). Restored from
  // persisted preferences.
  const [includeProvenance, setIncludeProvenance] = useState(
    () => loadDeclarationPrefs().includeProvenance,
  );
  const [provenanceFiatCurrency, setProvenanceFiatCurrency] = useState(
    () => loadDeclarationPrefs().provenanceFiatCurrency,
  );

  // Attestation block (optional, off by default). Initial values are restored
  // from the persisted declaration preferences (see loadDeclarationPrefs).
  const [includeAttestation, setIncludeAttestation] = useState(
    () => loadDeclarationPrefs().includeAttestation,
  );
  const [attestationPlaceOfSigning, setAttestationPlaceOfSigning] = useState(
    () => loadDeclarationPrefs().attestationPlaceOfSigning,
  );
  const [attestationWitnessLine, setAttestationWitnessLine] = useState(
    () => loadDeclarationPrefs().attestationWitnessLine,
  );

  // Glossary (optional, off by default). Restored from persisted preferences.
  const [includeGlossary, setIncludeGlossary] = useState(
    () => loadDeclarationPrefs().includeGlossary,
  );

  // Introduction / preface (optional, off by default). Restored from persisted
  // preferences. When on, a plain-language preface is added to the top of the PDF.
  const [includeIntro, setIncludeIntro] = useState(
    () => loadDeclarationPrefs().includeIntro,
  );

  // AML / Risk Screening section (optional, off by default). Only the section
  // toggle is persisted; the free-text answers below are identity data and are
  // deliberately session-only (see declaration-prefs.ts boundary note).
  const [includeAml, setIncludeAml] = useState(() => loadDeclarationPrefs().includeAml);

  // Persist declaration preferences whenever any of them changes so they are
  // restored on the next page load.
  useEffect(() => {
    saveDeclarationPrefs({
      includeIntro,
      includeAttestation,
      attestationPlaceOfSigning,
      attestationWitnessLine,
      includeGlossary,
      includeQr,
      qrExplorerId,
      includeProvenance,
      provenanceFiatCurrency,
      fiatCurrency,
      fiatRate,
      includeAml,
    });
  }, [
    includeIntro,
    includeAttestation,
    attestationPlaceOfSigning,
    attestationWitnessLine,
    includeGlossary,
    includeQr,
    qrExplorerId,
    includeProvenance,
    provenanceFiatCurrency,
    fiatCurrency,
    fiatRate,
    includeAml,
  ]);
  const [amlPepStatus, setAmlPepStatus] = useState<"not-stated" | "yes" | "no">("not-stated");
  const [amlTaxJurisdiction, setAmlTaxJurisdiction] = useState("");
  const [amlSourceOfWealth, setAmlSourceOfWealth] = useState("");
  const [amlSourceOfFunds, setAmlSourceOfFunds] = useState("");
  const [amlTaxStatement, setAmlTaxStatement] = useState("");
  const [amlScreeningResult, setAmlScreeningResult] = useState<AmlScreeningResult | null>(null);
  const [isComputingAml, setIsComputingAml] = useState(false);


  // Supporting Evidence (optional) — session-only; binary is never persisted.
  const [evidenceItems, setEvidenceItems] = useState<EvidenceItem[]>([]);

  const evidenceImageCount = useMemo(
    () => evidenceItems.filter((it) => it.kind === "image").length,
    [evidenceItems],
  );
  const evidencePdfItems = useMemo(
    () => evidenceItems.filter((it) => it.kind === "pdf"),
    [evidenceItems],
  );

  const validRows = useMemo(() => rows.filter((r) => !r.isInvalid), [rows]);
  const invalidRows = useMemo(() => rows.filter((r) => r.isInvalid), [rows]);
  const doneRows = useMemo(() => validRows.filter((r) => r.status === "done"), [validRows]);
  const emptyRows = useMemo(() => validRows.filter((r) => r.status === "empty"), [validRows]);
  const errorRows = useMemo(() => validRows.filter((r) => r.status === "error"), [validRows]);
  const hasResults = rows.length > 0;

  const fiatRateNum = parseFloat(fiatRate);
  const fiatValid = fiatRate.trim() !== "" && !isNaN(fiatRateNum) && fiatRateNum > 0;

  const totalSats = useMemo(
    () => doneRows.reduce((sum, r) => sum + (r.balanceSats ?? 0), 0),
    [doneRows]
  );

  const fiatTotal = fiatValid && summary ? (totalSats / 1e8) * fiatRateNum : null;

  // Per-address provenance completeness for the Step 7 summary. Mirrors the
  // fields the Acquisition & Provenance appendix reads from each address
  // record so users can see (and fill in) what's missing before generating.
  const provenanceStatus = useMemo(() => {
    const byAddress = new Map<string, NonNullable<typeof addressRecords>[number]>();
    for (const rec of addressRecords ?? []) {
      byAddress.set(rec.inputString, rec);
    }
    return doneRows.map((row) => {
      const rec = byAddress.get(row.raw);
      const hasRecord = !!rec;
      const hasCounterparty =
        !!(rec?.counterpartyName?.trim() || rec?.walletName?.trim() || rec?.label?.trim() || rec?.counterpartyType);
      const missing: string[] = [];
      if (hasRecord) {
        if (!rec?.date) missing.push("Acquisition date");
        if (!rec?.acquisitionMethod) missing.push("Acquisition method");
        if (!hasCounterparty) missing.push("Counterparty");
        if (!(rec?.costBasisUsd && rec.costBasisUsd > 0)) missing.push("Cost basis");
      }
      return {
        address: row.raw,
        recordId: rec?.id,
        hasRecord,
        missing,
      };
    });
  }, [doneRows, addressRecords]);

  const provenanceIncompleteCount = useMemo(
    () => provenanceStatus.filter((s) => !s.hasRecord || s.missing.length > 0).length,
    [provenanceStatus]
  );

  // Proof-of-control summary counts
  const verifiedCount = useMemo(
    () => doneRows.filter((r) => controlStates[r.raw]?.status === "verified").length,
    [doneRows, controlStates]
  );

  // Live on-screen preview of the declarant details. Mirrors the PDF builder:
  // required fields always appear once filled, and each optional identity field
  // only contributes a row when it is non-blank (no stray labels for empty
  // fields). Keeping this list in lockstep with the PDF prevents the preview
  // from drifting from the exported document.
  const declarantPreviewRows = useMemo(() => {
    const previewRows: { key: string; label: string; value: string; testid: string }[] = [];
    if (declarantName.trim())
      previewRows.push({ key: "name", label: "Full Name:", value: declarantName, testid: "preview-declarant-name" });
    if (declarantContact.trim())
      previewRows.push({ key: "contact", label: "Contact / Address:", value: declarantContact, testid: "preview-declarant-contact" });
    if (declarantResidentialAddress.trim())
      previewRows.push({ key: "residential", label: "Residential / Street Address:", value: declarantResidentialAddress, testid: "preview-declarant-residential-address" });
    if (declarantDob.trim())
      previewRows.push({ key: "dob", label: "Date of Birth:", value: declarantDob, testid: "preview-declarant-dob" });
    if (declarantTaxId.trim())
      previewRows.push({ key: "taxid", label: "Tax ID Number:", value: declarantTaxId, testid: "preview-declarant-tax-id" });
    if (declarantIdNumber.trim())
      previewRows.push({ key: "idnumber", label: "Identification Number:", value: declarantIdNumber, testid: "preview-declarant-id-number" });
    if (declarantNationality.trim())
      previewRows.push({ key: "nationality", label: "Nationality:", value: declarantNationality, testid: "preview-declarant-nationality" });
    if (declarationDate)
      previewRows.push({ key: "date", label: "Declaration Date:", value: declarationDate, testid: "preview-declaration-date" });
    if (purpose.trim())
      previewRows.push({ key: "purpose", label: "Purpose:", value: purpose, testid: "preview-purpose" });
    return previewRows;
  }, [
    declarantName,
    declarantContact,
    declarantResidentialAddress,
    declarantDob,
    declarantTaxId,
    declarantIdNumber,
    declarantNationality,
    declarationDate,
    purpose,
  ]);

  // Live preview of the declarant self-attestation lines, derived purely from
  // the attestation inputs. These mirror — word-for-word — the strings written
  // into the PDF's "DECLARANT SELF-ATTESTATIONS" section, so the user gets
  // immediate visual confirmation of what that section will contain as they
  // type. Purely derived from state; no DB query or sanitization needed (the
  // PDF's sanitizePdfText only strips characters the PDF renderer can't draw).
  const attestationPreviewLines = useMemo(
    () =>
      buildAttestationLines({
        pepStatus: amlPepStatus,
        sourceOfWealth: amlSourceOfWealth,
        sourceOfFunds: amlSourceOfFunds,
        taxJurisdiction: amlTaxJurisdiction,
        taxStatement: amlTaxStatement,
      }),
    [amlPepStatus, amlSourceOfWealth, amlSourceOfFunds, amlTaxJurisdiction, amlTaxStatement],
  );

  // Stable key for the set of addresses we have balances for, so the QR preview
  // effect only regenerates when the actual addresses (not the array ref) change.
  const doneAddressKey = useMemo(() => doneRows.map((r) => r.raw).join("|"), [doneRows]);

  // Generate the on-screen QR previews offline whenever the toggle, explorer, or
  // address set changes. QRCode.toDataURL never touches the network — it draws
  // the code locally and returns a data: URL.
  useEffect(() => {
    if (!includeQr || doneRows.length === 0) {
      setQrPreviews({});
      return;
    }
    let cancelled = false;
    const explorer = getExplorer(qrExplorerId);
    // Drop any previous codes immediately so we never show stale images under a
    // newly selected explorer label while the new codes are being drawn.
    setQrPreviews({});
    (async () => {
      const map: Record<string, string> = {};
      for (const r of doneRows) {
        try {
          map[r.raw] = await QRCode.toDataURL(explorer.addressUrl(r.raw), {
            width: 240,
            margin: 1,
            errorCorrectionLevel: "M",
          });
        } catch {
          // Skip a single failed code rather than failing the whole preview.
        }
      }
      if (!cancelled) setQrPreviews(map);
    })();
    return () => {
      cancelled = true;
    };
    // doneAddressKey captures the address set; doneRows ref is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeQr, qrExplorerId, doneAddressKey]);

  // Recompute AML screening whenever the toggle turns on or the address set changes.
  useEffect(() => {
    if (!includeAml || doneRows.length === 0) {
      setAmlScreeningResult(null);
      return;
    }
    let cancelled = false;
    setIsComputingAml(true);
    runAmlScreening(doneRows.map((r) => r.raw))
      .then((result) => {
        if (!cancelled) {
          setAmlScreeningResult(result);
          setIsComputingAml(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsComputingAml(false);
      });
    return () => {
      cancelled = true;
    };
    // doneAddressKey captures the address set; doneRows ref is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeAml, doneAddressKey]);

  const canGeneratePdf =
    doneRows.length > 0 &&
    declarantName.trim() !== "" &&
    declarationDate !== "" &&
    purpose.trim() !== "" &&
    !isChecking;

  // ── PDF generation ──────────────────────────────────────────────────────────
  // Extracted to a dedicated hook; all PDF state lives there.
  const { generatePdf, generateSamplePdf, isGeneratingPdf, isGeneratingSamplePdf } = usePofPdfBuilder({
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
  });
  const validCount = validRows.length;
  const doneCount = doneRows.length + emptyRows.length + errorRows.length;

  const declarantInfoComplete =
    declarantName.trim() !== "" &&
    declarationDate !== "" &&
    purpose.trim() !== "";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <FileText className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Proof of Funds Declaration</h1>
            <p className="text-muted-foreground">
              Generate a formal declaration attesting to Bitcoin address ownership and balances
            </p>
          </div>
        </div>

        {/* Step 1: Address Input */}
        <AddressInputCard
          addressTab={addressTab}
          setAddressTab={setAddressTab}
          pastedText={pastedText}
          setPastedText={setPastedText}
          filterOwner={filterOwner}
          setFilterOwner={setFilterOwner}
          filterWallet={filterWallet}
          setFilterWallet={setFilterWallet}
          isChecking={isChecking}
          owners={owners}
          walletNames={walletNames}
        />

        {/* Step 2: Balance Source */}
        <BalanceSourceCard
          balanceSource={balanceSource}
          setBalanceSource={setBalanceSource}
          isChecking={isChecking}
          addressTab={addressTab}
          pastedText={pastedText}
          hasResults={hasResults}
          validCount={validCount}
          doneCount={doneCount}
          providerError={providerError}
          runCheck={runCheck}
          handleCancel={handleCancel}
          handleReset={handleReset}
        />

        {/* Results */}
        {hasResults && (
          <BalanceResultsCard
            summary={summary}
            dupes={dupes}
            validRows={validRows}
            invalidRows={invalidRows}
            doneRows={doneRows}
            emptyRows={emptyRows}
            errorRows={errorRows}
            isChecking={isChecking}
            balanceSource={balanceSource}
            totalSats={totalSats}
            fiatValid={fiatValid}
            fiatTotal={fiatTotal}
            fiatCurrency={fiatCurrency}
          />
        )}

        {/* Step 3: Declarant Details */}
        <DeclarantDetailsCard
          declarantName={declarantName}
          setDeclarantName={setDeclarantName}
          declarantContact={declarantContact}
          setDeclarantContact={setDeclarantContact}
          declarantResidentialAddress={declarantResidentialAddress}
          setDeclarantResidentialAddress={setDeclarantResidentialAddress}
          declarantDob={declarantDob}
          setDeclarantDob={setDeclarantDob}
          declarantTaxId={declarantTaxId}
          setDeclarantTaxId={setDeclarantTaxId}
          declarantIdNumber={declarantIdNumber}
          setDeclarantIdNumber={setDeclarantIdNumber}
          declarantNationality={declarantNationality}
          setDeclarantNationality={setDeclarantNationality}
          declarationDate={declarationDate}
          setDeclarationDate={setDeclarationDate}
          purpose={purpose}
          setPurpose={setPurpose}
          statement={statement}
          setStatement={setStatement}
          declarantPreviewRows={declarantPreviewRows}
        />

        {/* Step 4: Optional Fiat */}
        <FiatEquivalentCard
          fiatCurrency={fiatCurrency}
          setFiatCurrency={setFiatCurrency}
          fiatRate={fiatRate}
          setFiatRate={setFiatRate}
          fiatValid={fiatValid}
          fiatTotal={fiatTotal}
          summary={summary}
          doneRows={doneRows}
        />

        {/* Step 5: Proof of Control */}
        <ProofOfControlCard
          doneRows={doneRows}
          declarantInfoComplete={declarantInfoComplete}
          declarantName={declarantName}
          declarationDate={declarationDate}
          purpose={purpose}
          declarationNonce={declarationNonce}
          verifiedCount={verifiedCount}
          controlStates={controlStates}
          setControlStates={setControlStates}
          verifierReference={verifierReference}
          setVerifierReference={setVerifierReference}
          freshnessAnchorEnabled={freshnessAnchorEnabled}
          setFreshnessAnchorEnabled={setFreshnessAnchorEnabled}
          freshnessAnchor={freshnessAnchor}
          setFreshnessAnchor={setFreshnessAnchor}
        />


        {/* Step 6: Balance-Verification QR Codes */}
        <QrCodesCard
          includeQr={includeQr}
          setIncludeQr={setIncludeQr}
          doneRows={doneRows}
          qrExplorerId={qrExplorerId}
          setQrExplorerId={setQrExplorerId}
          qrPreviews={qrPreviews}
        />

        {/* Step 7: AML / Risk Screening */}
        <AmlRiskCard
          includeAml={includeAml}
          setIncludeAml={setIncludeAml}
          doneRows={doneRows}
          isComputingAml={isComputingAml}
          amlScreeningResult={amlScreeningResult}
          amlPepStatus={amlPepStatus}
          setAmlPepStatus={setAmlPepStatus}
          amlSourceOfWealth={amlSourceOfWealth}
          setAmlSourceOfWealth={setAmlSourceOfWealth}
          amlSourceOfFunds={amlSourceOfFunds}
          setAmlSourceOfFunds={setAmlSourceOfFunds}
          amlTaxJurisdiction={amlTaxJurisdiction}
          setAmlTaxJurisdiction={setAmlTaxJurisdiction}
          amlTaxStatement={amlTaxStatement}
          setAmlTaxStatement={setAmlTaxStatement}
          attestationPreviewLines={attestationPreviewLines}
        />

        {/* Step 8: Acquisition & Provenance */}
        <ProvenanceCard
          includeProvenance={includeProvenance}
          setIncludeProvenance={setIncludeProvenance}
          provenanceFiatCurrency={provenanceFiatCurrency}
          setProvenanceFiatCurrency={setProvenanceFiatCurrency}
          provenanceStatus={provenanceStatus}
          provenanceIncompleteCount={provenanceIncompleteCount}
          doneRows={doneRows}
          fiatValid={fiatValid}
          fiatTotal={fiatTotal}
          openRecordEdit={openRecordEdit}
        />

        {/* Step 9: Formal Attestation */}
        <AttestationCard
          includeAttestation={includeAttestation}
          setIncludeAttestation={setIncludeAttestation}
          attestationPlaceOfSigning={attestationPlaceOfSigning}
          setAttestationPlaceOfSigning={setAttestationPlaceOfSigning}
          attestationWitnessLine={attestationWitnessLine}
          setAttestationWitnessLine={setAttestationWitnessLine}
        />

        {/* Step 10: Glossary */}
        <GlossaryCard includeGlossary={includeGlossary} setIncludeGlossary={setIncludeGlossary} />

        {/* Step 11: Introduction / Preface */}
        <IntroCard includeIntro={includeIntro} setIncludeIntro={setIncludeIntro} />

        {/* Step 12: Supporting Evidence (optional) */}
        <EvidenceCard
          evidenceItems={evidenceItems}
          setEvidenceItems={setEvidenceItems}
          evidenceImageCount={evidenceImageCount}
          evidencePdfCount={evidencePdfItems.length}
        />

        {/* Step 13: Generate PDF */}
        <Card>
          <CardHeader>
            <CardTitle>Step 13 — Generate PDF</CardTitle>
            <CardDescription>
              All required steps above must be complete before a PDF can be generated.
              The PDF is created entirely in your browser — no data leaves your device.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Sample PDF section */}
            <div className="rounded-md border border-dashed border-muted-foreground/40 p-4 space-y-2 bg-muted/30">
              <p className="text-sm font-medium">Preview the layout first</p>
              <p className="text-xs text-muted-foreground">
                Generate a specimen PDF filled with obviously-fake placeholder data to approve the layout
                before entering your real identity details. The sample is stamped{" "}
                <span className="font-medium">SAMPLE / NOT A VALID DECLARATION</span> on every page and
                contains no real fingerprint or verifiable signatures.
              </p>
              <Button
                onClick={generateSamplePdf}
                disabled={isGeneratingSamplePdf || isGeneratingPdf}
                data-testid="button-generate-sample-pdf"
                variant="outline"
                size="default"
              >
                {isGeneratingSamplePdf ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating Sample…
                  </>
                ) : (
                  <>
                    <FileText className="h-4 w-4 mr-2" />
                    Generate Sample PDF
                  </>
                )}
              </Button>
            </div>

            <Separator />

            {!canGeneratePdf && (
              <div className="space-y-1">
                {doneRows.length === 0 && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Check balances for at least one valid address (Step 2)
                  </p>
                )}
                {declarantName.trim() === "" && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Enter your full name (Step 3)
                  </p>
                )}
                {declarationDate === "" && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Set the declaration date (Step 3)
                  </p>
                )}
                {purpose.trim() === "" && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Enter the purpose of the declaration (Step 3)
                  </p>
                )}
              </div>
            )}

            <Button
              onClick={generatePdf}
              disabled={!canGeneratePdf || isGeneratingPdf}
              data-testid="button-generate-pdf"
              size="default"
            >
              {isGeneratingPdf ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Generate &amp; Download PDF
                </>
              )}
            </Button>

            {canGeneratePdf && (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>
                  The PDF will include: declarant details, statement, {doneRows.length} address{doneRows.length !== 1 ? "es" : ""} with
                  balances and control status, total ({formatBTC(totalSats)} BTC){fiatValid && fiatTotal !== null ? ", fiat equivalent," : ","} data
                  source attestation, disclaimers, a signature block, and a document integrity section
                  (page numbers, reference ID, content fingerprint, and blockchain time-anchor).
                  {includeIntro && " A plain-language introduction will appear at the very top, before the declarant details."}
                  {includeAttestation && " A formal attestation block will be included."}
                  {includeQr && ` Verification QR codes linking each address to ${getExplorer(qrExplorerId).host} will be included.`}
                  {verifiedCount > 0 && ` An appendix will contain the challenge messages and signatures for ${verifiedCount} verified address${verifiedCount !== 1 ? "es" : ""}.`}
                  {includeProvenance && ` An Acquisition & Provenance appendix will document acquisition dates, methods, and cost basis (in ${provenanceFiatCurrency}) for the declared addresses, plus a list of linked supporting documents.`}
                  {includeAml && " An AML / Risk Screening appendix will include offline entity-list results, indirect proximity analysis, declarant self-attestations, and a screening disclaimer."}
                  {includeGlossary && " A glossary appendix will define key terms for non-technical reviewers."}
                  {evidenceItems.length > 0 && ` ${evidenceItems.length} supporting evidence file${evidenceItems.length !== 1 ? "s" : ""} will be attached: ${evidenceImageCount} image${evidenceImageCount !== 1 ? "s" : ""} embedded in an appendix${evidencePdfItems.length > 0 ? ` and ${evidencePdfItems.length} PDF${evidencePdfItems.length !== 1 ? "s" : ""} merged as extra pages` : ""}.`}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
