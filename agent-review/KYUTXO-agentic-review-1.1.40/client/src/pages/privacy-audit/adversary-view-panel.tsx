import { useState } from "react";
import {
  Loader2,
  ChevronDown,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  Merge,
  AlertTriangle,
  ScanSearch,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { renderSourceNote } from "@/lib/renderSourceNote";
import type { AdversaryViewResult, AdversaryFinding, ContextMergeWarning } from "@/lib/adversary-view";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";

function AdversaryFindingRow({ finding }: { finding: AdversaryFinding }) {
  const [expanded, setExpanded] = useState(false);
  const isExposure = finding.category === "exposure";
  const isSeparation = finding.category === "preserved-separation";
  const isConfusion = finding.category === "protective-confusion";

  const confidenceBadge =
    finding.confidence === "certain"
      ? { className: "bg-slate-500 text-white no-default-hover-elevate no-default-active-elevate" }
      : finding.confidence === "likely"
        ? { className: "bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate" }
        : { variant: "secondary" as const };

  return (
    <div
      className={`border rounded-md p-3 space-y-2 ${
        isExposure
          ? "border-red-500/30 bg-red-500/5"
          : isSeparation
            ? "border-green-500/30 bg-green-500/5"
            : isConfusion
              ? "border-blue-500/30 bg-blue-500/5"
              : ""
      }`}
      data-testid={`card-adversary-finding-${finding.category}`}
    >
      <div className="flex items-start gap-2 flex-wrap">
        <Badge
          {...confidenceBadge}
          data-testid="badge-adversary-confidence"
        >
          {finding.confidence}
        </Badge>
        {!finding.groundTruthAvailable && (
          <Badge variant="outline" className="text-[10px]" data-testid="badge-adversary-no-ground-truth">
            limited ground truth
          </Badge>
        )}
        <p className="text-sm flex-1">
          {renderSourceNote(finding.narrative)}
        </p>
      </div>

      {(finding.addresses.length > 0 || finding.txids.length > 0) && (
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" data-testid="button-toggle-adversary-details">
              <ChevronDown
                className={`h-3 w-3 mr-1 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
              {expanded ? "Hide" : "Show"} Details
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-2 mt-2 pl-2 border-l-2 border-muted">
              {finding.addresses.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Addresses:</span>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1">
                    {finding.addresses.slice(0, 10).map((addr) => (
                      <AddressLink key={addr} address={addr} />
                    ))}
                    {finding.addresses.length > 10 && (
                      <span className="text-xs text-muted-foreground">
                        +{finding.addresses.length - 10} more
                      </span>
                    )}
                  </div>
                </div>
              )}
              {finding.txids.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Transactions:</span>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1">
                    {finding.txids.slice(0, 6).map((txid) => (
                      <TxidLink key={txid} txid={txid} />
                    ))}
                    {finding.txids.length > 6 && (
                      <span className="text-xs text-muted-foreground">
                        +{finding.txids.length - 6} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function ContextMergeRow({ warning }: { warning: ContextMergeWarning }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="border border-amber-500/30 bg-amber-500/5 rounded-md p-3 space-y-2"
      data-testid="card-context-merge-warning"
    >
      <div className="flex items-start gap-2 flex-wrap">
        {warning.hasUnknownContext && (
          <Badge variant="outline" className="text-[10px] border-amber-500/50" data-testid="badge-partial-context">
            partial context
          </Badge>
        )}
        <p className="text-sm flex-1">
          {renderSourceNote(warning.narrative)}
        </p>
      </div>

      {warning.contexts.length > 0 && (
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" data-testid="button-toggle-merge-details">
              <ChevronDown
                className={`h-3 w-3 mr-1 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
              {expanded ? "Hide" : "Show"} Inputs
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 space-y-1 pl-2 border-l-2 border-muted">
              {warning.contexts.map((c, i) => (
                <div key={i} className="flex items-center gap-2 flex-wrap">
                  <AddressLink address={c.address} />
                  {(c.counterpartyName || c.acquisitionMethod) ? (
                    <Badge variant="secondary" className="text-[10px]" data-testid="badge-context-label">
                      {c.counterpartyName ?? c.acquisitionMethod}
                    </Badge>
                  ) : (
                    <span className="text-[11px] text-muted-foreground italic">unlabeled</span>
                  )}
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

export function AdversaryViewPanel({
  running,
  statusMessage,
  result,
  cancelled = false,
  onCancel,
}: {
  running: boolean;
  statusMessage: string;
  result: AdversaryViewResult | null;
  cancelled?: boolean;
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    exposure: true,
    separation: false,
    confusion: false,
    context: false,
  });

  const toggleSection = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  if (!running && !result && !cancelled) return null;

  const { summary } = result ?? {
    summary: {
      exposureCount: 0,
      separationCount: 0,
      confusionCount: 0,
      contextMergeCount: 0,
      addressesExposed: 0,
      addressesSeparated: 0,
    },
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="container-adversary-view">
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 py-3 px-4">
            <div className="flex items-center gap-2 flex-wrap">
              <ScanSearch className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="font-medium text-sm" data-testid="text-adversary-view-title">
                Adversary View
              </span>
              <span className="text-xs text-muted-foreground">
                blind chain-analysis comparison
              </span>
              {running && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {statusMessage || "Running\u2026"}
                </span>
              )}
              {running && onCancel && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancel();
                  }}
                  data-testid="button-cancel-adversary-view"
                >
                  <X className="h-3 w-3 mr-1" />
                  Cancel
                </Button>
              )}
              {cancelled && !running && !result && (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="text-adversary-cancelled"
                >
                  Cancelled — adversary analysis was stopped before completing.
                </span>
              )}
              {result && !running && (
                <div className="flex items-center gap-1 flex-wrap">
                  {summary.exposureCount > 0 && (
                    <Badge
                      className="bg-red-500 text-white no-default-hover-elevate no-default-active-elevate"
                      data-testid="badge-adversary-exposure-count"
                    >
                      <ShieldAlert className="h-3 w-3 mr-1" />
                      {summary.exposureCount} exposure{summary.exposureCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                  {summary.confusionCount > 0 && (
                    <Badge
                      className="bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate"
                      data-testid="badge-adversary-confusion-count"
                    >
                      <Shuffle className="h-3 w-3 mr-1" />
                      {summary.confusionCount} confusion{summary.confusionCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                  {summary.separationCount > 0 && (
                    <Badge
                      className="bg-green-600 text-white no-default-hover-elevate no-default-active-elevate"
                      data-testid="badge-adversary-separation-count"
                    >
                      <ShieldCheck className="h-3 w-3 mr-1" />
                      {summary.separationCount} separation{summary.separationCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                  {summary.contextMergeCount > 0 && (
                    <Badge
                      className="bg-amber-500 text-white no-default-hover-elevate no-default-active-elevate"
                      data-testid="badge-adversary-context-merge-count"
                    >
                      <Merge className="h-3 w-3 mr-1" />
                      {summary.contextMergeCount} context merge{summary.contextMergeCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>
              )}
            </div>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ${
                open ? "rotate-180" : ""
              }`}
            />
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 pb-4 px-4 space-y-4">

            {running && !result && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                <span data-testid="text-adversary-status">{statusMessage || "Analyzing\u2026"}</span>
              </div>
            )}

            {result && (
              <>
                {result.degradation && (
                  <div
                    className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
                    data-testid="banner-adversary-degradation"
                  >
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground">
                      {result.degradation.message}
                    </p>
                  </div>
                )}

                <div
                  className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center"
                  data-testid="container-adversary-summary"
                >
                  <div>
                    <div
                      className="text-xl font-bold text-red-500"
                      data-testid="text-adversary-stat-exposure"
                    >
                      {summary.addressesExposed}
                    </div>
                    <div className="text-[11px] text-muted-foreground">Addresses Exposed</div>
                  </div>
                  <div>
                    <div
                      className="text-xl font-bold text-green-600"
                      data-testid="text-adversary-stat-separated"
                    >
                      {summary.addressesSeparated}
                    </div>
                    <div className="text-[11px] text-muted-foreground">Addresses Separated</div>
                  </div>
                  <div>
                    <div
                      className="text-xl font-bold text-blue-500"
                      data-testid="text-adversary-stat-confusion"
                    >
                      {summary.confusionCount}
                    </div>
                    <div className="text-[11px] text-muted-foreground">Confusion Events</div>
                  </div>
                  <div>
                    <div
                      className="text-xl font-bold text-amber-500"
                      data-testid="text-adversary-stat-context"
                    >
                      {summary.contextMergeCount}
                    </div>
                    <div className="text-[11px] text-muted-foreground">Context Merges</div>
                  </div>
                </div>

                {result.exposureFindings.length > 0 && (
                  <Collapsible
                    open={openSections.exposure}
                    onOpenChange={() => toggleSection("exposure")}
                  >
                    <CollapsibleTrigger asChild>
                      <div
                        className="flex items-center justify-between cursor-pointer py-1.5"
                        data-testid="trigger-adversary-section-exposure"
                      >
                        <div className="flex items-center gap-2">
                          <ShieldAlert className="h-4 w-4 text-red-500" />
                          <span className="text-sm font-medium text-red-700 dark:text-red-400">
                            Exposure
                          </span>
                          <Badge
                            className="bg-red-500 text-white no-default-hover-elevate no-default-active-elevate"
                            data-testid="badge-section-exposure-count"
                          >
                            {result.exposureFindings.length}
                          </Badge>
                        </div>
                        <ChevronDown
                          className={`h-3 w-3 text-muted-foreground transition-transform ${
                            openSections.exposure ? "rotate-180" : ""
                          }`}
                        />
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="text-xs text-muted-foreground mb-2">
                        The adversary can cluster these addresses as belonging to the same wallet using
                        the common-input-ownership (CIO) heuristic.
                      </p>
                      <div className="space-y-2">
                        {result.exposureFindings.map((f, i) => (
                          <AdversaryFindingRow key={i} finding={f} />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {result.separationFindings.length > 0 && (
                  <Collapsible
                    open={openSections.separation}
                    onOpenChange={() => toggleSection("separation")}
                  >
                    <CollapsibleTrigger asChild>
                      <div
                        className="flex items-center justify-between cursor-pointer py-1.5"
                        data-testid="trigger-adversary-section-separation"
                      >
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-4 w-4 text-green-600" />
                          <span className="text-sm font-medium text-green-700 dark:text-green-400">
                            Preserved Separations
                          </span>
                          <Badge
                            className="bg-green-600 text-white no-default-hover-elevate no-default-active-elevate"
                            data-testid="badge-section-separation-count"
                          >
                            {result.separationFindings.length}
                          </Badge>
                        </div>
                        <ChevronDown
                          className={`h-3 w-3 text-muted-foreground transition-transform ${
                            openSections.separation ? "rotate-180" : ""
                          }`}
                        />
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="text-xs text-muted-foreground mb-2">
                        These wallet groups have never been publicly co-spent. The adversary cannot
                        link them — their separation is preserved on-chain.
                      </p>
                      <div className="space-y-2">
                        {result.separationFindings.map((f, i) => (
                          <AdversaryFindingRow key={i} finding={f} />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {result.confusionFindings.length > 0 && (
                  <Collapsible
                    open={openSections.confusion}
                    onOpenChange={() => toggleSection("confusion")}
                  >
                    <CollapsibleTrigger asChild>
                      <div
                        className="flex items-center justify-between cursor-pointer py-1.5"
                        data-testid="trigger-adversary-section-confusion"
                      >
                        <div className="flex items-center gap-2">
                          <Shuffle className="h-4 w-4 text-blue-500" />
                          <span className="text-sm font-medium text-blue-700 dark:text-blue-400">
                            Protective Confusion
                          </span>
                          <Badge
                            className="bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate"
                            data-testid="badge-section-confusion-count"
                          >
                            {result.confusionFindings.length}
                          </Badge>
                        </div>
                        <ChevronDown
                          className={`h-3 w-3 text-muted-foreground transition-transform ${
                            openSections.confusion ? "rotate-180" : ""
                          }`}
                        />
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="text-xs text-muted-foreground mb-2">
                        Transactions where the adversary&apos;s change-output heuristic (smaller output
                        = change) contradicts your ground truth, actively misleading their analysis.
                      </p>
                      <div className="space-y-2">
                        {result.confusionFindings.map((f, i) => (
                          <AdversaryFindingRow key={i} finding={f} />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {result.contextMergeWarnings.length > 0 && (
                  <Collapsible
                    open={openSections.context}
                    onOpenChange={() => toggleSection("context")}
                  >
                    <CollapsibleTrigger asChild>
                      <div
                        className="flex items-center justify-between cursor-pointer py-1.5"
                        data-testid="trigger-adversary-section-context"
                      >
                        <div className="flex items-center gap-2">
                          <Merge className="h-4 w-4 text-amber-500" />
                          <span className="text-sm font-medium text-amber-700 dark:text-amber-400">
                            Context Merge Warnings
                          </span>
                          <Badge
                            className="bg-amber-500 text-white no-default-hover-elevate no-default-active-elevate"
                            data-testid="badge-section-context-count"
                          >
                            {result.contextMergeWarnings.length}
                          </Badge>
                        </div>
                        <ChevronDown
                          className={`h-3 w-3 text-muted-foreground transition-transform ${
                            openSections.context ? "rotate-180" : ""
                          }`}
                        />
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="text-xs text-muted-foreground mb-2">
                        Transactions that combine coins from different acquisition contexts. A chain
                        analyst can now link those financial histories together.
                      </p>
                      <div className="space-y-2">
                        {result.contextMergeWarnings.map((w, i) => (
                          <ContextMergeRow key={i} warning={w} />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {summary.exposureCount === 0 &&
                  summary.confusionCount === 0 &&
                  summary.contextMergeCount === 0 && (
                    <div
                      className="flex items-center gap-2 py-2 text-sm text-green-700 dark:text-green-400"
                      data-testid="text-adversary-all-clear"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      No chain-analysis exposure detected. Separation preserved across all wallet groups.
                    </div>
                  )}
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
