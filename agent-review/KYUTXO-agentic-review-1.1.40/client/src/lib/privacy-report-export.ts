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
 * JSON report. `citations` is present (as an array) for direct (ENTITY_*) and
 * indirect proximity (PROXIMITY_*) findings; it is omitted entirely for every
 * other finding type.
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
  scoreDelta?: number;
}

/**
 * Format a finding's score impact the same way the in-app Privacy Audit report
 * does — e.g. "-3 pts", or "<-1 pts" for a sub-1-point penalty. Returns `null`
 * for findings with no penalty (no scoreDelta, or a non-negative delta) so the
 * caller can omit the impact entirely. This is the single source of truth for
 * the per-finding score-impact label, shared by the HTML and text exports.
 */
export function formatScoreDelta(scoreDelta: number | undefined): string | null {
  if (scoreDelta === undefined || scoreDelta >= 0) return null;
  const value = scoreDelta > -1 ? "<-1" : String(Math.round(scoreDelta));
  return `${value} pts`;
}

/**
 * Collect the individual findings aggregated into a single Score Breakdown
 * category, in the same flat `[...findings, ...warnings]` order the on-screen
 * report uses when stepping through same-type findings. Returns `[]` for the
 * synthetic BASE row. This is the single source of truth for the per-category
 * grouping shared by the JSON, text, and HTML exports so the breakdown enumerated
 * in the artifact matches what the user reviewed on screen.
 */
export function findingsOfType(
  result: PrivacyAuditResult,
  findingType: PrivacyFindingType | "BASE",
): PrivacyFinding[] {
  if (findingType === "BASE") return [];
  return [...result.findings, ...result.warnings].filter((f) => f.type === findingType);
}

/**
 * A compact one-line locator for an individual finding used when the exports
 * enumerate the same-type findings under an aggregated Score Breakdown category:
 * its primary address and/or transaction id, each suffixed with "(+N more)" when
 * the finding spans several. Returns "—" when the finding carries neither.
 * Addresses/txids are emitted as plain text and are never fetched (offline-first).
 */
export function formatFindingLocator(f: PrivacyFinding): string {
  const parts: string[] = [];
  if (f.addresses.length > 0) {
    const more = f.addresses.length > 1 ? ` (+${f.addresses.length - 1} more)` : "";
    parts.push(`addr ${f.addresses[0]}${more}`);
  }
  if (f.txids.length > 0) {
    const more = f.txids.length > 1 ? ` (+${f.txids.length - 1} more)` : "";
    parts.push(`tx ${f.txids[0]}${more}`);
  }
  return parts.length > 0 ? parts.join("  ·  ") : "—";
}

/**
 * Surface per-entity source citations (name, address, category label and the
 * public attribution note) as a clean field on entity findings so the citation
 * travels with the exported report. Both direct (ENTITY_*) and indirect
 * proximity (PROXIMITY_*) findings carry citations built from the public entity
 * list, so both prefixes are surfaced here. Returns `undefined` for every other
 * finding type (and for findings with no citations) so the field is omitted from
 * the serialized JSON. URLs inside `sourceNote` are passed through as plain
 * text — they are never fetched (offline-first).
 */
export function extractCitations(f: PrivacyFinding): EntityCitation[] | undefined {
  if (!f.type.startsWith("ENTITY_") && !f.type.startsWith("PROXIMITY_")) return undefined;
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
    scoreDelta: f.scoreDelta,
  };
}

/** Owner/wallet scope the audit was run against (null = "All"). */
export interface ExportScope {
  owner: string | null;
  wallet: string | null;
}

/**
 * Compute the single report-wide scope caption for a single-run Privacy Report,
 * matching the wording the history exporter uses (computePrivacyHistoryScopeLabel):
 *   - "Scope: Owner = Alice"
 *   - "Scope: Wallet = Cold Storage"
 *   - "Scope: Owner = Bob, Wallet = Trading"
 *   - "Scope: All addresses"   (no owner/wallet filter — full vault)
 * Empty strings are treated the same as unset so a blank owner/wallet never
 * reads as a distinct filter. This is the single source of truth for the
 * per-audit scope caption, shared by the HTML, text, and on-screen surfaces so
 * they cannot drift.
 */
export function computeExportScopeLabel(scope: ExportScope): string {
  const parts: string[] = [];
  if (scope.owner) parts.push(`Owner = ${scope.owner}`);
  if (scope.wallet) parts.push(`Wallet = ${scope.wallet}`);
  return `Scope: ${parts.length ? parts.join(", ") : "All addresses"}`;
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

/**
 * A single same-type finding nested under its Score Breakdown category in the
 * exported JSON. Carries only the per-finding context the user explored on
 * screen — its address(es)/tx(s) and individual score impact — without
 * duplicating the full finding payload already present in the top-level
 * `findings`/`warnings` arrays.
 */
export interface ExportedWaterfallFinding {
  severity: PrivacySeverity;
  addresses: string[];
  txids: string[];
  scoreDelta?: number;
}

/**
 * A Score Breakdown waterfall entry in the exported JSON. Mirrors the audit's
 * {@link ScoreWaterfallEntry} (label/findingType/delta/runningScore/count) and
 * additionally enumerates the individual `findings` aggregated into the category
 * so the exported breakdown lists each finding, not just the per-type count.
 * Empty for the BASE row and for categories with no captured findings.
 */
export interface ExportedWaterfallEntry extends ScoreWaterfallEntry {
  findings: ExportedWaterfallFinding[];
}

/** Full shape of the exported Privacy Audit JSON report. */
export interface ExportedReport {
  generatedAt: string;
  scope: ExportScope;
  summary: ExportedSummary;
  scoreWaterfall: ExportedWaterfallEntry[];
  findings: ExportedFinding[];
  warnings: ExportedFinding[];
}

/** Map an internal PrivacyFinding to the compact per-finding shape nested under
 * its Score Breakdown category in the exported JSON. */
export function toWaterfallFinding(f: PrivacyFinding): ExportedWaterfallFinding {
  return {
    severity: f.severity,
    addresses: f.addresses,
    txids: f.txids,
    scoreDelta: f.scoreDelta,
  };
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
    scoreWaterfall: result.scoreWaterfall.map((entry) => ({
      ...entry,
      findings: findingsOfType(result, entry.findingType).map(toWaterfallFinding),
    })),
    findings: result.findings.map(mapFinding),
    warnings: result.warnings.map(mapFinding),
  };
}

/** Human-friendly severity label ("CRITICAL" → "Critical"). */
export function severityLabel(s: PrivacySeverity): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * Assemble the plain-text (.txt) Privacy Audit export from an audit result and
 * the chosen owner/wallet scope. Like buildPrivacyReport, this is the single
 * source of truth for the text export so the UI export action and its tests
 * cannot drift. URLs in citation `sourceNote` are emitted as plain text and are
 * never fetched (offline-first).
 */
export function buildPrivacyTextReport(
  result: PrivacyAuditResult,
  scope: ExportScope,
  generatedAt: string = new Date().toLocaleString(),
): string {
  const lines: string[] = [];
  const sep = "=".repeat(60);
  const sub = "-".repeat(60);

  lines.push(sep);
  lines.push("PRIVACY AUDIT REPORT");
  lines.push(sep);
  lines.push(`Generated: ${generatedAt}`);
  lines.push("All analysis ran fully offline.");
  lines.push(computeExportScopeLabel(scope));
  lines.push(`Owner: ${scope.owner ?? "All"}`);
  lines.push(`Wallet: ${scope.wallet ?? "All"}`);
  lines.push("");

  lines.push(`Grade: ${result.grade}`);
  lines.push(`Score: ${result.score}/100`);
  lines.push(`Transactions Analyzed: ${result.transactionsAnalyzed.toLocaleString()}`);
  lines.push(`Addresses Scanned: ${result.addressesScanned.toLocaleString()}`);
  if (result.needsResync) {
    lines.push(`Fingerprint Coverage: ${Math.round(result.fingerprintCoverage * 100)}% — re-sync recommended for complete results.`);
  }
  lines.push("");

  const allFindings = [...result.findings, ...result.warnings];
  const severityCounts = (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as PrivacySeverity[])
    .map(sev => ({ sev, count: allFindings.filter(f => f.severity === sev).length }))
    .filter(x => x.count > 0);

  lines.push(sub);
  lines.push("SEVERITY BREAKDOWN");
  lines.push(sub);
  if (severityCounts.length > 0) {
    for (const x of severityCounts) {
      lines.push(`  ${severityLabel(x.sev)}: ${x.count}`);
    }
  } else {
    lines.push("  Clean — no privacy findings.");
  }
  lines.push("");

  if (result.scoreWaterfall.length > 0) {
    lines.push(sub);
    lines.push("SCORE BREAKDOWN");
    lines.push(sub);
    for (const entry of result.scoreWaterfall) {
      const count = entry.count > 0 ? entry.count.toLocaleString() : "—";
      const delta = entry.delta === 0 ? "—" : (entry.delta > 0 ? "+" : "") + entry.delta;
      lines.push(`  ${entry.label}`);
      lines.push(`    Count: ${count}  ·  Delta: ${delta}  ·  Score: ${entry.runningScore}`);
      // Enumerate the individual findings aggregated into this category so the
      // per-finding context (address/tx + score impact) the user stepped through
      // on screen travels with the artifact, grouped under their category.
      const members = findingsOfType(result, entry.findingType);
      members.forEach((f, idx) => {
        const impact = formatScoreDelta(f.scoreDelta);
        const suffix = impact ? `   —  ${impact}` : "";
        lines.push(`      ${idx + 1}. ${formatFindingLocator(f)}${suffix}`);
      });
    }
    lines.push("");
  }

  lines.push(sub);
  lines.push(`FINDINGS & WARNINGS (${allFindings.length})`);
  lines.push(sub);
  if (allFindings.length === 0) {
    lines.push("No privacy findings — your transaction history is clean.");
  } else {
    allFindings.forEach((f, i) => {
      const label = FINDING_TYPE_LABELS[f.type] ?? f.type;
      lines.push(`${i + 1}. [${severityLabel(f.severity)}] ${label}`);
      lines.push(`   ${f.description}`);
      if (f.correction) lines.push(`   Fix: ${f.correction}`);
      const scoreImpact = formatScoreDelta(f.scoreDelta);
      if (scoreImpact) lines.push(`   Score Impact: ${scoreImpact}`);
      const meta: string[] = [];
      if (f.addresses.length > 0) meta.push(`${f.addresses.length} address(es)`);
      if (f.txids.length > 0) meta.push(`${f.txids.length} transaction(s)`);
      if (meta.length > 0) lines.push(`   ${meta.join("  ·  ")}`);
      const citations = extractCitations(f);
      if (citations && citations.length > 0) {
        lines.push("   Source Citations:");
        for (const c of citations) {
          lines.push(`     - ${c.name} (${c.categoryLabel})`);
          lines.push(`       Address: ${c.address}`);
          if (c.sourceNote) lines.push(`       Source: ${c.sourceNote}`);
        }
      }
      lines.push("");
    });
  }

  lines.push(sep);
  lines.push("KYUTXO Privacy Audit · Offline-first compliance artifact.");
  lines.push("Citation URLs are shown as plain text and are never fetched.");
  lines.push(sep);

  return lines.join("\n");
}

/** What a triggered text-report download produced, so callers/tests can assert
 * the blob contents and filename without re-deriving them. */
export interface PrivacyTextDownload {
  blob: Blob;
  filename: string;
}

/** Build the dated download filename for the plain-text report — the single
 * source of truth for the `privacy-audit-report-<YYYY-MM-DD>.txt` pattern. */
export function privacyTextReportFilename(date: Date = new Date()): string {
  return `privacy-audit-report-${date.toISOString().slice(0, 10)}.txt`;
}

/**
 * Extracted logic behind the in-app "Export Text" button on the Privacy Audit
 * report. Wraps the already-built plain-text report in a text/plain Blob and
 * triggers a browser download via a temporary anchor, creating and revoking the
 * object URL. Returns the blob + filename so it can be unit-tested independently
 * of the React component (mirrors copyPrivacyReportText for the Copy button).
 */
export function downloadPrivacyTextReport(
  text: string,
  date: Date = new Date(),
): PrivacyTextDownload {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const filename = privacyTextReportFilename(date);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return { blob, filename };
}

/**
 * The minimal toast callback shape the copy helper needs. The real
 * `useToast().toast` returns a handle object, but the helper only relies on the
 * call's side effect, so a `=> void` return keeps it easy to test.
 */
export type ReportCopyToast = (opts: {
  variant?: "default" | "destructive";
  title: string;
  description: string;
}) => void;

/**
 * The outcome of an in-app copy attempt, so callers/tests can assert which
 * branch ran without inspecting toast text.
 */
export type ReportCopyOutcome = "copied" | "unavailable" | "failed";

/**
 * Extracted logic behind the in-app "Copy" button on the Privacy Audit report.
 * Writes the already-built plain-text report to the async Clipboard API and
 * surfaces the result via `toast`:
 *   - no `navigator.clipboard.writeText`  → "Clipboard Unavailable" (destructive)
 *   - write succeeds                      → "Copied to Clipboard"
 *   - write rejects                       → "Copy Failed" (destructive)
 * This is the single source of truth for that handler so it can be unit-tested
 * independently of the React component.
 */
export async function copyPrivacyReportText(
  text: string,
  toast: ReportCopyToast,
): Promise<ReportCopyOutcome> {
  if (!navigator.clipboard?.writeText) {
    toast({
      variant: "destructive",
      title: "Clipboard Unavailable",
      description: "Copying isn't supported here. Use Export Text to save the report instead.",
    });
    return "unavailable";
  }

  try {
    await navigator.clipboard.writeText(text);
    toast({
      title: "Copied to Clipboard",
      description: "The Privacy Audit report is ready to paste.",
    });
    return "copied";
  } catch {
    toast({
      variant: "destructive",
      title: "Copy Failed",
      description: "Couldn't access the clipboard. Use Export Text to save the report instead.",
    });
    return "failed";
  }
}
