import { FINDING_TYPE_LABELS, type PrivacyFindingType } from "@/lib/privacy-audit";
import type { PrivacyAuditHistoryEntry } from "@/lib/database";
import { sanitizePdfText } from "@/lib/pdfText";

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

/**
 * Strip embedded line breaks from a string value so it is safe to embed
 * in a single-line preamble comment or label without scrambling the CSV row
 * structure. Replaces CR, LF, and CRLF sequences with a single space.
 */
function stripLineBreaks(s: string): string {
  return s.replace(/\r\n|\r|\n/g, " ");
}

/** Human-friendly label for a finding type column header. */
function findingTypeLabel(type: string): string {
  return FINDING_TYPE_LABELS[type as PrivacyFindingType] ?? type;
}

/**
 * Compute a single, report-wide scope label when every run in the export shares
 * the same owner/wallet filter, so a reader can tell at a glance that the whole
 * report is a filtered (or full-vault) view rather than scanning the per-row
 * Owner/Wallet columns. Returns:
 *   - "Scope: Owner = Alice"
 *   - "Scope: Wallet = Cold Storage"
 *   - "Scope: Owner = Bob, Wallet = Trading"
 *   - "Scope: All addresses"   (every run is full-vault / unfiltered)
 * Returns null when there are no runs, or when runs span more than one scope —
 * in that mixed case there is no single truthful label, so callers fall back to
 * the existing per-row Owner/Wallet columns. Empty strings are treated the same
 * as unset so a blank owner/wallet never reads as a distinct filter.
 */
export function computePrivacyHistoryScopeLabel(
  entries: PrivacyAuditHistoryEntry[],
): string | null {
  if (entries.length === 0) return null;
  const owner = entries[0].owner || undefined;
  const wallet = entries[0].walletName || undefined;
  for (const e of entries) {
    if ((e.owner || undefined) !== owner || (e.walletName || undefined) !== wallet) {
      return null; // mixed scopes — no single global label
    }
  }
  const parts: string[] = [];
  // Strip embedded line breaks so the label can never straddle two CSV rows
  // when used as a preamble line in the exported file.
  if (owner) parts.push(`Owner = ${stripLineBreaks(owner)}`);
  if (wallet) parts.push(`Wallet = ${stripLineBreaks(wallet)}`);
  return `Scope: ${parts.length ? parts.join(", ") : "All addresses"}`;
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
    // Strip embedded line breaks from free-text owner/walletName values so a
    // name containing CR/LF can't break a CSV row across multiple lines and
    // corrupt every subsequent row in the file.
    const ownerCell = e.owner ? stripLineBreaks(e.owner) : "All";
    const walletCell = e.walletName ? stripLineBreaks(e.walletName) : "All";
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
      ownerCell,
      walletCell,
      ...sortedTypes.map((type) => e.findingTypeCounts?.[type] ?? 0),
    ];
  });

  const lines = [headers, ...rows].map((cols) => cols.map(csvCell).join(","));
  const body = lines.join("\r\n");

  // When every run shares one scope, prepend a single preamble line stating it
  // so the filtered (or full-vault) nature of the whole report is unmistakable
  // without scanning the per-row Owner/Wallet columns. Mixed scopes get no
  // preamble — the per-row columns remain the source of truth.
  const scopeLabel = computePrivacyHistoryScopeLabel(entries);
  return scopeLabel ? `${csvCell(scopeLabel)}\r\n${body}` : body;
}

/** Union of finding types across every run, sorted by human label (stable). */
function collectFindingTypes(entries: PrivacyAuditHistoryEntry[]): string[] {
  const types = new Set<string>();
  for (const e of entries) {
    for (const type of Object.keys(e.findingTypeCounts ?? {})) {
      types.add(type);
    }
  }
  return Array.from(types).sort((a, b) =>
    findingTypeLabel(a).localeCompare(findingTypeLabel(b)),
  );
}

/**
 * Draw a self-contained score-trend sparkline (0–100 domain) onto a jsPDF doc.
 * Returns the Y coordinate just below the drawn chart so callers can continue
 * laying out content. No-ops (returns startY) when there are fewer than two
 * points to connect. Pure vector drawing — no images, no external resources.
 */
function drawScoreTrend(
  doc: import("jspdf").jsPDF,
  points: { score: number }[],
  startY: number,
): number {
  const left = 14;
  const right = doc.internal.pageSize.getWidth() - 14;
  const width = right - left;
  const height = 36;
  const top = startY;
  const bottom = top + height;

  // Plot frame.
  doc.setDrawColor(200);
  doc.setLineWidth(0.2);
  doc.rect(left, top, width, height);

  // Reference grid lines for the A (80) and C (60) thresholds, matching the
  // on-screen chart's guides.
  const yFor = (score: number) => bottom - (Math.max(0, Math.min(100, score)) / 100) * height;
  for (const ref of [80, 60]) {
    const y = yFor(ref);
    doc.setDrawColor(225);
    doc.line(left, y, right, y);
    doc.setFontSize(6);
    doc.setTextColor(150);
    doc.text(String(ref), left + 1, y - 0.5);
  }

  if (points.length >= 2) {
    const stepX = width / (points.length - 1);
    doc.setDrawColor(41, 128, 185);
    doc.setLineWidth(0.6);
    for (let i = 1; i < points.length; i++) {
      const x1 = left + stepX * (i - 1);
      const x2 = left + stepX * i;
      doc.line(x1, yFor(points[i - 1].score), x2, yFor(points[i].score));
    }
    doc.setFillColor(41, 128, 185);
    for (let i = 0; i < points.length; i++) {
      doc.circle(left + stepX * i, yFor(points[i].score), 0.6, "F");
    }
  }

  doc.setTextColor(0);
  doc.setDrawColor(0);
  doc.setLineWidth(0.2);
  return bottom + 6;
}

/**
 * Build an offline PDF export of stored Privacy Audit history runs. Mirrors the
 * CSV export's data shape (same fixed columns + per-finding-type union) so the
 * two formats stay aligned, and adds a vector score-trend sparkline plus a
 * findings-by-type table. Runs are emitted newest → oldest.
 *
 * Fully offline — jspdf/autotable are bundled and the chart is drawn with
 * vector primitives, so no external resources are fetched.
 */
export async function buildPrivacyHistoryPdf(
  entries: PrivacyAuditHistoryEntry[],
): Promise<Blob> {
  const jsPDFModule = await import("jspdf");
  const autoTableModule = await import("jspdf-autotable");
  const jsPDF = jsPDFModule.default;
  const autoTable = autoTableModule.default;

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // Newest → oldest for the on-screen / CSV ordering; oldest → newest for the
  // left-to-right trend line.
  const ordered = [...entries].sort((a, b) => b.timestamp - a.timestamp);
  const chrono = [...entries].sort((a, b) => a.timestamp - b.timestamp);

  doc.setFontSize(18);
  doc.text("Privacy Score History", 14, 20);

  doc.setFontSize(10);
  doc.setTextColor(90);
  const summaryParts = [`${ordered.length} audit run${ordered.length === 1 ? "" : "s"}`];
  if (chrono.length > 1) {
    const delta = chrono[chrono.length - 1].score - chrono[0].score;
    summaryParts.push(`${delta > 0 ? "+" : ""}${delta} pts overall`);
  }
  if (ordered.length > 0) {
    summaryParts.push(`latest ${ordered[0].score}/100 (${ordered[0].grade})`);
  }
  // Lead the summary line with the report-wide scope when every run shares one,
  // so a filtered (or full-vault) export is labelled prominently at the top.
  // Mixed-scope exports get no global label (the per-run table columns stand).
  const scopeLabel = computePrivacyHistoryScopeLabel(entries);
  if (scopeLabel) summaryParts.unshift(sanitizePdfText(scopeLabel));
  doc.text(summaryParts.join("  |  "), 14, 27);
  doc.setTextColor(0);

  let cursorY = 33;
  if (chrono.length >= 2) {
    cursorY = drawScoreTrend(doc, chrono, cursorY);
  }

  // Primary runs table — per-run timestamp, score, grade, totals and severity.
  const runHead = [
    "Date",
    "Score",
    "Grade",
    "Total",
    "Txns",
    "Addrs",
    "Crit",
    "High",
    "Med",
    "Low",
    "Owner",
    "Wallet",
  ];
  const runBody = ordered.map((e) => {
    const sev = e.severityCounts ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    return [
      new Date(e.timestamp).toLocaleString(),
      String(e.score),
      e.grade,
      String(e.totalFindings),
      String(e.transactionsAnalyzed),
      String(e.addressesScanned),
      String(sev.CRITICAL ?? 0),
      String(sev.HIGH ?? 0),
      String(sev.MEDIUM ?? 0),
      String(sev.LOW ?? 0),
      sanitizePdfText(e.owner ?? "All"),
      sanitizePdfText(e.walletName ?? "All"),
    ];
  });

  autoTable(doc, {
    startY: cursorY,
    head: [runHead],
    body: runBody,
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [41, 128, 185] },
  });

  // Findings-by-type table — one column per finding type seen across all runs.
  const findingTypes = collectFindingTypes(entries);
  if (findingTypes.length > 0) {
    const lastTable = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    const typeStartY = (lastTable?.finalY ?? cursorY) + 8;
    doc.setFontSize(11);
    doc.text("Findings by Type", 14, typeStartY);
    autoTable(doc, {
      startY: typeStartY + 3,
      head: [["Date", ...findingTypes.map(findingTypeLabel)]],
      body: ordered.map((e) => [
        new Date(e.timestamp).toLocaleString(),
        ...findingTypes.map((type) => String(e.findingTypeCounts?.[type] ?? 0)),
      ]),
      styles: { fontSize: 7, cellPadding: 1.5 },
      headStyles: { fillColor: [41, 128, 185] },
    });
  }

  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, pageHeight - 10);
  doc.text(sanitizePdfText("KYUTXO — generated offline"), pageWidth - 14, pageHeight - 10, { align: "right" });

  return doc.output("blob");
}
