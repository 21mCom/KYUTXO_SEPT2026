import { useState, useCallback } from "react";
import {
  Eye,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  ChevronDown,
  Tag,
  Shield,
  Fingerprint,
  Combine,
  Building2,
  Merge,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { db, beginBulkOperation, endBulkOperation } from "@/lib/database";
import type { Record as DbRecord } from "@/lib/database";
import { isEncryptionReady } from "@/lib/encryption/key-management";
import { decryptRecordsWithProgress } from "@/lib/encryption/record-encryption";
import type { DecryptProgress } from "@/lib/encryption/record-encryption";
import { createTag } from "@/lib/encryption/vocabulary-crud";
import { updateRecord } from "@/lib/encryption/record-crud";
import { useEncryptedTags } from "@/hooks/use-encrypted-records";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useToast } from "@/hooks/use-toast";
import { ClickableAddress } from "@/components/ClickableAddress";
import { TxidLink } from "@/components/TxidLink";
import {
  runPrivacyAudit,
  PRIVACY_TAG_MAP,
  PRIVACY_TAG_NAMES,
  type PrivacyAuditResult,
  type PrivacyFinding,
  type PrivacyFindingType,
  type PrivacySeverity,
} from "@/lib/privacy-audit";

type ScanState = "idle" | "decrypting" | "analyzing" | "tagging" | "complete";

const FINDING_TYPE_META: Record<PrivacyFindingType, { label: string; icon: typeof Shield }> = {
  SCRIPT_TYPE_MIXING: { label: "Script Type Mixing", icon: Fingerprint },
  DUST: { label: "Dust UTXO", icon: AlertTriangle },
  DUST_SPENDING: { label: "Dust Spending", icon: AlertTriangle },
  CONSOLIDATION_ORIGIN: { label: "Consolidation Origin", icon: Combine },
  EXCHANGE_ORIGIN: { label: "Exchange Origin", icon: Building2 },
  TAINTED_UTXO_MERGE: { label: "UTXO Merge", icon: Merge },
};

function getSeverityBadgeProps(severity: PrivacySeverity): {
  variant?: "destructive" | "default" | "secondary" | "outline";
  className?: string;
} {
  switch (severity) {
    case "CRITICAL":
      return { variant: "destructive" };
    case "HIGH":
      return { className: "bg-orange-500 text-white no-default-hover-elevate no-default-active-elevate" };
    case "MEDIUM":
      return { className: "bg-yellow-500 text-black no-default-hover-elevate no-default-active-elevate" };
    case "LOW":
      return { className: "bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate" };
    default:
      return { variant: "secondary" };
  }
}

export default function PrivacyAudit() {
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [decryptProgress, setDecryptProgress] = useState<DecryptProgress | null>(null);
  const [result, setResult] = useState<PrivacyAuditResult | null>(null);
  const [taggingProgress, setTaggingProgress] = useState({ current: 0, total: 0 });
  const [selectedOwner, setSelectedOwner] = useState<string>("all");
  const [selectedWallet, setSelectedWallet] = useState<string>("all");
  const [openTypes, setOpenTypes] = useState<Record<string, boolean>>({});

  const { tags } = useEncryptedTags();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { toast } = useToast();

  const runAudit = useCallback(async () => {
    if (!isEncryptionReady()) {
      toast({
        variant: "destructive",
        title: "Encryption Not Ready",
        description: "Please log in before running the audit.",
      });
      return;
    }

    try {
      setScanState("decrypting");
      setResult(null);
      setStatusMessage("Loading address records...");

      let records = await db.records.where("type").equals("address").toArray();

      if (records.length === 0) {
        toast({ title: "No Records", description: "No address records found to audit." });
        setScanState("idle");
        return;
      }

      const decrypted = await decryptRecordsWithProgress(records, (progress) => {
        setDecryptProgress(progress);
      });
      setDecryptProgress(null);

      let filtered = decrypted;
      if (selectedOwner !== "all") {
        filtered = filtered.filter(r => r.owner === selectedOwner);
      }
      if (selectedWallet !== "all") {
        filtered = filtered.filter(r => r.walletName === selectedWallet);
      }

      if (filtered.length === 0) {
        toast({ title: "No Matching Records", description: "No address records match the selected filters." });
        setScanState("idle");
        return;
      }

      setScanState("analyzing");
      const userAddresses = filtered.map(r => r.inputString).filter(Boolean);

      const auditResult = await runPrivacyAudit(userAddresses, (msg) => {
        setStatusMessage(msg);
      });

      setResult(auditResult);
      setScanState("complete");

      const totalIssues = auditResult.findings.length + auditResult.warnings.length;
      toast({
        title: auditResult.isClean ? "All Clear" : "Audit Complete",
        description: auditResult.isClean
          ? `${auditResult.transactionsAnalyzed} transactions analyzed — no privacy issues found.`
          : `Found ${auditResult.findings.length} finding(s) and ${auditResult.warnings.length} warning(s) across ${auditResult.transactionsAnalyzed} transactions.`,
      });
    } catch (error) {
      console.error("Privacy audit failed:", error);
      toast({
        variant: "destructive",
        title: "Audit Failed",
        description: error instanceof Error ? error.message : "An error occurred during the audit.",
      });
      setScanState("idle");
    }
  }, [selectedOwner, selectedWallet, toast]);

  const tagFindings = useCallback(async () => {
    if (!result) return;

    const allItems = [...result.findings, ...result.warnings];
    const addressToFindings = new Map<string, Set<string>>();
    for (const f of allItems) {
      const tagInfo = PRIVACY_TAG_MAP[f.type];
      if (!tagInfo) continue;
      for (const addr of f.addresses) {
        const existing = addressToFindings.get(addr);
        if (existing) {
          existing.add(tagInfo.tagName);
        } else {
          addressToFindings.set(addr, new Set([tagInfo.tagName]));
        }
      }
    }

    if (addressToFindings.size === 0) {
      toast({ title: "Nothing to Tag", description: "No addresses found in the findings." });
      return;
    }

    setScanState("tagging");
    setTaggingProgress({ current: 0, total: addressToFindings.size });

    try {
      const existingTagNames = new Set(tags.map(t => t.name));
      for (const info of Object.values(PRIVACY_TAG_MAP)) {
        if (!existingTagNames.has(info.tagName)) {
          await createTag(info.tagName, info.color);
        }
      }

      const records = await db.records.where("type").equals("address").toArray();
      const decrypted = await decryptRecordsWithProgress(records);

      const addressToRecord = new Map<string, DbRecord>();
      for (const r of decrypted) {
        if (r.inputString) {
          addressToRecord.set(r.inputString, r);
        }
      }

      beginBulkOperation();
      try {
        const tagEntries = Array.from(addressToFindings.entries());
        for (let idx = 0; idx < tagEntries.length; idx++) {
          const address = tagEntries[idx][0];
          const tagNames = tagEntries[idx][1];
          const record = addressToRecord.get(address);
          if (record?.id) {
            const existingTags = (record.tags || []).filter((t: string) => !PRIVACY_TAG_NAMES.has(t));
            const newTags: string[] = [...existingTags, ...Array.from(tagNames)];
            await updateRecord(record.id, { tags: newTags });
          }
          setTaggingProgress({ current: idx + 1, total: tagEntries.length });
          if (idx % 10 === 9) await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        endBulkOperation();
      }

      setScanState("complete");
      toast({
        title: "Tagging Complete",
        description: `Applied privacy tags to ${addressToFindings.size} address record(s).`,
      });
    } catch (error) {
      console.error("Tagging failed:", error);
      toast({
        variant: "destructive",
        title: "Tagging Failed",
        description: error instanceof Error ? error.message : "An error occurred during tagging.",
      });
      setScanState("complete");
    }
  }, [result, tags, toast]);

  const groupedFindings = (() => {
    if (!result) return [];
    const allItems = [...result.findings, ...result.warnings];
    const groups = new Map<PrivacyFindingType, PrivacyFinding[]>();
    for (const f of allItems) {
      const list = groups.get(f.type);
      if (list) list.push(f);
      else groups.set(f.type, [f]);
    }
    return Array.from(groups.entries()).map(([type, items]) => ({
      type,
      items,
      meta: FINDING_TYPE_META[type],
      highestSeverity: items.reduce<PrivacySeverity>((best, f) => {
        const order: Record<PrivacySeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return order[f.severity] < order[best] ? f.severity : best;
      }, "LOW"),
    }));
  })();

  const countBySeverity = (severity: PrivacySeverity) => {
    if (!result) return 0;
    return [...result.findings, ...result.warnings].filter(f => f.severity === severity).length;
  };

  const progressPercent = (() => {
    if (scanState === "decrypting" && decryptProgress) {
      return Math.round((decryptProgress.current / decryptProgress.total) * 100);
    }
    if (scanState === "tagging" && taggingProgress.total > 0) {
      return Math.round((taggingProgress.current / taggingProgress.total) * 100);
    }
    return 0;
  })();

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4 max-w-4xl mx-auto">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Privacy Audit</h1>
          <p className="text-sm text-muted-foreground" data-testid="text-page-description">
            Scan your transaction history for privacy vulnerabilities using on-chain heuristics.
            All analysis runs locally — no data leaves your device.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audit Configuration</CardTitle>
            <CardDescription>Select filters to scope the audit, then run the scan.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="space-y-1 min-w-[160px]">
                <label className="text-xs text-muted-foreground">Owner</label>
                <Select value={selectedOwner} onValueChange={setSelectedOwner}>
                  <SelectTrigger data-testid="select-owner">
                    <SelectValue placeholder="All Owners" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Owners</SelectItem>
                    {owners.map(o => (
                      <SelectItem key={o.name} value={o.name}>{o.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 min-w-[160px]">
                <label className="text-xs text-muted-foreground">Wallet</label>
                <Select value={selectedWallet} onValueChange={setSelectedWallet}>
                  <SelectTrigger data-testid="select-wallet">
                    <SelectValue placeholder="All Wallets" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Wallets</SelectItem>
                    {walletNames.map(w => (
                      <SelectItem key={w.name} value={w.name}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={runAudit}
                disabled={scanState !== "idle" && scanState !== "complete"}
                data-testid="button-run-audit"
              >
                {scanState === "idle" || scanState === "complete" ? (
                  <>
                    <Eye className="mr-2 h-4 w-4" />
                    Run Audit
                  </>
                ) : (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {scanState === "decrypting" ? "Decrypting..." : scanState === "analyzing" ? "Analyzing..." : "Tagging..."}
                  </>
                )}
              </Button>
            </div>

            {(scanState === "decrypting" || scanState === "tagging") && (
              <div className="space-y-1">
                <Progress value={progressPercent} className="h-2" data-testid="progress-audit" />
                <p className="text-xs text-muted-foreground" data-testid="text-progress-status">
                  {scanState === "decrypting" && decryptProgress
                    ? `Decrypting records... ${decryptProgress.current} / ${decryptProgress.total}`
                    : scanState === "tagging"
                    ? `Applying tags... ${taggingProgress.current} / ${taggingProgress.total}`
                    : statusMessage}
                </p>
              </div>
            )}

            {scanState === "analyzing" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span data-testid="text-analyzing-status">{statusMessage || "Analyzing transactions..."}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {result && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-2xl font-bold" data-testid="text-stat-total">
                    {result.findings.length + result.warnings.length}
                  </div>
                  <div className="text-xs text-muted-foreground">Total Issues</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-2xl font-bold" data-testid="text-stat-txs">
                    {result.transactionsAnalyzed}
                  </div>
                  <div className="text-xs text-muted-foreground">Transactions Analyzed</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-2xl font-bold" data-testid="text-stat-addresses">
                    {result.addressesScanned}
                  </div>
                  <div className="text-xs text-muted-foreground">Addresses Scanned</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  {result.isClean ? (
                    <div className="flex flex-col items-center gap-1">
                      <ShieldCheck className="h-6 w-6 text-green-500" />
                      <div className="text-xs text-green-600 dark:text-green-400 font-medium" data-testid="text-clean-badge">
                        Clean
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap justify-center gap-1" data-testid="container-severity-summary">
                      {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as PrivacySeverity[]).map(sev => {
                        const count = countBySeverity(sev);
                        if (count === 0) return null;
                        return (
                          <Badge key={sev} {...getSeverityBadgeProps(sev)} data-testid={`badge-severity-${sev.toLowerCase()}`}>
                            {count} {sev}
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">Status</div>
                </CardContent>
              </Card>
            </div>

            {!result.isClean && (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  onClick={tagFindings}
                  disabled={scanState === "tagging"}
                  data-testid="button-tag-findings"
                >
                  {scanState === "tagging" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Tag className="mr-2 h-4 w-4" />
                  )}
                  Tag All Findings
                </Button>
              </div>
            )}

            {groupedFindings.length === 0 && result.isClean && (
              <Card>
                <CardContent className="p-8 text-center">
                  <ShieldCheck className="h-12 w-12 text-green-500 mx-auto mb-3" />
                  <h3 className="text-lg font-medium" data-testid="text-no-findings">No Privacy Issues Found</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Your transaction history shows no detectable privacy vulnerabilities.
                  </p>
                </CardContent>
              </Card>
            )}

            <div className="space-y-3">
              {groupedFindings.map(({ type, items, meta, highestSeverity }) => {
                const Icon = meta.icon;
                const isOpen = openTypes[type] ?? true;

                return (
                  <Collapsible
                    key={type}
                    open={isOpen}
                    onOpenChange={(open) => setOpenTypes(prev => ({ ...prev, [type]: open }))}
                  >
                    <Card>
                      <CollapsibleTrigger asChild>
                        <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 py-3 px-4">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="font-medium text-sm" data-testid={`text-group-title-${type.toLowerCase()}`}>
                              {meta.label}
                            </span>
                            <Badge {...getSeverityBadgeProps(highestSeverity)} data-testid={`badge-group-severity-${type.toLowerCase()}`}>
                              {items.length}
                            </Badge>
                          </div>
                          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ${isOpen ? "rotate-180" : ""}`} />
                        </CardHeader>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <CardContent className="pt-0 pb-4 px-4 space-y-3">
                          {items.map((finding, idx) => (
                            <FindingCard key={`${finding.type}-${idx}`} finding={finding} />
                          ))}
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
    </ScrollArea>
  );
}

function FindingCard({ finding }: { finding: PrivacyFinding }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-md p-3 space-y-2" data-testid={`card-finding-${finding.type.toLowerCase()}`}>
      <div className="flex items-start gap-2 flex-wrap">
        <Badge {...getSeverityBadgeProps(finding.severity)} data-testid={`badge-finding-severity`}>
          {finding.severity}
        </Badge>
        <p className="text-sm flex-1">{finding.description}</p>
      </div>

      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" data-testid="button-toggle-details">
            <ChevronDown className={`h-3 w-3 mr-1 transition-transform ${expanded ? "rotate-180" : ""}`} />
            {expanded ? "Hide Details" : "Show Details"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 mt-2 pl-2 border-l-2 border-muted">
            {finding.txids.length > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Transactions:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {finding.txids.slice(0, 10).map(txid => (
                    <TxidLink key={txid} txid={txid} />
                  ))}
                  {finding.txids.length > 10 && (
                    <span className="text-xs text-muted-foreground">
                      +{finding.txids.length - 10} more
                    </span>
                  )}
                </div>
              </div>
            )}

            {finding.addresses.length > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Addresses:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {finding.addresses.slice(0, 10).map(addr => (
                    <ClickableAddress key={addr} address={addr} />
                  ))}
                  {finding.addresses.length > 10 && (
                    <span className="text-xs text-muted-foreground">
                      +{finding.addresses.length - 10} more
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="bg-muted/50 rounded p-2 mt-2" data-testid="container-remediation">
              <span className="text-xs font-medium text-muted-foreground">Remediation:</span>
              <p className="text-xs mt-0.5" data-testid="text-remediation">{finding.correction}</p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
