import { useState, useCallback, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, GitBranch, Search, Shield, Eye, Loader2, Download, Printer, ChevronRight } from "lucide-react";
import { SourceOfFundsReport } from "@/components/reports/SourceOfFundsReport";
import { HopPointReport } from "@/components/reports/HopPointReport";
import { ContinuityCertificateReport } from "@/components/reports/ContinuityCertificateReport";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useToast } from "@/hooks/use-toast";
import {
  runPrivacyAudit,
  FINDING_TYPE_LABELS,
  type PrivacyAuditResult,
  type PrivacyFinding,
  type PrivacySeverity,
  type EntityCitation,
} from "@/lib/privacy-audit";
import { buildPrivacyReport } from "@/lib/privacy-report-export";
import { getRecordsPageByTypeIdReverseKeyset } from "@/lib/data/record-crud";

// ─── Privacy Audit Report ────────────────────────────────────────────────────

function severityLabel(s: PrivacySeverity): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function severityBadgeClass(s: PrivacySeverity): string {
  switch (s) {
    case "CRITICAL": return "bg-red-600 text-white no-default-hover-elevate no-default-active-elevate";
    case "HIGH":     return "bg-orange-500 text-white no-default-hover-elevate no-default-active-elevate";
    case "MEDIUM":   return "bg-yellow-500 text-black no-default-hover-elevate no-default-active-elevate";
    case "LOW":      return "bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate";
    default:         return "";
  }
}

function gradeColor(grade: string): string {
  if (grade.startsWith("A")) return "text-green-600 dark:text-green-400";
  if (grade.startsWith("B")) return "text-blue-600 dark:text-blue-400";
  if (grade.startsWith("C")) return "text-yellow-600 dark:text-yellow-400";
  if (grade.startsWith("D")) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRINT_SEVERITY_COLORS: Record<PrivacySeverity, string> = {
  CRITICAL: "#dc2626",
  HIGH: "#f97316",
  MEDIUM: "#eab308",
  LOW: "#3b82f6",
};

function buildPrintableReport(
  result: PrivacyAuditResult,
  scope: { owner: string | null; wallet: string | null },
): string {
  const generatedAt = new Date().toLocaleString();
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
    return `
      <div class="finding">
        <div class="finding-head">
          <span class="sev-badge" style="background:${sevColor}">${escapeHtml(severityLabel(f.severity))}</span>
          <span class="finding-title">${escapeHtml(label)}</span>
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
<title>Privacy Audit Report — ${escapeHtml(new Date().toISOString().slice(0, 10))}</title>
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
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>Privacy Audit Report</h1>
  <p class="subtitle">Generated ${escapeHtml(generatedAt)} · All analysis ran fully offline.</p>
  <p class="scope">${scopeText}</p>

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

function PrivacyAuditReportPanel() {
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { toast } = useToast();

  const [selectedOwner, setSelectedOwner] = useState("all");
  const [selectedWallet, setSelectedWallet] = useState("all");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PrivacyAuditResult | null>(null);
  const [highlightedType, setHighlightedType] = useState<PrivacyFinding["type"] | null>(null);
  const findingsRef = useRef<HTMLDivElement | null>(null);

  const focusFindingsByType = useCallback((findingType: PrivacyFinding["type"]) => {
    setHighlightedType(findingType);
    requestAnimationFrame(() => {
      const el = findingsRef.current?.querySelector<HTMLElement>(`[data-finding-type="${findingType}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  const generate = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setHighlightedType(null);
    try {
      const allAddresses: string[] = [];
      let beforeId: number | undefined;
      while (true) {
        const page = await getRecordsPageByTypeIdReverseKeyset("address", { limit: 500, beforeIdExclusive: beforeId });
        if (page.length === 0) break;
        for (const r of page) {
          if (!r.inputString) continue;
          if (selectedOwner !== "all" && r.owner !== selectedOwner) continue;
          if (selectedWallet !== "all" && r.walletName !== selectedWallet) continue;
          allAddresses.push(r.inputString);
        }
        if (page.length < 500) break;
        beforeId = page[page.length - 1].id;
      }

      if (allAddresses.length === 0) {
        toast({ title: "No Addresses", description: "No address records match the selected filters." });
        setRunning(false);
        return;
      }

      const audit = await runPrivacyAudit(allAddresses);
      setResult(audit);
    } catch (err) {
      toast({ variant: "destructive", title: "Report Failed", description: err instanceof Error ? err.message : "Unknown error." });
    } finally {
      setRunning(false);
    }
  }, [selectedOwner, selectedWallet, toast]);

  const exportJson = useCallback(() => {
    if (!result) return;
    // Per-entity source citations are surfaced as a clean top-level field on
    // ENTITY_* findings via mapFinding (see lib/privacy-report-export). URLs in
    // sourceNote remain plain text — never fetched (offline-first).
    // buildPrivacyReport is the single source of truth for the export shape so
    // the UI and its regression tests cannot drift.
    const report = buildPrivacyReport(result, {
      owner: selectedOwner === "all" ? null : selectedOwner,
      wallet: selectedWallet === "all" ? null : selectedWallet,
    });
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `privacy-audit-report-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result, selectedOwner, selectedWallet]);

  const exportText = useCallback(() => {
    if (!result) return;
    const lines: string[] = [];
    const sep = "=".repeat(60);
    const sub = "-".repeat(60);

    lines.push(sep);
    lines.push("PRIVACY AUDIT REPORT");
    lines.push(sep);
    lines.push(`Generated: ${new Date().toLocaleString()}`);
    lines.push("All analysis ran fully offline.");
    lines.push(`Owner: ${selectedOwner === "all" ? "All" : selectedOwner}`);
    lines.push(`Wallet: ${selectedWallet === "all" ? "All" : selectedWallet}`);
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
        const meta: string[] = [];
        if (f.addresses.length > 0) meta.push(`${f.addresses.length} address(es)`);
        if (f.txids.length > 0) meta.push(`${f.txids.length} transaction(s)`);
        if (meta.length > 0) lines.push(`   ${meta.join("  ·  ")}`);
        if (f.type.startsWith("ENTITY_")) {
          const citations = (f.details as { citations?: EntityCitation[] }).citations;
          if (citations && citations.length > 0) {
            lines.push("   Source Citations:");
            for (const c of citations) {
              lines.push(`     - ${c.name} (${c.categoryLabel})`);
              lines.push(`       Address: ${c.address}`);
              if (c.sourceNote) lines.push(`       Source: ${c.sourceNote}`);
            }
          }
        }
        lines.push("");
      });
    }

    lines.push(sep);
    lines.push("KYUTXO Privacy Audit · Offline-first compliance artifact.");
    lines.push("Citation URLs are shown as plain text and are never fetched.");
    lines.push(sep);

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `privacy-audit-report-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result, selectedOwner, selectedWallet]);

  const exportPdf = useCallback(() => {
    if (!result) return;
    const html = buildPrintableReport(result, {
      owner: selectedOwner === "all" ? null : selectedOwner,
      wallet: selectedWallet === "all" ? null : selectedWallet,
    });
    const win = window.open("", "_blank");
    if (!win) {
      toast({
        variant: "destructive",
        title: "Could Not Open Print View",
        description: "Allow pop-ups for this app to print or save the report as PDF.",
      });
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    // Wait for layout before invoking the print dialog so users can Save as PDF.
    win.focus();
    setTimeout(() => {
      try { win.print(); } catch { /* user can print manually */ }
    }, 250);
  }, [result, selectedOwner, selectedWallet, toast]);

  const countBySeverity = (sev: PrivacySeverity) =>
    [...(result?.findings ?? []), ...(result?.warnings ?? [])].filter(f => f.severity === sev).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1 min-w-[160px]">
          <label className="text-xs text-muted-foreground">Owner</label>
          <Select value={selectedOwner} onValueChange={setSelectedOwner}>
            <SelectTrigger data-testid="select-privacy-report-owner">
              <SelectValue placeholder="All Owners" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Owners</SelectItem>
              {owners.map(o => <SelectItem key={o.name} value={o.name}>{o.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-[160px]">
          <label className="text-xs text-muted-foreground">Wallet</label>
          <Select value={selectedWallet} onValueChange={setSelectedWallet}>
            <SelectTrigger data-testid="select-privacy-report-wallet">
              <SelectValue placeholder="All Wallets" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Wallets</SelectItem>
              {walletNames.map(w => <SelectItem key={w.name} value={w.name}>{w.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={generate} disabled={running} data-testid="button-generate-privacy-report">
          {running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Analyzing…</> : <><Eye className="mr-2 h-4 w-4" />Generate Report</>}
        </Button>
        {result && (
          <>
            <Button variant="outline" onClick={exportPdf} data-testid="button-print-privacy-report">
              <Printer className="mr-2 h-4 w-4" />Print / PDF
            </Button>
            <Button variant="outline" onClick={exportText} data-testid="button-export-privacy-report-text">
              <FileText className="mr-2 h-4 w-4" />Export Text
            </Button>
            <Button variant="outline" onClick={exportJson} data-testid="button-export-privacy-report">
              <Download className="mr-2 h-4 w-4" />Export JSON
            </Button>
          </>
        )}
      </div>

      {result && (
        <div className="space-y-4">
          {/* Score summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="container-privacy-report-summary">
            <div className="rounded-md border p-3 text-center">
              <div className={`text-3xl font-bold ${gradeColor(result.grade)}`} data-testid="text-privacy-report-grade">{result.grade}</div>
              <div className="text-xs text-muted-foreground mt-1">Privacy Grade</div>
            </div>
            <div className="rounded-md border p-3 text-center">
              <div className="text-3xl font-bold" data-testid="text-privacy-report-score">{result.score}<span className="text-base text-muted-foreground">/100</span></div>
              <div className="text-xs text-muted-foreground mt-1">Privacy Score</div>
            </div>
            <div className="rounded-md border p-3 text-center">
              <div className="text-2xl font-bold" data-testid="text-privacy-report-txs">{result.transactionsAnalyzed.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1">Txs Analyzed</div>
            </div>
            <div className="rounded-md border p-3 text-center">
              <div className="text-2xl font-bold" data-testid="text-privacy-report-addrs">{result.addressesScanned.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1">Addresses</div>
            </div>
          </div>

          {/* Severity breakdown */}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-sm text-muted-foreground">Issues:</span>
            {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as PrivacySeverity[]).map(sev => {
              const count = countBySeverity(sev);
              if (count === 0) return null;
              return <Badge key={sev} className={severityBadgeClass(sev)}>{count} {severityLabel(sev)}</Badge>;
            })}
            {result.isClean && <Badge className="bg-green-500 text-white no-default-hover-elevate no-default-active-elevate">Clean</Badge>}
            {result.needsResync && (
              <Badge variant="outline" className="text-amber-600 border-amber-500 no-default-hover-elevate no-default-active-elevate">
                Fingerprint data {Math.round(result.fingerprintCoverage * 100)}% — re-sync recommended
              </Badge>
            )}
          </div>

          {/* Score breakdown waterfall */}
          {result.scoreWaterfall.length > 0 && (
            <Card data-testid="card-privacy-report-waterfall">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Score Breakdown</CardTitle>
                <CardDescription>How each finding category adjusted the score from the base of 100.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="text-left font-medium p-2">Category</th>
                        <th className="text-right font-medium p-2">Count</th>
                        <th className="text-right font-medium p-2">Delta</th>
                        <th className="text-right font-medium p-2">Score</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {result.scoreWaterfall.map((entry, i) => {
                        const isBase = entry.findingType === "BASE";
                        const hasFindings = !isBase && entry.count > 0;
                        const isHighlighted = !isBase && highlightedType === entry.findingType;
                        return (
                          <tr
                            key={i}
                            data-testid={`row-privacy-waterfall-${i}`}
                            onClick={hasFindings ? () => focusFindingsByType(entry.findingType as PrivacyFinding["type"]) : undefined}
                            role={hasFindings ? "button" : undefined}
                            tabIndex={hasFindings ? 0 : undefined}
                            onKeyDown={hasFindings ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                focusFindingsByType(entry.findingType as PrivacyFinding["type"]);
                              }
                            } : undefined}
                            className={`${hasFindings ? "cursor-pointer hover-elevate" : ""} ${isHighlighted ? "bg-muted" : ""}`}
                          >
                            <td className="p-2">
                              <span>{entry.label}</span>
                              {hasFindings && (
                                <ChevronRight className="inline-block ml-1 h-3 w-3 text-muted-foreground align-middle" />
                              )}
                            </td>
                            <td className="p-2 text-right tabular-nums text-muted-foreground">
                              {entry.count > 0 ? entry.count.toLocaleString() : "—"}
                            </td>
                            <td className={`p-2 text-right tabular-nums font-medium ${
                              entry.delta < 0 ? "text-red-600 dark:text-red-400"
                              : entry.delta > 0 ? "text-green-600 dark:text-green-400"
                              : "text-muted-foreground"
                            }`}>
                              {entry.delta === 0 ? "—" : `${entry.delta > 0 ? "+" : ""}${entry.delta}`}
                            </td>
                            <td className="p-2 text-right tabular-nums font-medium">{entry.runningScore}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Findings table */}
          {(result.findings.length + result.warnings.length) > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Findings &amp; Warnings</h3>
              <div ref={findingsRef} className="rounded-md border divide-y divide-border text-sm" data-testid="container-privacy-report-findings">
                {[...result.findings, ...result.warnings].map((f, i) => (
                  <div
                    key={i}
                    data-finding-type={f.type}
                    className={`p-3 flex flex-wrap gap-2 items-start scroll-mt-4 transition-colors ${
                      highlightedType === f.type ? "bg-muted" : ""
                    }`}
                    data-testid={`row-privacy-finding-${i}`}
                  >
                    <Badge className={`shrink-0 ${severityBadgeClass(f.severity)}`}>{severityLabel(f.severity)}</Badge>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{FINDING_TYPE_LABELS[f.type] ?? f.type}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{f.description}</div>
                      {f.correction && (
                        <div className="text-xs text-muted-foreground mt-0.5 italic">Fix: {f.correction}</div>
                      )}
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {f.addresses.length > 0 && <span>{f.addresses.length} address(es)</span>}
                        {f.txids.length > 0 && <span className="ml-2">{f.txids.length} tx(s)</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="text-privacy-report-clean">No privacy findings — your transaction history is clean.</p>
          )}

          <p className="text-xs text-muted-foreground">
            Report generated {new Date().toLocaleString()}. All analysis runs fully offline.
            Use "Print / PDF" for a readable compliance artifact, "Export Text" for a copy-pasteable plain-text version, or "Export JSON" for a machine-readable copy.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Reports page ─────────────────────────────────────────────────────────────

export default function Reports() {
  const [activeTab, setActiveTab] = useState("source-of-funds");

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-reports-title">Reports</h1>
          <p className="text-muted-foreground">
            Generate compliance and analysis reports from your Bitcoin data
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-4 max-w-2xl">
            <TabsTrigger value="source-of-funds" className="flex items-center gap-2" data-testid="tab-source-of-funds">
              <FileText className="h-4 w-4" />
              Source of Funds
            </TabsTrigger>
            <TabsTrigger value="hop-points" className="flex items-center gap-2" data-testid="tab-hop-points">
              <GitBranch className="h-4 w-4" />
              Hop Points
            </TabsTrigger>
            <TabsTrigger value="continuity" className="flex items-center gap-2" data-testid="tab-continuity">
              <Shield className="h-4 w-4" />
              Continuity
            </TabsTrigger>
            <TabsTrigger value="privacy" className="flex items-center gap-2" data-testid="tab-privacy-report">
              <Eye className="h-4 w-4" />
              Privacy
            </TabsTrigger>
          </TabsList>

          <TabsContent value="source-of-funds" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Source of Funds Declaration
                </CardTitle>
                <CardDescription>
                  Prove acquisition cost and current value for addresses. Internal transfers between your own wallets are flagged as non-taxable events.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SourceOfFundsReport />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="hop-points" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Search className="h-5 w-5" />
                  Hop Point Detection
                </CardTitle>
                <CardDescription>
                  Identify unclassified addresses that act as intermediaries between your known addresses. These may represent consolidation transactions, change addresses, or unknown third parties.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HopPointReport />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="continuity" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5" />
                  Continuity Certificates
                </CardTitle>
                <CardDescription>
                  Generate proof-of-ownership certificates showing continuous custody of your Bitcoin through address changes and transactions. Export evidence bundles for compliance or audits.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ContinuityCertificateReport />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="privacy" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Eye className="h-5 w-5" />
                  Privacy Audit Report
                </CardTitle>
                <CardDescription>
                  Generate a privacy score and detailed findings report from on-chain heuristics, entity detection, wallet fingerprinting, and Boltzmann linkability analysis.
                  All analysis runs fully offline. Export findings as JSON for record-keeping or compliance purposes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PrivacyAuditReportPanel />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
