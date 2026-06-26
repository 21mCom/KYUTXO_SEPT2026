import {
  FINDING_TYPE_LABELS,
  type PrivacyAuditResult,
  type PrivacyFinding,
  type PrivacySeverity,
  type EntityCitation,
} from "@/lib/privacy-audit";
import { formatScoreDelta, type ExportScope } from "@/lib/privacy-report-export";

export function severityLabel(s: PrivacySeverity): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/** Escape user-controlled strings before interpolating into report HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const PRINT_SEVERITY_COLORS: Record<PrivacySeverity, string> = {
  CRITICAL: "#dc2626",
  HIGH: "#f97316",
  MEDIUM: "#eab308",
  LOW: "#3b82f6",
};

/**
 * Assemble the full printable Privacy Audit report as a standalone HTML
 * document string. This is the single source of truth for the print/HTML
 * report shape — used both by the UI print action and by tests, so the two
 * cannot drift. All user-controlled values (owner/wallet names, finding text,
 * citations) are escaped via {@link escapeHtml}; citation URLs in `sourceNote`
 * remain plain text and are never fetched (offline-first).
 *
 * `now` is injectable so tests can assert deterministically.
 */
export function buildPrintableReport(
  result: PrivacyAuditResult,
  scope: ExportScope,
  now: Date = new Date(),
): string {
  const generatedAt = now.toLocaleString();
  const allFindings = [...result.findings, ...result.warnings];

  const severityCounts = (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as PrivacySeverity[])
    .map(sev => ({ sev, count: allFindings.filter(f => f.severity === sev).length }))
    .filter(x => x.count > 0);

  const renderCitations = (f: PrivacyFinding): string => {
    if (!f.type.startsWith("ENTITY_")) return "";
    const citations = (f.details as { citations?: EntityCitation[] }).citations;
    if (!citations || citations.length === 0) return "";
    const rows = citations.map(c => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.categoryLabel)}</td>
        <td class="mono">${escapeHtml(c.address)}</td>
        <td>${c.sourceNote ? escapeHtml(c.sourceNote) : "—"}</td>
      </tr>`).join("");
    return `
      <div class="citations">
        <div class="citations-title">Source Citations</div>
        <table class="citations-table">
          <thead>
            <tr><th>Entity</th><th>Category</th><th>Address</th><th>Source</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  };

  const renderFinding = (f: PrivacyFinding): string => {
    const label = (FINDING_TYPE_LABELS as Record<string, string>)[f.type] ?? f.type;
    const sevColor = PRINT_SEVERITY_COLORS[f.severity];
    const scoreImpact = formatScoreDelta(f.scoreDelta);
    return `
      <div class="finding">
        <div class="finding-head">
          <span class="sev-badge" style="background:${sevColor}">${escapeHtml(severityLabel(f.severity))}</span>
          <span class="finding-title">${escapeHtml(label)}</span>
          ${scoreImpact ? `<span class="finding-score">${escapeHtml(scoreImpact)}</span>` : ""}
        </div>
        <div class="finding-desc">${escapeHtml(f.description)}</div>
        ${f.correction ? `<div class="finding-fix"><strong>Fix:</strong> ${escapeHtml(f.correction)}</div>` : ""}
        <div class="finding-meta">
          ${f.addresses.length > 0 ? `${f.addresses.length} address(es)` : ""}
          ${f.txids.length > 0 ? `&nbsp;&nbsp;${f.txids.length} transaction(s)` : ""}
        </div>
        ${renderCitations(f)}
      </div>`;
  };

  const findingsHtml = allFindings.length > 0
    ? allFindings.map(renderFinding).join("")
    : `<p class="clean">No privacy findings — your transaction history is clean.</p>`;

  const scopeText = [
    scope.owner ? `Owner: ${escapeHtml(scope.owner)}` : "Owner: All",
    scope.wallet ? `Wallet: ${escapeHtml(scope.wallet)}` : "Wallet: All",
  ].join(" · ");

  const waterfallHtml = result.scoreWaterfall.length > 0
    ? `
  <h2>Score Breakdown</h2>
  <table class="waterfall-table">
    <thead>
      <tr><th>Category</th><th class="num">Count</th><th class="num">Delta</th><th class="num">Score</th></tr>
    </thead>
    <tbody>
      ${result.scoreWaterfall.map(entry => `
      <tr>
        <td>${escapeHtml(entry.label)}</td>
        <td class="num">${entry.count > 0 ? entry.count.toLocaleString() : "—"}</td>
        <td class="num ${entry.delta < 0 ? "delta-neg" : entry.delta > 0 ? "delta-pos" : ""}">${entry.delta === 0 ? "—" : (entry.delta > 0 ? "+" : "") + entry.delta}</td>
        <td class="num">${entry.runningScore}</td>
      </tr>`).join("")}
    </tbody>
  </table>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Privacy Audit Report — ${escapeHtml(now.toISOString().slice(0, 10))}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 32px; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #555; font-size: 13px; margin: 0 0 2px; }
  .scope { color: #555; font-size: 12px; margin: 0 0 24px; }
  .summary { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 20px; }
  .summary-box { border: 1px solid #ddd; border-radius: 6px; padding: 12px 16px; min-width: 110px; text-align: center; }
  .summary-box .value { font-size: 24px; font-weight: 700; }
  .summary-box .label { font-size: 11px; color: #666; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.03em; }
  .sev-summary { margin-bottom: 24px; font-size: 13px; }
  .sev-chip { display: inline-block; color: #fff; border-radius: 4px; padding: 2px 8px; font-size: 12px; font-weight: 600; margin-right: 6px; }
  h2 { font-size: 15px; border-bottom: 1px solid #ddd; padding-bottom: 6px; margin: 24px 0 12px; }
  .finding { border: 1px solid #e2e2e2; border-radius: 6px; padding: 12px 14px; margin-bottom: 10px; page-break-inside: avoid; }
  .finding-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .sev-badge { color: #fff; border-radius: 4px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
  .finding-title { font-weight: 600; font-size: 14px; }
  .finding-score { margin-left: auto; font-size: 11px; font-weight: 600; color: #dc2626; font-family: "JetBrains Mono", "Courier New", monospace; white-space: nowrap; }
  .finding-desc { font-size: 13px; color: #333; }
  .finding-fix { font-size: 12px; color: #444; font-style: italic; margin-top: 4px; }
  .finding-meta { font-size: 11px; color: #777; margin-top: 4px; }
  .citations { margin-top: 10px; }
  .citations-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #555; margin-bottom: 4px; }
  .citations-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .citations-table th { text-align: left; background: #f5f5f5; padding: 4px 6px; border: 1px solid #e2e2e2; }
  .citations-table td { padding: 4px 6px; border: 1px solid #e2e2e2; vertical-align: top; word-break: break-word; }
  .waterfall-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 24px; page-break-inside: avoid; }
  .waterfall-table th { text-align: left; background: #f5f5f5; padding: 6px 8px; border: 1px solid #e2e2e2; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: #555; }
  .waterfall-table td { padding: 6px 8px; border: 1px solid #e2e2e2; }
  .waterfall-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .waterfall-table .delta-neg { color: #dc2626; }
  .waterfall-table .delta-pos { color: #16a34a; }
  .mono { font-family: "JetBrains Mono", "Courier New", monospace; }
  .clean { color: #16a34a; font-size: 14px; }
  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 11px; color: #777; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 24px; }
  .copy-btn { font: inherit; font-size: 13px; line-height: 1.2; padding: 7px 14px; border: 1px solid #ccc; border-radius: 6px; background: #f5f5f5; color: #1a1a1a; cursor: pointer; }
  .copy-btn:hover { background: #ececec; }
  .copy-status { font-size: 12px; color: #16a34a; }
  @media print { body { padding: 0; } .no-print { display: none !important; } }
</style>
</head>
<body>
  <h1>Privacy Audit Report</h1>
  <p class="subtitle">Generated ${escapeHtml(generatedAt)} · All analysis ran fully offline.</p>
  <p class="scope">${scopeText}</p>

  <div class="toolbar no-print">
    <button type="button" id="copy-report-btn" class="copy-btn">Copy report text</button>
    <span id="copy-report-status" class="copy-status" role="status" aria-live="polite"></span>
  </div>

  <div class="summary">
    <div class="summary-box"><div class="value">${escapeHtml(result.grade)}</div><div class="label">Grade</div></div>
    <div class="summary-box"><div class="value">${result.score}/100</div><div class="label">Score</div></div>
    <div class="summary-box"><div class="value">${result.transactionsAnalyzed.toLocaleString()}</div><div class="label">Txs Analyzed</div></div>
    <div class="summary-box"><div class="value">${result.addressesScanned.toLocaleString()}</div><div class="label">Addresses</div></div>
  </div>

  <div class="sev-summary">
    ${severityCounts.length > 0
      ? `<strong>Issues:</strong> ${severityCounts.map(x => `<span class="sev-chip" style="background:${PRINT_SEVERITY_COLORS[x.sev]}">${x.count} ${escapeHtml(severityLabel(x.sev))}</span>`).join("")}`
      : `<span class="sev-chip" style="background:#16a34a">Clean</span>`}
    ${result.needsResync ? `<div style="margin-top:6px;color:#b45309;">Fingerprint data ${Math.round(result.fingerprintCoverage * 100)}% — re-sync recommended for complete results.</div>` : ""}
  </div>
  ${waterfallHtml}
  <h2>Findings &amp; Warnings (${allFindings.length})</h2>
  ${findingsHtml}

  <div class="footer">
    KYUTXO Privacy Audit · Offline-first compliance artifact. Citation URLs are shown as plain text and are never fetched.
  </div>
</body>
</html>`;
}
