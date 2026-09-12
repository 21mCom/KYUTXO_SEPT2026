import { useState } from "react";
import {
  ChevronDown,
  TrendingDown,
  ArrowDown,
  CornerDownRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useLiveQuery } from "dexie-react-hooks";
import { renderSourceNote } from "@/lib/renderSourceNote";
import { getRecordsByInputStrings } from "@/lib/data/record-crud";
import { classifyBehavior, BEHAVIOR_LABEL_DISPLAY, type BehaviorProfile } from "@/lib/behavior-profile";
import type { PrivacyFinding, PrivacySeverity, EntityCitation } from "@/lib/privacy-audit";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { formatScoreDelta } from "@/lib/privacy-report-export";
import { DeepDiveDialog } from "./transaction-deep-dive";
import { PeelChainView } from "./peel-chain";

function getSeverityBadgePropsLocal(severity: PrivacySeverity) {
  switch (severity) {
    case "CRITICAL":
      return { variant: "destructive" as const };
    case "HIGH":
      return { className: "bg-orange-500 text-white no-default-hover-elevate no-default-active-elevate" };
    case "MEDIUM":
      return { className: "bg-yellow-500 text-black no-default-hover-elevate no-default-active-elevate" };
    case "LOW":
      return { className: "bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate" };
    default:
      return { variant: "secondary" as const };
  }
}

export function FindingCard({ finding, coinjoinTxids }: { finding: PrivacyFinding; coinjoinTxids: Set<string> }) {
  const [expanded, setExpanded] = useState(false);
  const [showAllAddresses, setShowAllAddresses] = useState(false);
  const [showAllTxids, setShowAllTxids] = useState(false);
  const citations = (finding.details?.citations as EntityCitation[] | undefined) ?? [];
  const hopPath = (finding.details?.hopPath as string[] | undefined) ?? [];
  const hopTxids = (finding.details?.hopTxids as string[] | undefined) ?? [];

  const addressBehaviors = useLiveQuery(async () => {
    const map = new Map<string, BehaviorProfile>();
    if (!finding.addresses || finding.addresses.length === 0) return map;
    const records = await getRecordsByInputStrings(finding.addresses);
    for (const r of records) {
      if (r.type !== 'address' || !r.inputString) continue;
      map.set(r.inputString, classifyBehavior({
        synced: r.statsComputedAt != null,
        balanceSats: r.cachedBalanceSats ?? 0,
        txCount: r.cachedTxCount ?? 0,
        utxoCount: r.cachedUtxoCount ?? 0,
        lastActivityTime: r.cachedLastActivityTime ?? 0,
      }));
    }
    return map;
  }, [finding.addresses]);

  return (
    <div
      className="border rounded-md p-3 space-y-2"
      data-testid={`card-finding-${finding.type.toLowerCase()}`}
    >
      <div className="flex items-start gap-2 flex-wrap">
        <Badge {...getSeverityBadgePropsLocal(finding.severity)} data-testid="badge-finding-severity">
          {finding.severity}
        </Badge>
        <p className="text-sm flex-1">{renderSourceNote(finding.description)}</p>
        {formatScoreDelta(finding.scoreDelta) !== null && (
          <span className="text-xs text-red-500 dark:text-red-400 font-mono shrink-0" data-testid="text-score-delta">
            {formatScoreDelta(finding.scoreDelta)}
          </span>
        )}
      </div>

      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" data-testid="button-toggle-details">
            <ChevronDown
              className={`h-3 w-3 mr-1 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
            {expanded ? "Hide Details" : "Show Details"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 mt-2 pl-2 border-l-2 border-muted">
            {finding.txids.length > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Transactions:</span>
                <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1">
                  {(showAllTxids ? finding.txids : finding.txids.slice(0, 10)).map((txid) => (
                    <span key={txid} className="inline-flex items-center gap-0.5">
                      <TxidLink txid={txid} />
                      <DeepDiveDialog txid={txid} coinjoinTxids={coinjoinTxids} />
                    </span>
                  ))}
                  {finding.txids.length > 10 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={() => setShowAllTxids((v) => !v)}
                      data-testid="button-toggle-all-txids"
                    >
                      {showAllTxids
                        ? "Show fewer"
                        : `Show all ${finding.txids.length}`}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {finding.type === "PEEL_CHAIN" && finding.txids.length > 0 && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" data-testid="button-view-peel-chain">
                    <TrendingDown className="h-3 w-3 mr-1" />
                    View Peel Chain
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto" data-testid="dialog-peel-chain">
                  <DialogHeader>
                    <DialogTitle>Peel Chain ({finding.txids.length} transactions)</DialogTitle>
                    <DialogDescription>
                      Step-by-step view of how funds were peeled across consecutive transactions.
                    </DialogDescription>
                  </DialogHeader>
                  <PeelChainView txids={finding.txids} changeAddresses={finding.addresses} coinjoinTxids={coinjoinTxids} />
                </DialogContent>
              </Dialog>
            )}

            {hopPath.length > 1 && (
              <div data-testid="container-hop-path">
                <span className="text-xs font-medium text-muted-foreground">Hop path:</span>
                <div className="flex flex-col gap-1 mt-1">
                  {hopPath.map((addr, i) => (
                    <div key={`${addr}-${i}`} className="flex flex-col gap-1">
                      <AddressLink address={addr} truncate={false} />
                      {i < hopPath.length - 1 && (
                        <div className="flex flex-wrap items-center gap-1 pl-4 text-muted-foreground">
                          <CornerDownRight className="h-3 w-3 shrink-0" />
                          {hopTxids[i] ? (
                            <>
                              <span className="text-[11px]">via</span>
                              <TxidLink txid={hopTxids[i]} />
                              <DeepDiveDialog txid={hopTxids[i]} coinjoinTxids={coinjoinTxids} />
                            </>
                          ) : (
                            <ArrowDown className="h-3 w-3 shrink-0" />
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {finding.addresses.length > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Addresses:</span>
                <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1">
                  {(showAllAddresses ? finding.addresses : finding.addresses.slice(0, 10)).map((addr) => {
                    const bp = addressBehaviors?.get(addr);
                    return (
                      <span key={addr} className="inline-flex items-center gap-1">
                        <AddressLink address={addr} truncate={false} />
                        {bp && bp.label !== 'not-enough-data' && bp.label !== 'synced-no-activity' && (
                          <Badge
                            variant="secondary"
                            className="text-xs w-fit"
                            title={bp.summarySentence}
                            data-testid={`badge-behavior-${addr}`}
                          >
                            {BEHAVIOR_LABEL_DISPLAY[bp.label]}
                          </Badge>
                        )}
                      </span>
                    );
                  })}
                  {finding.addresses.length > 10 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={() => setShowAllAddresses((v) => !v)}
                      data-testid="button-toggle-all-addresses"
                    >
                      {showAllAddresses
                        ? "Show fewer"
                        : `Show all ${finding.addresses.length} (with behavior)`}
                    </Button>
                  )}
                </div>
                {finding.addresses.length > 10 && !showAllAddresses && (
                  <p className="text-xs text-muted-foreground mt-1" data-testid="text-behavior-subset-note">
                    Behavior badges shown reflect only the first 10 addresses. Show all to see behavior for every flagged address.
                  </p>
                )}
              </div>
            )}

            {citations.length > 0 && (
              <div data-testid="container-entity-citations">
                <span className="text-xs font-medium text-muted-foreground">Source citations:</span>
                <div className="space-y-1.5 mt-1">
                  {citations.map((c) => (
                    <div
                      key={c.address}
                      className="bg-muted/50 rounded p-2"
                      data-testid={`citation-entity-${c.address}`}
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-medium" data-testid={`text-entity-name-${c.address}`}>
                          {c.name}
                        </span>
                        <Badge variant="secondary" className="text-[10px]" data-testid={`badge-entity-category-${c.address}`}>
                          {c.categoryLabel}
                        </Badge>
                      </div>
                      <div className="text-[11px] text-muted-foreground font-mono mt-0.5 break-all">
                        {c.address}
                      </div>
                      {c.sourceNote && (
                        <div className="mt-1">
                          <p
                            className="text-[11px] text-muted-foreground break-words"
                            data-testid={`text-entity-source-${c.address}`}
                          >
                            {renderSourceNote(c.sourceNote)}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div
              className="bg-muted/50 rounded p-2 mt-2"
              data-testid="container-remediation"
            >
              <span className="text-xs font-medium text-muted-foreground">Remediation:</span>
              <p className="text-xs mt-0.5" data-testid="text-remediation">
                {renderSourceNote(finding.correction)}
              </p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
