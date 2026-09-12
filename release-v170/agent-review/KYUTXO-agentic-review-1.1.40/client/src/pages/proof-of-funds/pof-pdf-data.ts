// Computes the effective declaration data (real vs sample) plus the content
// fingerprint / canonical payload for the Proof of Funds PDF. Extracted
// verbatim from the pre-split builder — zero behavior change.
import { buildChallengeMessage, type SignatureFormat } from "@/lib/signatureVerify";
import { KYUTXO_APP_VERSION } from "./declaration-prefs";
import type { EffRow, PofPdfData, UsePofPdfBuilderParams } from "./pof-pdf-context";

export async function computePofPdfData(
  params: UsePofPdfBuilderParams,
  isSample: boolean,
): Promise<PofPdfData> {
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
    freshnessAnchor,
  } = params;

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
        // Must pass verifierReference / freshnessAnchor exactly as the live
        // verification flow (proof-of-control-card) and the printed challenge
        // section (pof-pdf-section-proof-of-control) do, so the CTRL_*_CHALLENGE
        // line hashed into the fingerprint equals the message signers actually
        // signed.
        const challengeMsg = buildChallengeMessage({
          address: r.raw,
          declarantName,
          declarationDate,
          purpose,
          nonce: declarationNonce,
          verifierReference: verifierReference || undefined,
          freshnessAnchor: freshnessAnchor ?? undefined,
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

  return {
    isSample,
    params,
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
    effVerifiedRows,
    hasVerified,
    allVerified,
    effTotalSats,
    effFiatValid,
    effFiatRate,
    effFiatCurrency,
    effFiatTotal,
    effSummary,
    generationTimestamp,
    generationIso,
    contentFingerprint,
    canonicalPayload,
    sampleEffRows: SAMPLE_EFF_ROWS,
  };
}
