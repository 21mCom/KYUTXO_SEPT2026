import {
  FINDING_TYPE_LABELS,
  type PrivacyFinding,
  type PrivacyFindingType,
  type PrivacySeverity,
  type EntityCitation,
  type PrivacyAuditResult,
  type ScoreWaterfallEntry,
} from "@/lib/privacy-audit";

/**
 * The shape of a single finding as it appears in the exported Privacy Audit
 * JSON report. `citations` is only present (as an array) for ENTITY_* findings;
 * it is omitted entirely for every other finding type.
 */
export interface ExportedFinding {
  type: PrivacyFindingType;
  label: string;
  severity: PrivacySeverity;
  description: string;
  correction: string;
  txids: string[];
  addresses: string[];
  details: Record<string, unknown>;
  citations?: EntityCitation[];
}

/**
 * Surface per-entity source citations (name, address, category label and the
 * public attribution note) as a clean field on ENTITY_* findings so the citation
 * travels with the exported report. Returns `undefined` for non-entity findings
 * (and for entity findings with no citations) so the field is omitted from the
 * serialized JSON. URLs inside `sourceNote` are passed through as plain text —
 * they are never fetched (offline-first).
 */
export function extractCitations(f: PrivacyFinding): EntityCitation[] | undefined {
  if (!f.type.startsWith("ENTITY_")) return undefined;
  const citations = (f.details as { citations?: EntityCitation[] }).citations;
  if (!citations || citations.length === 0) return undefined;
  return citations.map((c) => ({
    name: c.name,
    address: c.address,
    categoryLabel: c.categoryLabel,
    sourceNote: c.sourceNote,
  }));
}

/** Map an internal PrivacyFinding to its exported report shape. */
export function mapFinding(f: PrivacyFinding): ExportedFinding {
  return {
    type: f.type,
    label: FINDING_TYPE_LABELS[f.type] ?? f.type,
    severity: f.severity,
    description: f.description,
    correction: f.correction,
    txids: f.txids,
    addresses: f.addresses,
    details: f.details,
    citations: extractCitations(f),
  };
}

/** Owner/wallet scope the audit was run against (null = "All"). */
export interface ExportScope {
  owner: string | null;
  wallet: string | null;
}

/** Condensed audit summary block carried at the top of the exported report. */
export interface ExportedSummary {
  score: number;
  grade: string;
  transactionsAnalyzed: number;
  addressesScanned: number;
  isClean: boolean;
  fingerprintCoverage: number;
  needsResync: boolean;
  findingsCount: number;
  warningsCount: number;
}

/** Full shape of the exported Privacy Audit JSON report. */
export interface ExportedReport {
  generatedAt: string;
  scope: ExportScope;
  summary: ExportedSummary;
  scoreWaterfall: ScoreWaterfallEntry[];
  findings: ExportedFinding[];
  warnings: ExportedFinding[];
}

/**
 * Assemble the full Privacy Audit JSON export report from an audit result and
 * the chosen owner/wallet scope. This is the single source of truth for the
 * exported report shape — used both by the UI export action and by tests, so
 * the two cannot drift. URLs in citation `sourceNote` remain plain text and are
 * never fetched (offline-first).
 */
export function buildPrivacyReport(
  result: PrivacyAuditResult,
  scope: ExportScope,
  generatedAt: string = new Date().toISOString(),
): ExportedReport {
  return {
    generatedAt,
    scope,
    summary: {
      score: result.score,
      grade: result.grade,
      transactionsAnalyzed: result.transactionsAnalyzed,
      addressesScanned: result.addressesScanned,
      isClean: result.isClean,
      fingerprintCoverage: result.fingerprintCoverage,
      needsResync: result.needsResync,
      findingsCount: result.findings.length,
      warningsCount: result.warnings.length,
    },
    scoreWaterfall: result.scoreWaterfall,
    findings: result.findings.map(mapFinding),
    warnings: result.warnings.map(mapFinding),
  };
}
