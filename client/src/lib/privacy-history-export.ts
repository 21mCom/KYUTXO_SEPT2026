import { FINDING_TYPE_LABELS, type PrivacyFindingType } from "@/lib/privacy-audit";
import type { PrivacyAuditHistoryEntry } from "@/lib/database";

/**
 * Escape a single CSV cell per RFC 4180: wrap in double quotes when the value
 * contains a comma, quote, or newline, doubling any embedded quotes.
 */
function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Human-friendly label for a finding type column header. */
function findingTypeLabel(type: string): string {
  return FINDING_TYPE_LABELS[type as PrivacyFindingType] ?? type;
}

/**
 * Build a CSV export of stored Privacy Audit history runs. Each row is one
 * audit run; columns cover the run timestamp, score, grade, totals, severity
 * counts, scope, and one column per finding type encountered across all runs
 * (union, sorted by label for stable output). Runs are emitted newest → oldest.
 *
 * This is the single source of truth for the history CSV shape so the UI export
 * action and its tests cannot drift. Fully offline — no external resources.
 */
export function buildPrivacyHistoryCsv(entries: PrivacyAuditHistoryEntry[]): string {
  // Collect the union of finding types across every run so each becomes a
  // dedicated column, even if a given run never saw that type.
  const findingTypes = new Set<string>();
  for (const e of entries) {
    for (const type of Object.keys(e.findingTypeCounts ?? {})) {
      findingTypes.add(type);
    }
  }
  const sortedTypes = Array.from(findingTypes).sort((a, b) =>
    findingTypeLabel(a).localeCompare(findingTypeLabel(b)),
  );

  const headers = [
    "Timestamp (ISO)",
    "Date",
    "Score",
    "Grade",
    "Total Findings",
    "Transactions Analyzed",
    "Addresses Scanned",
    "Critical",
    "High",
    "Medium",
    "Low",
    "Owner",
    "Wallet",
    ...sortedTypes.map(findingTypeLabel),
  ];

  // Newest first to match the on-screen history list.
  const ordered = [...entries].sort((a, b) => b.timestamp - a.timestamp);

  const rows = ordered.map((e) => {
    const sev = e.severityCounts ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    return [
      new Date(e.timestamp).toISOString(),
      new Date(e.timestamp).toLocaleString(),
      e.score,
      e.grade,
      e.totalFindings,
      e.transactionsAnalyzed,
      e.addressesScanned,
      sev.CRITICAL ?? 0,
      sev.HIGH ?? 0,
      sev.MEDIUM ?? 0,
      sev.LOW ?? 0,
      e.owner ?? "All",
      e.walletName ?? "All",
      ...sortedTypes.map((type) => e.findingTypeCounts?.[type] ?? 0),
    ];
  });

  const lines = [headers, ...rows].map((cols) => cols.map(csvCell).join(","));
  return lines.join("\r\n");
}
