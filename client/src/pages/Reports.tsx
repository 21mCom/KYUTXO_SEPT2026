import { useState, useCallback, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, GitBranch, Search, Shield, Eye, Loader2, Download, Printer, ChevronRight, Copy } from "lucide-react";
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
import { renderSourceNote } from "@/lib/renderSourceNote";
import { buildPrivacyReport, buildPrivacyTextReport } from "@/lib/privacy-report-export";
import { buildPrintableReport, severityLabel } from "@/lib/privacy-report-html";
import { getRecordsPageByTypeIdReverseKeyset } from "@/lib/data/record-crud";

// ─── Privacy Audit Report ────────────────────────────────────────────────────

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
  const waterfallRef = useRef<HTMLDivElement | null>(null);

  const focusFindingsByType = useCallback((findingType: PrivacyFinding["type"]) => {
    setHighlightedType(findingType);
    requestAnimationFrame(() => {
      const el = findingsRef.current?.querySelector<HTMLElement>(`[data-finding-type="${findingType}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  const focusWaterfallByType = useCallback((findingType: PrivacyFinding["type"]) => {
    setHighlightedType(findingType);
    requestAnimationFrame(() => {
      const el = waterfallRef.current?.querySelector<HTMLElement>(`[data-waterfall-type="${findingType}"]`);
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

  const buildText = useCallback(() => {
    if (!result) return null;
    return buildPrivacyTextReport(result, {
      owner: selectedOwner === "all" ? null : selectedOwner,
      wallet: selectedWallet === "all" ? null : selectedWallet,
    });
  }, [result, selectedOwner, selectedWallet]);

  const exportText = useCallback(() => {
    const text = buildText();
    if (text == null) return;

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `privacy-audit-report-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildText]);

  const copyText = useCallback(async () => {
    const text = buildText();
    if (text == null) return;

    if (!navigator.clipboard?.writeText) {
      toast({
        variant: "destructive",
        title: "Clipboard Unavailable",
        description: "Copying isn't supported here. Use Export Text to save the report instead.",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: "Copied to Clipboard",
        description: "The Privacy Audit report is ready to paste.",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Copy Failed",
        description: "Couldn't access the clipboard. Use Export Text to save the report instead.",
      });
    }
  }, [buildText, toast]);

  const exportPdf = useCallback(() => {
    if (!result) return;
    const scope = {
      owner: selectedOwner === "all" ? null : selectedOwner,
      wallet: selectedWallet === "all" ? null : selectedWallet,
    };
    const html = buildPrintableReport(result, scope);
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

    // Wire the in-window "Copy" control from here (the app context) rather than
    // an inline script, which the production CSP (script-src 'self') would block
    // in the document.write'd window. The report text is the same plain-text
    // export used elsewhere, so the formats stay in sync.
    const reportText = buildPrivacyTextReport(result, scope);
    const btn = win.document.getElementById("copy-report-btn");
    const statusEl = win.document.getElementById("copy-report-status");
    const setStatus = (msg: string, ok: boolean) => {
      if (!statusEl) return;
      statusEl.textContent = msg;
      (statusEl as HTMLElement).style.color = ok ? "#16a34a" : "#dc2626";
    };
    btn?.addEventListener("click", async () => {
      try {
        if (win.navigator.clipboard?.writeText) {
          await win.navigator.clipboard.writeText(reportText);
          setStatus("Copied to clipboard.", true);
          return;
        }
      } catch {
        // Fall through to the execCommand fallback below.
      }
      try {
        const ta = win.document.createElement("textarea");
        ta.value = reportText;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        win.document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = win.document.execCommand("copy");
        win.document.body.removeChild(ta);
        setStatus(
          ok ? "Copied to clipboard." : "Copy unavailable — select the text and press Ctrl/Cmd+C.",
          ok,
        );
      } catch {
        setStatus("Copy unavailable — select the text and press Ctrl/Cmd+C.", false);
      }
    });

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
            <Button variant="outline" onClick={copyText} data-testid="button-copy-privacy-report-text">
              <Copy className="mr-2 h-4 w-4" />Copy
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
                <div ref={waterfallRef} className="rounded-md border overflow-hidden">
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
                            data-waterfall-type={isBase ? undefined : entry.findingType}
                            onClick={hasFindings ? () => focusFindingsByType(entry.findingType as PrivacyFinding["type"]) : undefined}
                            role={hasFindings ? "button" : undefined}
                            tabIndex={hasFindings ? 0 : undefined}
                            onKeyDown={hasFindings ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                focusFindingsByType(entry.findingType as PrivacyFinding["type"]);
                              }
                            } : undefined}
                            className={`scroll-mt-4 ${hasFindings ? "cursor-pointer hover-elevate" : ""} ${isHighlighted ? "bg-muted" : ""}`}
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
                {[...result.findings, ...result.warnings].map((f, i) => {
                  const impact = f.scoreDelta != null ? Math.round(f.scoreDelta) : 0;
                  const hasImpact = impact !== 0;
                  return (
                    <div
                      key={i}
                      data-finding-type={f.type}
                      onClick={() => focusWaterfallByType(f.type)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          focusWaterfallByType(f.type);
                        }
                      }}
                      className={`p-3 flex flex-wrap gap-2 items-start scroll-mt-4 transition-colors cursor-pointer hover-elevate ${
                        highlightedType === f.type ? "bg-muted" : ""
                      }`}
                      data-testid={`row-privacy-finding-${i}`}
                    >
                      <Badge className={`shrink-0 ${severityBadgeClass(f.severity)}`}>{severityLabel(f.severity)}</Badge>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{FINDING_TYPE_LABELS[f.type] ?? f.type}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{renderSourceNote(f.description)}</div>
                        {f.correction && (
                          <div className="text-xs text-muted-foreground mt-0.5 italic">Fix: {renderSourceNote(f.correction)}</div>
                        )}
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {f.addresses.length > 0 && <span>{f.addresses.length} address(es)</span>}
                          {f.txids.length > 0 && <span className="ml-2">{f.txids.length} tx(s)</span>}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-1 self-center" data-testid={`text-privacy-finding-impact-${i}`}>
                        <span
                          className={`text-xs tabular-nums font-medium ${
                            hasImpact ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
                          }`}
                          title="Score impact — click to view in Score Breakdown"
                        >
                          {hasImpact ? `${impact} pts` : "0 pts"}
                        </span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      </div>
                    </div>
                  );
                })}
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
