/**
 * Shared, pure string builders for the AML / Risk-Screening appendix of the
 * Proof-of-Funds declaration.
 *
 * The appendix's fixed boilerplate (section headings, result lines, proximity
 * verdicts, the general attestation and the screening disclaimer) and its
 * entity-list/source description used to be built inline inside the PDF
 * generator in `ProofOfFundsDeclaration.tsx`. Nothing pinned that wording and
 * the entity-list description was duplicated again in the on-screen screening
 * preview, so a future edit to one copy could silently diverge from the other
 * or quietly change the meaning of the appendix.
 *
 * Centralising the strings here — the same way `attestationLines.ts` did for
 * the declarant self-attestation lines — makes that drift impossible by
 * construction and lets a unit test pin both the exact wording and the branch
 * logic. The only intended difference between the on-screen preview and the PDF
 * is the optional `sanitize` callback the PDF applies to user-supplied values
 * (the imported entity-list file label, the nearest-entity name/category) so
 * jsPDF's Standard-14 Helvetica font never falls back to a garbled byte stream.
 * Fixed boilerplate is never sanitized because it is already WinAnsi-safe.
 */

const identity = (s: string) => s;

/** Fixed AML appendix boilerplate. Pinned word-for-word by a unit test. */
export const AML_APPENDIX_STRINGS = {
  /** Appendix page title. */
  appendixTitle: "APPENDIX: AML / RISK SCREENING",

  /** Section headings. */
  screeningParametersHeading: "SCREENING PARAMETERS",
  directMatchResultsHeading: "DIRECT MATCH RESULTS",
  indirectProximityAnalysisHeading: "INDIRECT PROXIMITY ANALYSIS",
  declarantSelfAttestationsHeading: "DECLARANT SELF-ATTESTATIONS",
  screeningDisclaimerHeading: "SCREENING DISCLAIMER",

  /** Direct-match branch (no matches). */
  noDirectMatchesResult: "Result: No direct matches detected.",
  noDirectMatchesDetail:
    "None of the declared addresses appear in the active entity list.",

  /** Indirect proximity branch — no synced transaction graph. */
  noGraphDataDetail:
    "No transaction history is available for these addresses in the local vault. " +
    "Indirect proximity analysis requires synced transaction data.",

  /** Indirect proximity branch — graph present, no flagged counterparty found. */
  noProximityMatchResult:
    "No flagged counterparty detected within 4 transaction hops.",
  noProximityMatchDetail:
    "The declared addresses have no indirect on-chain links to known flagged entities within the analysed transaction graph (up to 4 hops).",

  /** General attestation paragraph (always rendered). */
  generalAttestation:
    "General attestation: The declarant attests that the declared funds are not derived from, do not represent proceeds of, and are not intended to be used in connection with any criminal activity, money laundering, terrorist financing, tax evasion, or sanctions evasion.",

  /** Screening limitations disclaimer (always rendered). */
  screeningDisclaimer:
    'IMPORTANT — LIMITATIONS OF THIS SCREENING: This AML / risk screening is a best-effort, offline check performed by KYUTXO against a bundled dataset of publicly documented addresses compiled from open sources (WalletExplorer.com address clustering, GraphSense TagPacks, OFAC SDN designations, and published incident reports). It is NOT a substitute for the financial institution\'s own KYC/AML procedures, licensed chain-analysis tooling, or regulatory obligations. A "no direct match" result does not guarantee the funds are free of risk, and this document does not constitute a legal clearance opinion. The declarant\'s self-attestations are unverified statements and must be independently assessed by the receiving institution. All risk decisions remain the sole responsibility of the institution\'s compliance function.',
} as const;

/** Format a hop distance consistently for both on-screen preview and the PDF. */
export function formatHopLabel(hops: number): string {
  return hops >= 4 ? `${hops}+ hops` : `${hops} hop${hops !== 1 ? "s" : ""}`;
}

/** `Screening date: <yyyy-mm-dd>` parameter line. */
export function buildScreeningDateLine(screeningDate: string): string {
  return `Screening date: ${screeningDate}`;
}

/** `Addresses screened: <n>` parameter line. */
export function buildAddressesScreenedLine(screenedCount: number): string {
  return `Addresses screened: ${screenedCount}`;
}

/** Red-header direct-match result line for the "matches detected" branch. */
export function buildDirectMatchResultLine(matchCount: number): string {
  return `Result: ${matchCount} direct match(es) detected — see table below.`;
}

export interface EntityListDescriptionInput {
  entityListSource: "bundled" | "imported";
  entityListCount: number;
  /** Unix timestamp (ms) when the snapshot was imported, if applicable. */
  entityListImportedAt: number | null;
  /** User-supplied label for the imported snapshot file, if applicable. */
  entityListSourceLabel: string | null;
}

/**
 * Build the full `Entity list: …` description line shared by the on-screen
 * screening preview and the PDF appendix.
 *
 * @param sanitize Optional transform applied only to the user-supplied imported
 *                 file label (the PDF passes `sanitizePdfText`; the on-screen
 *                 preview leaves it as identity).
 */
export function buildEntityListDescription(
  input: EntityListDescriptionInput,
  sanitize: (s: string) => string = identity,
): string {
  if (input.entityListSource === "bundled") {
    return `Entity list: Bundled (KYUTXO default) — ${input.entityListCount.toLocaleString()} known addresses`;
  }

  const parts = [
    `User-imported snapshot — ${input.entityListCount.toLocaleString()} known addresses`,
  ];
  if (input.entityListSourceLabel) {
    parts.push(`file: ${sanitize(input.entityListSourceLabel)}`);
  }
  if (input.entityListImportedAt) {
    parts.push(
      `imported: ${new Date(input.entityListImportedAt).toISOString().slice(0, 10)}`,
    );
  }
  return `Entity list: ${parts.join(", ")}`;
}

export interface NearestEntityLineInput {
  nearestHopDistance: number;
  nearestHopEntityName: string | null;
  nearestHopCategoryLabel: string | null;
}

/**
 * Build the "Nearest flagged entity: …" proximity line for the PDF.
 *
 * @param sanitize Optional transform applied to the user-facing entity name and
 *                 category label (the PDF passes `sanitizePdfText`).
 */
export function buildNearestEntityLine(
  input: NearestEntityLineInput,
  sanitize: (s: string) => string = identity,
): string {
  const hopLabel = formatHopLabel(input.nearestHopDistance);
  return `Nearest flagged entity: ${hopLabel} away — ${sanitize(
    input.nearestHopEntityName ?? "",
  )} (${sanitize(input.nearestHopCategoryLabel ?? "")})`;
}
