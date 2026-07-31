import { useState, useCallback, useMemo } from "react";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Search,
  Loader2,
  ChevronDown,
  Copy,
  Check,
  Download,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { beginBulkOperation, endBulkOperation } from "@/lib/database";
import { createTag } from "@/lib/data/vocabulary-crud";
import { updateRecord, getRecordsByType } from "@/lib/data/record-crud";
import { getInputParticipants } from "@/lib/data/transaction-crud";
import { useTags } from "@/hooks/use-tags";
import { useToast } from "@/hooks/use-toast";
import { useSettings, toggleQuantumTagLevel } from "@/hooks/use-settings";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { csvField } from "@/lib/csv-export";
import { QUANTUM_RISK_LEVEL_LABELS, type QuantumRiskLevel } from "@/lib/quantum-risk";

type ScanState = "idle" | "analyzing" | "tagging" | "complete";

type RiskLevel = QuantumRiskLevel;

export interface QuantumScanResult {
  recordId: number;
  address: string;
  // Detected script type ("p2pk", "p2tr", ... or "unknown") — shown on each
  // result row and exported in the findings CSV.
  scriptType: string;
  riskLevel: RiskLevel;
  // Non-quantum tags the record carried at scan time (quantum:* tags are
  // managed by the scan itself and never listed here).
  otherTags: string[];
  // The quantum:* tag this scan applied (or confirmed) on the record, or null
  // when the record's risk level was not selected for tagging — such records
  // end the scan with NO quantum tag at all.
  appliedTag: string | null;
}

const RISK_LEVELS: { key: RiskLevel; label: string; tagName: string; color: string; icon: typeof Shield }[] = [
  { key: "critical", label: QUANTUM_RISK_LEVEL_LABELS.critical, tagName: "quantum:critical", color: "#ef4444", icon: ShieldAlert },
  { key: "high", label: QUANTUM_RISK_LEVEL_LABELS.high, tagName: "quantum:high", color: "#f97316", icon: AlertTriangle },
  { key: "medium", label: QUANTUM_RISK_LEVEL_LABELS.medium, tagName: "quantum:medium", color: "#eab308", icon: Shield },
  { key: "variable", label: QUANTUM_RISK_LEVEL_LABELS.variable, tagName: "quantum:variable", color: "#3b82f6", icon: Search },
  { key: "low", label: QUANTUM_RISK_LEVEL_LABELS.low, tagName: "quantum:low", color: "#22c55e", icon: ShieldCheck },
];

const QUANTUM_TAG_NAMES = new Set(RISK_LEVELS.map(r => r.tagName));

function detectAddressType(address: string): string {
  if (!address) return "unknown";
  if (/^[0-9a-fA-F]+$/.test(address) && (address.length === 66 || address.length === 130)) return "p2pk";
  if (address.startsWith("bc1p")) return "p2tr";
  if (address.startsWith("bc1q")) return "p2wpkh";
  if (address.startsWith("3")) return "p2sh";
  if (address.startsWith("1")) return "p2pkh";
  return "unknown";
}

function classifyRisk(addressType: string, hasSpent: boolean): RiskLevel {
  if (addressType === "p2pk") return "critical";
  if (addressType === "p2tr") return "high";
  if (addressType === "p2pkh" || addressType === "p2wpkh") {
    return hasSpent ? "high" : "medium";
  }
  if (addressType === "p2sh") return "variable";
  return "low";
}

function getRiskBadgeProps(level: RiskLevel): { variant?: "destructive" | "default" | "secondary" | "outline"; className?: string } {
  switch (level) {
    case "critical":
      return { variant: "destructive" };
    case "high":
      return { className: "bg-orange-500 text-white no-default-hover-elevate no-default-active-elevate" };
    case "medium":
      return { className: "bg-yellow-500 text-black no-default-hover-elevate no-default-active-elevate" };
    case "variable":
      return { className: "bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate" };
    case "low":
      return { className: "bg-green-500 text-white no-default-hover-elevate no-default-active-elevate" };
    default:
      return { variant: "secondary" };
  }
}

export const QUANTUM_FINDINGS_CSV_HEADER = [
  "Address",
  "Script Type",
  "Risk Level",
  "Applied Quantum Tag",
  "Other Tags",
] as const;

// Serialize the (already filtered) findings to CSV. Every cell goes through
// csvField, which apostrophe-prefixes formula sigils (= + - @, even after
// leading whitespace) BEFORE RFC 4180 quoting, so hostile addresses or tag
// names can never execute as spreadsheet formulas.
export function buildQuantumFindingsCsv(rows: QuantumScanResult[]): string {
  const lines: string[] = [QUANTUM_FINDINGS_CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.address),
        csvField(row.scriptType),
        csvField(QUANTUM_RISK_LEVEL_LABELS[row.riskLevel]),
        csvField(row.appliedTag ?? ""),
        csvField(row.otherTags.join("; ")),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export default function QuantumRiskScanner() {
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [results, setResults] = useState<QuantumScanResult[]>([]);
  const [taggingProgress, setTaggingProgress] = useState({ current: 0, total: 0 });
  // Whether the LAST completed scan ran its tagging phase (false = analysis
  // only because no risk levels were selected when the scan started).
  const [lastScanTagged, setLastScanTagged] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [levelFilters, setLevelFilters] = useState<RiskLevel[]>([]);
  const [openGroups, setOpenGroups] = useState<Record<RiskLevel, boolean>>({
    critical: true,
    high: true,
    medium: true,
    variable: true,
    low: true,
  });
  const { tags } = useTags();
  const { toast } = useToast();
  const { quantumTagLevels, isLoading: settingsLoading } = useSettings();
  const { copy, isCopied } = useCopyToClipboard();

  const isScanning = scanState === "analyzing" || scanState === "tagging";

  const handleLevelToggle = useCallback(
    async (level: RiskLevel, checked: boolean) => {
      try {
        await toggleQuantumTagLevel(level, checked);
      } catch (error) {
        console.error("Failed to save quantum tag-level selection:", error);
        toast({
          variant: "destructive",
          title: "Preference Not Saved",
          description: error instanceof Error ? error.message : "Could not save the tag selection.",
        });
      }
    },
    [toast],
  );

  const runScan = useCallback(async () => {
    // Capture the selection at scan start so mid-scan toggle changes only
    // affect the NEXT run.
    const selectedLevels = new Set<RiskLevel>(quantumTagLevels);

    try {
      setResults([]);
      setFilterText("");
      setLevelFilters([]);
      setScanState("analyzing");

      const allRecords = await getRecordsByType('address');

      if (allRecords.length === 0) {
        toast({
          title: "No Records",
          description: "No address records found to scan.",
        });
        setScanState("idle");
        return;
      }

      const inputParticipants = await getInputParticipants();
      const spentRecordIds = new Set(
        inputParticipants
          .filter(p => p.recordId != null)
          .map(p => p.recordId!)
      );

      const scanResults: QuantumScanResult[] = [];
      // Records whose tag set actually changes under the current selection.
      // Only these are written — a re-scan over an already-tagged vault is a
      // pure read.
      const pendingWrites: { recordId: number; tags: string[] }[] = [];

      for (const record of allRecords) {
        if (!record.id) continue;
        const address = record.inputString;
        const scriptType = detectAddressType(address);
        const hasSpent = spentRecordIds.has(record.id);
        const riskLevel = classifyRisk(scriptType, hasSpent);
        const tagName = RISK_LEVELS.find(r => r.key === riskLevel)!.tagName;
        const currentTags = record.tags || [];
        const otherTags = currentTags.filter(t => !QUANTUM_TAG_NAMES.has(t));
        const appliedTag = selectedLevels.has(riskLevel) ? tagName : null;

        scanResults.push({
          recordId: record.id,
          address,
          scriptType,
          riskLevel,
          otherTags,
          appliedTag,
        });

        if (selectedLevels.size > 0) {
          // Selected level: the record must carry exactly its fresh quantum
          // tag (replacing any stale one). Unselected level: every stale
          // quantum:* tag is stripped so the namespace always reflects the
          // latest scan + selection.
          const currentQuantum = currentTags.filter(t => QUANTUM_TAG_NAMES.has(t));
          const desiredQuantum = appliedTag ? [appliedTag] : [];
          const unchanged =
            currentQuantum.length === desiredQuantum.length &&
            desiredQuantum.every(t => currentQuantum.includes(t));
          if (!unchanged) {
            pendingWrites.push({ recordId: record.id, tags: [...otherTags, ...desiredQuantum] });
          }
        }
      }

      // With no levels selected the scan is analysis-only: no vocabulary
      // writes and no record writes of any kind.
      if (selectedLevels.size > 0) {
        setScanState("tagging");
        setTaggingProgress({ current: 0, total: pendingWrites.length });

        // Create quantum:* vocabulary tags only for the levels that will
        // actually be applied.
        const existingTagNames = new Set(tags.map(t => t.name));
        for (const level of RISK_LEVELS) {
          if (!selectedLevels.has(level.key) || existingTagNames.has(level.tagName)) continue;
          try {
            await createTag(level.tagName, level.color);
          } catch (error) {
            // The hook's tag snapshot can lag a concurrent creator; an
            // already-existing tag is fine, anything else is a real failure.
            if (!(error instanceof Error && /already exists/i.test(error.message))) {
              throw error;
            }
          }
        }

        beginBulkOperation();
        try {
          for (let idx = 0; idx < pendingWrites.length; idx++) {
            const write = pendingWrites[idx];
            // skipVocabularySync: the scan manages the quantum:* vocabulary
            // itself (above, selected levels only); it must not create
            // vocabulary entries for the record's other tags as a side effect.
            await updateRecord(write.recordId, { tags: write.tags }, { skipVocabularySync: true });
            setTaggingProgress({ current: idx + 1, total: pendingWrites.length });
            if (idx % 10 === 9) await new Promise(r => setTimeout(r, 0));
          }
        } finally {
          endBulkOperation();
        }
      }

      setResults(scanResults);
      setLastScanTagged(selectedLevels.size > 0);
      setScanState("complete");

      const classified = scanResults.length;
      const tagged = scanResults.filter(r => r.appliedTag !== null).length;
      const classifiedText = `${classified} address${classified !== 1 ? "es" : ""} classified`;
      toast({
        title: "Scan Complete",
        description:
          selectedLevels.size === 0
            ? `${classifiedText}. Analysis only — no tags were applied.`
            : `${classifiedText}, ${tagged} tagged.`,
      });
    } catch (error) {
      console.error("Quantum scan failed:", error);
      toast({
        variant: "destructive",
        title: "Scan Failed",
        description: error instanceof Error ? error.message : "An error occurred during the scan.",
      });
      setScanState("idle");
    }
  }, [tags, toast, quantumTagLevels]);

  const taggedCount = useMemo(
    () => results.filter(r => r.appliedTag !== null).length,
    [results],
  );

  const normalizedFilter = filterText.trim().toLowerCase();
  const hasActiveFilters = normalizedFilter !== "" || levelFilters.length > 0;

  const filteredResults = useMemo(
    () =>
      results.filter(
        r =>
          (levelFilters.length === 0 || levelFilters.includes(r.riskLevel)) &&
          (normalizedFilter === "" || r.address.toLowerCase().includes(normalizedFilter)),
      ),
    [results, levelFilters, normalizedFilter],
  );

  const clearFilters = useCallback(() => {
    setFilterText("");
    setLevelFilters([]);
  }, []);

  const handleCopyCsv = useCallback(() => {
    copy(buildQuantumFindingsCsv(filteredResults), {
      label: "Findings CSV",
      key: "quantum-findings-csv",
    });
  }, [copy, filteredResults]);

  const handleDownloadCsv = useCallback(() => {
    try {
      const csv = buildQuantumFindingsCsv(filteredResults);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `kyutxo-quantum-risk-${stamp}.csv`;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      toast({ description: `Findings saved as ${filename}` });
    } catch (error) {
      console.error("Quantum findings CSV download failed:", error);
      toast({
        variant: "destructive",
        title: "Download Failed",
        description:
          error instanceof Error ? error.message : "Could not generate the findings CSV.",
      });
    }
  }, [filteredResults, toast]);

  // Full-scan totals for the Risk Summary (never affected by the filter bar).
  const countByLevel = (level: RiskLevel) => results.filter(r => r.riskLevel === level).length;

  const progressPercent = (() => {
    if (scanState === "tagging" && taggingProgress.total > 0) {
      return Math.round((taggingProgress.current / taggingProgress.total) * 100);
    }
    return 0;
  })();

  const statusMessage = (() => {
    switch (scanState) {
      case "analyzing":
        return "Analyzing address types and spending history...";
      case "tagging":
        return `Updating tags... ${taggingProgress.current} / ${taggingProgress.total} record${taggingProgress.total !== 1 ? "s" : ""}`;
      case "complete": {
        const classifiedText = `${results.length} address${results.length !== 1 ? "es" : ""} classified`;
        return lastScanTagged
          ? `Scan complete. ${classifiedText}, ${taggedCount} tagged.`
          : `Scan complete. ${classifiedText}. Analysis only — no tags were applied.`;
      }
      default:
        return "";
    }
  })();

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6" data-testid="page-quantum-risk-scanner">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
          Quantum Risk Scanner
        </h1>
        <p className="text-muted-foreground mt-1" data-testid="text-page-description">
          Scan your Bitcoin address records for quantum computing vulnerability and tag them by risk level.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Scanner
          </CardTitle>
          <CardDescription>
            Classifies addresses by script type and spending history to determine quantum risk exposure.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2" data-testid="apply-tags-selection">
            <div>
              <p className="text-sm font-medium">Apply tags</p>
              <p className="text-xs text-muted-foreground">
                Risk levels that receive their <code className="text-xs">quantum:*</code> tag when a scan
                runs. Every address is still classified and listed; stale quantum tags on unselected
                levels are removed.
              </p>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {RISK_LEVELS.map(level => (
                <label
                  key={level.key}
                  className="flex items-center gap-2 text-sm cursor-pointer"
                  data-testid={`label-apply-tag-${level.key}`}
                >
                  <Checkbox
                    checked={quantumTagLevels.includes(level.key)}
                    disabled={isScanning || settingsLoading}
                    onCheckedChange={(checked) => handleLevelToggle(level.key, checked === true)}
                    data-testid={`checkbox-apply-tag-${level.key}`}
                  />
                  <span>{level.label}</span>
                </label>
              ))}
            </div>
            {!settingsLoading && quantumTagLevels.length === 0 && (
              <p className="text-xs text-muted-foreground" data-testid="text-analysis-only-hint">
                No levels selected — scans will classify addresses without writing any tags.
              </p>
            )}
          </div>

          {scanState === "idle" && (
            <Button onClick={runScan} disabled={settingsLoading} data-testid="button-scan-records">
              <Search className="h-4 w-4 mr-2" />
              Scan Records
            </Button>
          )}

          {isScanning && (
            <div className="space-y-3" data-testid="scan-progress">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm" data-testid="text-status-message">{statusMessage}</span>
              </div>
              {scanState === "tagging" && (
                <Progress value={progressPercent} data-testid="progress-bar" />
              )}
            </div>
          )}

          {scanState === "complete" && (
            <div className="space-y-4">
              <Button onClick={runScan} variant="outline" disabled={settingsLoading} data-testid="button-rescan">
                <Search className="h-4 w-4 mr-2" />
                Re-scan Records
              </Button>
              <p className="text-sm text-muted-foreground" data-testid="text-status-message">
                {statusMessage}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {scanState === "complete" && results.length > 0 && (
        <>
          <Card data-testid="card-summary">
            <CardHeader>
              <CardTitle>Risk Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3" data-testid="summary-badges">
                {RISK_LEVELS.map(level => {
                  const count = countByLevel(level.key);
                  const badgeProps = getRiskBadgeProps(level.key);
                  return (
                    <div key={level.key} className="flex items-center gap-2" data-testid={`summary-${level.key}`}>
                      <Badge {...badgeProps}>
                        {level.label}
                      </Badge>
                      <span className="text-sm font-medium" data-testid={`count-${level.key}`}>{count}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-results-toolbar">
            <CardContent className="pt-6 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <Input
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    placeholder="Filter by address..."
                    className="pl-9"
                    data-testid="input-filter-address"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyCsv}
                  disabled={filteredResults.length === 0}
                  data-testid="button-copy-findings"
                >
                  {isCopied("quantum-findings-csv") ? (
                    <Check className="h-4 w-4 mr-2" />
                  ) : (
                    <Copy className="h-4 w-4 mr-2" />
                  )}
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadCsv}
                  disabled={filteredResults.length === 0}
                  data-testid="button-download-findings"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download CSV
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Risk level:</span>
                {RISK_LEVELS.map(level => {
                  const active = levelFilters.includes(level.key);
                  return (
                    <Button
                      key={level.key}
                      variant={active ? "default" : "outline"}
                      size="sm"
                      onClick={() =>
                        setLevelFilters(prev =>
                          active ? prev.filter(l => l !== level.key) : [...prev, level.key],
                        )
                      }
                      data-testid={`button-filter-level-${level.key}`}
                    >
                      {level.label}
                    </Button>
                  );
                })}
                {hasActiveFilters && (
                  <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="button-clear-filters">
                    <X className="h-4 w-4 mr-1" />
                    Clear
                  </Button>
                )}
                <span className="text-xs text-muted-foreground ml-auto" data-testid="text-filter-count">
                  {filteredResults.length} of {results.length} shown
                </span>
              </div>
            </CardContent>
          </Card>

          {filteredResults.length === 0 ? (
            <Card data-testid="empty-filter-state">
              <CardContent className="py-8 text-center space-y-3">
                <p className="text-sm text-muted-foreground">No results match your filters.</p>
                <Button variant="outline" size="sm" onClick={clearFilters} data-testid="button-clear-filters-empty">
                  Clear filters
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3" data-testid="results-grouped">
              {RISK_LEVELS.map(level => {
                const levelResults = filteredResults.filter(r => r.riskLevel === level.key);
                if (levelResults.length === 0) return null;
                const LevelIcon = level.icon;
                const badgeProps = getRiskBadgeProps(level.key);

                return (
                  <Collapsible
                    key={level.key}
                    open={openGroups[level.key]}
                    onOpenChange={(open) =>
                      setOpenGroups(prev => ({ ...prev, [level.key]: open }))
                    }
                  >
                    <Card data-testid={`group-${level.key}`}>
                      <CollapsibleTrigger className="w-full" data-testid={`trigger-${level.key}`}>
                        <CardHeader className="flex flex-row items-center justify-between gap-2 cursor-pointer">
                          <div className="flex items-center gap-2">
                            <LevelIcon className="h-5 w-5" />
                            <CardTitle className="text-base">{level.label}</CardTitle>
                            <Badge {...badgeProps} data-testid={`group-count-${level.key}`}>
                              {levelResults.length}
                            </Badge>
                          </div>
                          <ChevronDown
                            className={`h-4 w-4 transition-transform duration-200 ${
                              openGroups[level.key] ? "" : "-rotate-90"
                            }`}
                          />
                        </CardHeader>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <CardContent className="pt-0">
                          <div className="space-y-2">
                            {levelResults.map(result => (
                              <div
                                key={result.recordId}
                                className="flex items-center justify-between gap-4 py-2 border-b last:border-b-0"
                                data-testid={`result-${result.recordId}`}
                              >
                                <div className="flex-1 min-w-0">
                                  <span
                                    className="text-sm font-mono truncate block"
                                    data-testid={`address-${result.recordId}`}
                                    title={result.address}
                                  >
                                    {result.address}
                                  </span>
                                  <span
                                    className="text-xs text-muted-foreground uppercase"
                                    data-testid={`script-type-${result.recordId}`}
                                  >
                                    {result.scriptType}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                                  {result.otherTags.slice(0, 3).map(tag => (
                                    <Badge key={tag} variant="outline">
                                      {tag}
                                    </Badge>
                                  ))}
                                  {result.appliedTag && (
                                    <Badge {...badgeProps} data-testid={`tag-applied-${result.recordId}`}>
                                      {result.appliedTag}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
