import { useState, useEffect, Fragment } from "react";
import {
  Loader2,
  List,
  GitBranch,
  TrendingDown,
  Check,
  Copy,
  ScanSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { useSettings, updatePeelChainViewMode } from "@/hooks/use-settings";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { getParticipantsByTxids } from "@/lib/data/transaction-crud";
import type { TransactionParticipant } from "@/lib/database";
import { DeepDiveDialog } from "./transaction-deep-dive";

export interface PeelStep {
  txid: string;
  carriedIn: number;
  payment: number;
  paymentAddress: string;
  change: number;
  changeAddress: string;
}

export const PEEL_PAYMENT_COLOR = "hsl(var(--chart-5))";
export const PEEL_CHANGE_COLOR = "hsl(var(--chart-2))";
export const PEEL_COINJOIN_COLOR = "hsl(var(--chart-4))";

export function shortPeelAddr(a: string): string {
  if (!a || a === "—") return "—";
  return a.length > 16 ? `${a.slice(0, 7)}…${a.slice(-5)}` : a;
}

export function shortPeelTxid(t: string): string {
  return t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t;
}

function PeelChainGraph({ steps, coinjoinTxids }: { steps: PeelStep[]; coinjoinTxids: Set<string> }) {
  const { openRecordPreviewByAddress } = useRecordPreview();
  const { copy, isCopied } = useCopyToClipboard(1500);
  const [deepDiveTxid, setDeepDiveTxid] = useState<string | null>(null);
  const marginTop = 36;
  const hopGap = 150;
  const txX = 92;
  const payX = 300;
  const svgWidth = 440;
  const svgHeight = marginTop + steps.length * hopGap + 24;
  const fmt = (sats: number) => `${(sats / 1e8).toFixed(6)} BTC`;

  const txY = (i: number) => marginTop + i * hopGap;
  const changeY = (i: number) => txY(i) + hopGap / 2;

  const openNode = (value: string) => {
    if (!value || value === "—") return;
    void openRecordPreviewByAddress(value);
  };
  const onNodeKeyDown = (e: React.KeyboardEvent, value: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openNode(value);
    }
  };
  const copyAddr = (value: string) => {
    if (!value || value === "—") return;
    copy(value, { label: "Address" });
  };
  const onCopyKeyDown = (e: React.KeyboardEvent, value: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      void copyAddr(value);
    }
  };

  return (
    <div className="space-y-3" data-testid="container-peel-graph">
      <p className="text-xs text-muted-foreground">
        Each hop peels off a payment to an external address and forwards the remaining change to a fresh address,
        which becomes the input to the next transaction. This forms a traceable chain of {steps.length} transactions.
      </p>
      <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ backgroundColor: PEEL_PAYMENT_COLOR }} />
          Payment out
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ backgroundColor: PEEL_CHANGE_COLOR }} />
          Change forwarded
        </span>
        <span className="inline-flex items-center gap-1.5" data-testid="legend-peel-coinjoin">
          <span
            className="inline-block h-3 w-3 rounded-full border-2 bg-transparent"
            style={{ borderColor: PEEL_COINJOIN_COLOR }}
          />
          <span aria-hidden="true" style={{ color: PEEL_COINJOIN_COLOR }}>⇄</span>
          CoinJoin (mixing) hop
        </span>
      </div>
      <div className="overflow-auto rounded-md border" style={{ maxHeight: 520 }}>
        <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="block"
          role="img"
          aria-label={`Peel chain graph of ${steps.length} transactions`}
        >
          <defs>
            <marker
              id="peel-arrow-payment"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={PEEL_PAYMENT_COLOR} />
            </marker>
            <marker
              id="peel-arrow-change"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={PEEL_CHANGE_COLOR} />
            </marker>
          </defs>

          {steps.map((step, i) => {
            const ty = txY(i);
            const cy = changeY(i);
            const nextTy = txY(i + 1);
            const isLast = i === steps.length - 1;
            return (
              <Fragment key={`edges-${step.txid}`}>
                <line
                  x1={txX + 20}
                  y1={ty}
                  x2={payX - 12}
                  y2={ty}
                  stroke={PEEL_PAYMENT_COLOR}
                  strokeWidth={1.5}
                  markerEnd="url(#peel-arrow-payment)"
                />
                <text
                  x={(txX + 20 + payX - 12) / 2}
                  y={ty - 6}
                  textAnchor="middle"
                  className="font-mono"
                  fontSize={9}
                  fill="hsl(var(--foreground))"
                >
                  {fmt(step.payment)}
                </text>
                <line
                  x1={txX}
                  y1={ty + 20}
                  x2={txX}
                  y2={cy - 10}
                  stroke={PEEL_CHANGE_COLOR}
                  strokeWidth={1.5}
                  markerEnd="url(#peel-arrow-change)"
                />
                <text
                  x={txX + 8}
                  y={(ty + 20 + cy - 10) / 2 + 3}
                  className="font-mono"
                  fontSize={9}
                  fill="hsl(var(--foreground))"
                >
                  {fmt(step.change)}
                </text>
                {!isLast && (
                  <line
                    x1={txX}
                    y1={cy + 10}
                    x2={txX}
                    y2={nextTy - 20}
                    stroke={PEEL_CHANGE_COLOR}
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    markerEnd="url(#peel-arrow-change)"
                  />
                )}
              </Fragment>
            );
          })}

          {steps.map((step, i) => {
            const ty = txY(i);
            const cy = changeY(i);
            const isLast = i === steps.length - 1;
            const isCoinJoin = coinjoinTxids.has(step.txid);
            return (
              <Fragment key={`nodes-${step.txid}`}>
                <g
                  data-testid={`graph-tx-${i}`}
                  data-coinjoin={isCoinJoin ? "true" : undefined}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80"
                  onClick={() => openNode(step.txid)}
                  onKeyDown={(e) => onNodeKeyDown(e, step.txid)}
                >
                  <title>{`Hop ${i + 1} — ${step.txid}\nin ${fmt(step.carriedIn)}${isCoinJoin ? "\n⇄ CoinJoin (mixing) hop" : ""}\nClick to view transaction`}</title>
                  {isCoinJoin && (
                    <circle
                      cx={txX}
                      cy={ty}
                      r={24}
                      fill="none"
                      stroke={PEEL_COINJOIN_COLOR}
                      strokeWidth={2}
                    />
                  )}
                  <circle cx={txX} cy={ty} r={20} fill="hsl(var(--primary))" />
                  <text
                    x={txX}
                    y={ty + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill="hsl(var(--primary-foreground))"
                  >
                    {`H${i + 1}`}
                  </text>
                  <g
                    transform={`translate(${txX + 12}, ${ty - 20})`}
                    role="button"
                    tabIndex={0}
                    style={{ cursor: "pointer" }}
                    aria-label={`Deep dive into hop ${i + 1} transaction`}
                    data-testid={`button-graph-deep-dive-${i}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeepDiveTxid(step.txid);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        setDeepDiveTxid(step.txid);
                      }
                    }}
                  >
                    <title>{`Deep dive into hop ${i + 1}`}</title>
                    <circle r={8} fill="hsl(var(--background))" stroke="hsl(var(--primary))" strokeWidth={1.5} />
                    <ScanSearch x={-5} y={-5} width={10} height={10} color="hsl(var(--primary))" />
                  </g>
                  {isCoinJoin && (
                    <g transform={`translate(${txX - 12}, ${ty - 20})`} data-testid={`graph-coinjoin-${i}`}>
                      <circle r={8} fill={PEEL_COINJOIN_COLOR} />
                      <text
                        textAnchor="middle"
                        y={3.5}
                        fontSize={10}
                        fontWeight={700}
                        fill="hsl(var(--background))"
                      >
                        ⇄
                      </text>
                    </g>
                  )}
                  <text
                    x={txX}
                    y={ty + 34}
                    textAnchor="middle"
                    className="font-mono"
                    fontSize={9}
                    fill="hsl(var(--muted-foreground))"
                  >
                    {shortPeelTxid(step.txid)}
                  </text>
                </g>

                <g
                  data-testid={`graph-payment-${i}`}
                  role="button"
                  tabIndex={step.paymentAddress === "—" ? -1 : 0}
                  className={step.paymentAddress === "—" ? undefined : "cursor-pointer outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80"}
                  onClick={() => openNode(step.paymentAddress)}
                  onKeyDown={(e) => onNodeKeyDown(e, step.paymentAddress)}
                >
                  <title>{`Payment → ${step.paymentAddress}\n${fmt(step.payment)}${step.paymentAddress === "—" ? "" : "\nClick to view address"}`}</title>
                  <circle
                    cx={payX}
                    cy={ty}
                    r={10}
                    fill="hsl(var(--background))"
                    stroke={PEEL_PAYMENT_COLOR}
                    strokeWidth={2}
                  />
                  <text
                    x={payX + 16}
                    y={ty + 3}
                    className="font-mono"
                    fontSize={9}
                    fill="hsl(var(--foreground))"
                  >
                    {shortPeelAddr(step.paymentAddress)}
                  </text>
                  {step.paymentAddress !== "—" && (
                    <g
                      transform={`translate(${payX + 10}, ${ty - 12})`}
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      aria-label={`Copy payment address for hop ${i + 1}`}
                      data-testid={`button-graph-copy-payment-${i}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyAddr(step.paymentAddress);
                      }}
                      onKeyDown={(e) => onCopyKeyDown(e, step.paymentAddress)}
                    >
                      <title>{`Copy ${step.paymentAddress}`}</title>
                      <circle r={7} fill="hsl(var(--background))" stroke={PEEL_PAYMENT_COLOR} strokeWidth={1.5} />
                      {isCopied(step.paymentAddress) ? (
                        <Check x={-4} y={-4} width={8} height={8} color={PEEL_PAYMENT_COLOR} />
                      ) : (
                        <Copy x={-4} y={-4} width={8} height={8} color={PEEL_PAYMENT_COLOR} />
                      )}
                    </g>
                  )}
                </g>

                <g
                  data-testid={`graph-change-${i}`}
                  role="button"
                  tabIndex={step.changeAddress === "—" ? -1 : 0}
                  className={step.changeAddress === "—" ? undefined : "cursor-pointer outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80"}
                  onClick={() => openNode(step.changeAddress)}
                  onKeyDown={(e) => onNodeKeyDown(e, step.changeAddress)}
                >
                  <title>{`Change → ${step.changeAddress}\n${fmt(step.change)}${isLast ? "" : "\nspent by next hop"}${step.changeAddress === "—" ? "" : "\nClick to view address"}`}</title>
                  <circle
                    cx={txX}
                    cy={cy}
                    r={10}
                    fill="hsl(var(--background))"
                    stroke={PEEL_CHANGE_COLOR}
                    strokeWidth={2}
                  />
                  <text
                    x={txX + 16}
                    y={cy + 3}
                    className="font-mono"
                    fontSize={9}
                    fill="hsl(var(--foreground))"
                  >
                    {shortPeelAddr(step.changeAddress)}
                  </text>
                  {step.changeAddress !== "—" && (
                    <g
                      transform={`translate(${txX + 10}, ${cy - 12})`}
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      aria-label={`Copy change address for hop ${i + 1}`}
                      data-testid={`button-graph-copy-change-${i}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyAddr(step.changeAddress);
                      }}
                      onKeyDown={(e) => onCopyKeyDown(e, step.changeAddress)}
                    >
                      <title>{`Copy ${step.changeAddress}`}</title>
                      <circle r={7} fill="hsl(var(--background))" stroke={PEEL_CHANGE_COLOR} strokeWidth={1.5} />
                      {isCopied(step.changeAddress) ? (
                        <Check x={-4} y={-4} width={8} height={8} color={PEEL_CHANGE_COLOR} />
                      ) : (
                        <Copy x={-4} y={-4} width={8} height={8} color={PEEL_CHANGE_COLOR} />
                      )}
                    </g>
                  )}
                </g>
              </Fragment>
            );
          })}
        </svg>
      </div>
      {deepDiveTxid && (
        <DeepDiveDialog
          key={deepDiveTxid}
          txid={deepDiveTxid}
          coinjoinTxids={coinjoinTxids}
          open
          onOpenChange={(o) => {
            if (!o) setDeepDiveTxid(null);
          }}
          showTrigger={false}
        />
      )}
    </div>
  );
}

export function PeelChainView({ txids, changeAddresses, coinjoinTxids }: { txids: string[]; changeAddresses: string[]; coinjoinTxids: Set<string> }) {
  const [loading, setLoading] = useState(true);
  const [steps, setSteps] = useState<PeelStep[]>([]);
  const { peelChainViewMode } = useSettings();
  const viewMode = peelChainViewMode;
  const setViewMode = (mode: "graph" | "list") => {
    void updatePeelChainViewMode(mode);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const changeSet = new Set(changeAddresses);
        const parts = await getParticipantsByTxids(txids);
        const byTxid = new Map<string, TransactionParticipant[]>();
        for (const p of parts) {
          const list = byTxid.get(p.txid);
          if (list) list.push(p);
          else byTxid.set(p.txid, [p]);
        }
        const built: PeelStep[] = [];
        for (const txid of txids) {
          const tp = byTxid.get(txid) ?? [];
          const inputs = tp.filter(p => p.role === "input");
          const outputs = tp.filter(p => p.role === "output");
          const carriedIn = inputs.reduce((s, p) => s + p.amount, 0);
          let changeOut = outputs.find(p => changeSet.has(p.address));
          let paymentOut = outputs.find(p => p !== changeOut);
          if (!changeOut && outputs.length === 2) {
            const sorted = [...outputs].sort((a, b) => a.amount - b.amount);
            changeOut = sorted[0];
            paymentOut = sorted[1];
          }
          built.push({
            txid,
            carriedIn,
            payment: paymentOut?.amount ?? 0,
            paymentAddress: paymentOut?.address ?? "—",
            change: changeOut?.amount ?? 0,
            changeAddress: changeOut?.address ?? "—",
          });
        }
        if (!cancelled) setSteps(built);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [txids, changeAddresses]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" data-testid="status-peel-chain-loading">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="container-peel-chain">
      <div className="flex justify-end">
        <div className="inline-flex rounded-md border p-0.5 gap-0.5">
          <Button
            type="button"
            size="sm"
            variant={viewMode === "graph" ? "secondary" : "ghost"}
            onClick={() => setViewMode("graph")}
            data-testid="button-peel-view-graph"
          >
            <GitBranch className="h-4 w-4" />
            Graph
          </Button>
          <Button
            type="button"
            size="sm"
            variant={viewMode === "list" ? "secondary" : "ghost"}
            onClick={() => setViewMode("list")}
            data-testid="button-peel-view-list"
          >
            <List className="h-4 w-4" />
            List
          </Button>
        </div>
      </div>
      {viewMode === "graph" ? (
        <PeelChainGraph steps={steps} coinjoinTxids={coinjoinTxids} />
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Each hop peels off a payment to an external address and forwards the remaining change to a fresh address,
            which becomes the input to the next transaction. This forms a traceable chain of {steps.length} transactions.
          </p>
          <div className="space-y-1">
            {steps.map((step, i) => (
              <Fragment key={step.txid}>
                <div
                  className="border rounded-md p-3 space-y-2"
                  data-testid={`card-peel-step-${i}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="font-mono">Hop {i + 1}</Badge>
                      <TxidLink txid={step.txid} />
                      <DeepDiveDialog txid={step.txid} coinjoinTxids={coinjoinTxids} />
                    </div>
                    <span className="text-xs text-muted-foreground font-mono">
                      in {(step.carriedIn / 1e8).toFixed(6)} BTC
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="bg-muted/40 rounded p-2">
                      <div className="text-xs font-medium text-muted-foreground mb-1">Payment out</div>
                      <div className="text-sm font-mono" data-testid={`text-peel-payment-${i}`}>
                        {(step.payment / 1e8).toFixed(6)} BTC
                      </div>
                      <div className="mt-1">
                        <AddressLink address={step.paymentAddress} truncate={false} />
                      </div>
                    </div>
                    <div className="bg-muted/40 rounded p-2">
                      <div className="text-xs font-medium text-muted-foreground mb-1">Change forwarded</div>
                      <div className="text-sm font-mono" data-testid={`text-peel-change-${i}`}>
                        {(step.change / 1e8).toFixed(6)} BTC
                      </div>
                      <div className="mt-1">
                        <AddressLink address={step.changeAddress} truncate={false} />
                      </div>
                    </div>
                  </div>
                </div>
                {i < steps.length - 1 && (
                  <div className="flex justify-center text-muted-foreground" aria-hidden="true">
                    <TrendingDown className="h-4 w-4" />
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
