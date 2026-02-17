import { useState, useCallback } from "react";
import { Shield, ShieldAlert, ShieldCheck, AlertTriangle, Search, Loader2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { db, beginBulkOperation, endBulkOperation } from "@/lib/database";
import type { Record as DbRecord, Tag } from "@/lib/database";
import { isEncryptionReady } from "@/lib/encryption/key-management";
import { decryptRecordsWithProgress } from "@/lib/encryption/record-encryption";
import type { DecryptProgress } from "@/lib/encryption/record-encryption";
import { createTag } from "@/lib/encryption/vocabulary-crud";
import { updateRecord } from "@/lib/encryption/record-crud";
import { useEncryptedTags } from "@/hooks/use-encrypted-records";
import { useToast } from "@/hooks/use-toast";

type ScanState = "idle" | "decrypting" | "analyzing" | "tagging" | "complete";

type RiskLevel = "critical" | "high" | "medium" | "variable" | "low";

interface ScanResult {
  recordId: number;
  address: string;
  riskLevel: RiskLevel;
  currentTags: string[];
  newTag: string;
}

const RISK_LEVELS: { key: RiskLevel; label: string; tagName: string; color: string; icon: typeof Shield }[] = [
  { key: "critical", label: "Critical", tagName: "quantum:critical", color: "#ef4444", icon: ShieldAlert },
  { key: "high", label: "High", tagName: "quantum:high", color: "#f97316", icon: AlertTriangle },
  { key: "medium", label: "Medium", tagName: "quantum:medium", color: "#eab308", icon: Shield },
  { key: "variable", label: "Variable", tagName: "quantum:variable", color: "#3b82f6", icon: Search },
  { key: "low", label: "Low", tagName: "quantum:low", color: "#22c55e", icon: ShieldCheck },
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

export default function QuantumRiskScanner() {
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [decryptProgress, setDecryptProgress] = useState<DecryptProgress | null>(null);
  const [results, setResults] = useState<ScanResult[]>([]);
  const [taggingProgress, setTaggingProgress] = useState({ current: 0, total: 0 });
  const [openGroups, setOpenGroups] = useState<Record<RiskLevel, boolean>>({
    critical: true,
    high: true,
    medium: true,
    variable: true,
    low: true,
  });
  const { tags } = useEncryptedTags();
  const { toast } = useToast();

  const runScan = useCallback(async () => {
    if (!isEncryptionReady()) {
      toast({
        variant: "destructive",
        title: "Encryption Not Ready",
        description: "Please log in before running the scanner.",
      });
      return;
    }

    try {
      setScanState("decrypting");
      setResults([]);

      const allRecords = await db.records.where("type").equals("address").toArray();

      if (allRecords.length === 0) {
        toast({
          title: "No Records",
          description: "No address records found to scan.",
        });
        setScanState("idle");
        return;
      }

      const decrypted = await decryptRecordsWithProgress(allRecords, (progress) => {
        setDecryptProgress(progress);
      });
      setDecryptProgress(null);

      setScanState("analyzing");

      const inputParticipants = await db.transactionParticipants.where("role").equals("input").toArray();
      const spentRecordIds = new Set(
        inputParticipants
          .filter(p => p.recordId != null)
          .map(p => p.recordId!)
      );

      const scanResults: ScanResult[] = [];
      for (const record of decrypted) {
        if (!record.id) continue;
        const address = record.inputString;
        const addressType = detectAddressType(address);
        const hasSpent = spentRecordIds.has(record.id);
        const riskLevel = classifyRisk(addressType, hasSpent);
        const tagName = RISK_LEVELS.find(r => r.key === riskLevel)!.tagName;

        scanResults.push({
          recordId: record.id,
          address,
          riskLevel,
          currentTags: record.tags || [],
          newTag: tagName,
        });
      }

      setScanState("tagging");
      setTaggingProgress({ current: 0, total: scanResults.length });

      const existingTagNames = new Set(tags.map(t => t.name));
      for (const level of RISK_LEVELS) {
        if (!existingTagNames.has(level.tagName)) {
          await createTag(level.tagName, level.color);
        }
      }

      beginBulkOperation();
      try {
        for (let idx = 0; idx < scanResults.length; idx++) {
          const result = scanResults[idx];
          const existingTags = result.currentTags.filter(t => !QUANTUM_TAG_NAMES.has(t));
          const newTags = [...existingTags, result.newTag];
          await updateRecord(result.recordId, { tags: newTags });
          setTaggingProgress({ current: idx + 1, total: scanResults.length });
          if (idx % 10 === 9) await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        endBulkOperation();
      }

      setResults(scanResults);
      setScanState("complete");

      toast({
        title: "Scan Complete",
        description: `${scanResults.length} address${scanResults.length !== 1 ? "es" : ""} classified and tagged.`,
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
  }, [tags, toast]);

  const countByLevel = (level: RiskLevel) => results.filter(r => r.riskLevel === level).length;

  const progressPercent = (() => {
    if (scanState === "decrypting" && decryptProgress) {
      return Math.round((decryptProgress.current / decryptProgress.total) * 100);
    }
    if (scanState === "tagging" && taggingProgress.total > 0) {
      return Math.round((taggingProgress.current / taggingProgress.total) * 100);
    }
    return 0;
  })();

  const statusMessage = (() => {
    switch (scanState) {
      case "decrypting":
        return decryptProgress
          ? `Decrypting records... ${decryptProgress.current} / ${decryptProgress.total}`
          : "Decrypting records...";
      case "analyzing":
        return "Analyzing address types and spending history...";
      case "tagging":
        return `Applying tags... ${taggingProgress.current} / ${taggingProgress.total}`;
      case "complete":
        return `Scan complete. ${results.length} addresses classified.`;
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
          Scan your Bitcoin address records for quantum computing vulnerability and auto-tag them by risk level.
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
          {scanState === "idle" && (
            <Button onClick={runScan} data-testid="button-scan-records">
              <Search className="h-4 w-4 mr-2" />
              Scan Records
            </Button>
          )}

          {(scanState === "decrypting" || scanState === "analyzing" || scanState === "tagging") && (
            <div className="space-y-3" data-testid="scan-progress">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm" data-testid="text-status-message">{statusMessage}</span>
              </div>
              {(scanState === "decrypting" || scanState === "tagging") && (
                <Progress value={progressPercent} data-testid="progress-bar" />
              )}
            </div>
          )}

          {scanState === "complete" && (
            <div className="space-y-4">
              <Button onClick={runScan} variant="outline" data-testid="button-rescan">
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

          <div className="space-y-3" data-testid="results-grouped">
            {RISK_LEVELS.map(level => {
              const levelResults = results.filter(r => r.riskLevel === level.key);
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
                          <Badge {...badgeProps}>
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
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                                {result.currentTags
                                  .filter(t => !QUANTUM_TAG_NAMES.has(t))
                                  .slice(0, 3)
                                  .map(tag => (
                                    <Badge key={tag} variant="outline">
                                      {tag}
                                    </Badge>
                                  ))}
                                <Badge {...badgeProps} data-testid={`tag-${result.recordId}`}>
                                  {result.newTag}
                                </Badge>
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
        </>
      )}
    </div>
  );
}
