import { useState, useCallback, useRef, useEffect } from "react";
import {
  Loader2,
  ChevronDown,
  ScanSearch,
  Info,
  RotateCw,
  Shuffle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sankey, Tooltip } from "recharts";
import { formatEntropy, type BoltzmannInput, type BoltzmannOutput } from "@/lib/boltzmann";
import type { BoltzmannResult } from "@/lib/boltzmann";
import { getTransactionByTxid, getParticipantsByTxids } from "@/lib/data/transaction-crud";
import type { TransactionParticipant } from "@/lib/database";
import { SANKEY_NODE_FILL, SANKEY_LINK_STROKE, buildSankey } from "./sankey-helpers";
import { BoltzmannHeatmap } from "./boltzmann-heatmap";

export const WORKER_IDLE_TEARDOWN_MS = 30_000;

export interface DeepDiveData {
  inputs: TransactionParticipant[];
  outputs: TransactionParticipant[];
  totalIn: number;
  totalOut: number;
  fee: number;
  isCoinJoin: boolean;
}

export function summariseError(raw: string): string {
  const firstLine = (raw || "").split("\n")[0].trim();
  if (!firstLine) return "Unknown error.";
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

export function TransactionDeepDive({
  txids,
  coinjoinTxids,
  autoAnalyse = false,
  embedded = false,
}: {
  txids: string[];
  coinjoinTxids: Set<string>;
  autoAnalyse?: boolean;
  embedded?: boolean;
}) {
  const [selectedTxid, setSelectedTxid] = useState<string>(txids[0] ?? "");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BoltzmannResult | null>(null);
  const [data, setData] = useState<DeepDiveData | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const [failCount, setFailCount] = useState(0);
  const [canRetry, setCanRetry] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const pendingIdRef = useRef<string | null>(null);
  const autoRunRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelIdleTeardown = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const scheduleIdleTeardown = useCallback(() => {
    cancelIdleTeardown();
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
    }, WORKER_IDLE_TEARDOWN_MS);
  }, [cancelIdleTeardown]);

  const analyse = useCallback(async (txid: string) => {
    if (!txid) return;
    cancelIdleTeardown();
    setLoading(true);
    setResult(null);
    setData(null);
    setMessage(null);
    setErrorDetail(null);
    setShowErrorDetail(false);
    setCanRetry(false);
    try {
      const tx = await getTransactionByTxid(txid);
      const participants = await getParticipantsByTxids([txid]);
      const inputs = participants.filter(p => p.role === "input");
      const outputs = participants.filter(p => p.role === "output");
      if (inputs.length === 0 || outputs.length === 0) {
        setMessage("No participant data available for this transaction — re-sync the address to load its inputs and outputs.");
        setLoading(false);
        if (workerRef.current) scheduleIdleTeardown();
        return;
      }

      const totalIn = inputs.reduce((s, p) => s + p.amount, 0);
      const totalOut = outputs.reduce((s, p) => s + p.amount, 0);
      const fee = tx?.fee != null ? Math.max(0, tx.fee) : Math.max(0, totalIn - totalOut);
      setData({ inputs, outputs, totalIn, totalOut, fee, isCoinJoin: coinjoinTxids.has(txid) });

      const bInputs: BoltzmannInput[] = inputs.map((p, i) => ({ index: i, address: p.address, amount: Math.round(p.amount) }));
      const bOutputs: BoltzmannOutput[] = outputs.map((p, i) => ({ index: i, address: p.address, amount: Math.round(p.amount) }));

      if (!workerRef.current) {
        workerRef.current = new Worker(
          new URL('../../lib/boltzmann.worker.ts', import.meta.url),
          { type: 'module' }
        );
      }
      const id = Math.random().toString(36).slice(2);
      pendingIdRef.current = id;
      const worker = workerRef.current;
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.id !== pendingIdRef.current) return;
        setResult(e.data.result ?? null);
        setLoading(false);
        scheduleIdleTeardown();
      };
      worker.onerror = (e: ErrorEvent) => {
        setMessage("Couldn't analyse this transaction — the calculation failed unexpectedly.");
        setErrorDetail(summariseError(e.message || "The analysis worker stopped unexpectedly."));
        setFailCount(c => c + 1);
        setCanRetry(true);
        setLoading(false);
        scheduleIdleTeardown();
      };
      worker.postMessage({ id, inputs: bInputs, outputs: bOutputs, fee });
    } catch (err) {
      setMessage("Couldn't load this transaction's data.");
      setErrorDetail(summariseError(err instanceof Error ? err.message : String(err)));
      setFailCount(c => c + 1);
      setCanRetry(true);
      setLoading(false);
      if (workerRef.current) scheduleIdleTeardown();
    }
  }, [coinjoinTxids, cancelIdleTeardown, scheduleIdleTeardown]);

  useEffect(() => {
    if (autoAnalyse && selectedTxid && !autoRunRef.current) {
      autoRunRef.current = true;
      analyse(selectedTxid);
    }
  }, [autoAnalyse, selectedTxid, analyse]);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const prevTxidRef = useRef(selectedTxid);
  useEffect(() => {
    if (prevTxidRef.current === selectedTxid) return;
    prevTxidRef.current = selectedTxid;
    setResult(null);
    setData(null);
    setMessage(null);
    setErrorDetail(null);
    setShowErrorDetail(false);
    setCanRetry(false);
    setFailCount(0);
  }, [selectedTxid]);

  if (txids.length === 0) return null;

  const sankey = data && data.isCoinJoin ? buildSankey(data.inputs, data.outputs) : null;
  const singleTxid = txids.length === 1;

  const body = (
    <>
        {!(embedded && singleTxid) && (
        <div className="flex flex-wrap gap-2 items-end">
          {!singleTxid && (
            <div className="space-y-1 min-w-[200px] flex-1">
              <label className="text-xs text-muted-foreground">Transaction</label>
              <Select value={selectedTxid} onValueChange={setSelectedTxid}>
                <SelectTrigger data-testid="select-deep-dive-txid">
                  <SelectValue placeholder="Select transaction" />
                </SelectTrigger>
                <SelectContent>
                  {txids.slice(0, 50).map(t => (
                    <SelectItem key={t} value={t}>
                      {coinjoinTxids.has(t) ? "⇄ " : ""}{t.substring(0, 20)}…
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button
            size="default"
            variant="outline"
            onClick={() => analyse(selectedTxid)}
            disabled={loading || !selectedTxid}
            data-testid="button-analyse-deep-dive"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ScanSearch className="h-4 w-4 mr-1" />}
            Analyse
          </Button>
        </div>
        )}

        {embedded && singleTxid && loading && !data && (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="status-deep-dive-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Analysing transaction…
          </div>
        )}

        {message && (
          <div
            className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground"
            data-testid="text-deep-dive-message"
          >
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-2 min-w-0">
              <span>{message}</span>
              {failCount >= 2 && (
                <p className="text-xs" data-testid="text-deep-dive-next-steps">
                  This has failed more than once. Try re-syncing the address to
                  refresh its data, then analyse again. If it keeps failing,
                  check the browser console for details and report the issue.
                </p>
              )}
              {errorDetail && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowErrorDetail(v => !v)}
                    className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                    data-testid="button-toggle-deep-dive-detail"
                  >
                    <ChevronDown
                      className={`h-3 w-3 transition-transform ${showErrorDetail ? "rotate-180" : ""}`}
                    />
                    {showErrorDetail ? "Hide details" : "Show details"}
                  </button>
                  {showErrorDetail && (
                    <p
                      className="mt-1 rounded bg-muted px-2 py-1 font-mono text-xs break-words"
                      data-testid="text-deep-dive-error-detail"
                    >
                      {errorDetail}
                    </p>
                  )}
                </div>
              )}
            </div>
            {canRetry && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => analyse(selectedTxid)}
                disabled={loading || !selectedTxid}
                data-testid="button-retry-deep-dive"
              >
                <RotateCw className="h-4 w-4 mr-1" />
                Retry
              </Button>
            )}
          </div>
        )}

        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="container-deep-dive-summary">
            <div className="bg-muted/40 rounded-md p-2 text-center">
              <div className="text-base font-bold" data-testid="text-deep-dive-inputs">{data.inputs.length}</div>
              <div className="text-xs text-muted-foreground">Inputs</div>
            </div>
            <div className="bg-muted/40 rounded-md p-2 text-center">
              <div className="text-base font-bold" data-testid="text-deep-dive-outputs">{data.outputs.length}</div>
              <div className="text-xs text-muted-foreground">Outputs</div>
            </div>
            <div className="bg-muted/40 rounded-md p-2 text-center">
              <div className="text-base font-bold" data-testid="text-deep-dive-total">{(data.totalIn / 1e8).toFixed(4)}</div>
              <div className="text-xs text-muted-foreground">BTC In</div>
            </div>
            <div className="bg-muted/40 rounded-md p-2 text-center">
              <div className="text-base font-bold" data-testid="text-deep-dive-fee">{data.fee.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Fee (sats)</div>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-3" data-testid="container-boltzmann-result">
            {result.tooComplex ? (
              <p className="text-sm text-muted-foreground">
                This transaction has too many inputs/outputs for exact Boltzmann analysis (max 8×8). Results would require exponential computation.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-muted/40 rounded-md p-2 text-center">
                    <div className="text-base font-bold" data-testid="text-boltzmann-entropy">
                      {formatEntropy(result.entropy)}
                    </div>
                    <div className="text-xs text-muted-foreground">Entropy</div>
                  </div>
                  <div className="bg-muted/40 rounded-md p-2 text-center">
                    <div className="text-base font-bold" data-testid="text-boltzmann-interpretations">
                      {result.interpretationCount.toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground">Interpretations</div>
                  </div>
                  <div className="bg-muted/40 rounded-md p-2 text-center">
                    <div className="text-base font-bold" data-testid="text-boltzmann-efficiency">
                      {result.maxEntropy > 0 ? `${(result.efficiency * 100).toFixed(0)}%` : "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">Efficiency</div>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">{result.entropyLabel}.</span>{" "}
                  {result.entropy === 0
                    ? "Every input-to-output link is deterministic — any observer can trace funds exactly."
                    : result.entropy < 4
                    ? "Low entropy means most input-output links are highly probable."
                    : "Higher entropy means more valid interpretations, making tracing harder."}
                </p>

                {result.linkMatrix.length > 0 && (
                  <BoltzmannHeatmap linkMatrix={result.linkMatrix} />
                )}
              </>
            )}
          </div>
        )}

        {sankey && sankey.links.length > 0 && (
          <div className="space-y-2" data-testid="container-coinjoin-sankey">
            <div className="flex items-center gap-2">
              <Shuffle className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-xs font-medium">CoinJoin Fund-Flow</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              How inputs flow to outputs in this CoinJoin. Equal output sizes make linkage ambiguous.
            </p>
            <div className="overflow-x-auto">
              <Sankey
                width={560}
                height={Math.max(160, sankey.nodes.length * 22)}
                data={sankey}
                nodePadding={8}
                nodeWidth={12}
                iterations={32}
                node={{ fill: SANKEY_NODE_FILL, fillOpacity: 1 }}
                link={{ stroke: SANKEY_LINK_STROKE, strokeOpacity: 1 }}
              >
                <Tooltip
                  formatter={(value: number) => [`${(value / 1e8).toFixed(8)} BTC`, "Flow"]}
                />
              </Sankey>
            </div>
          </div>
        )}
    </>
  );

  if (embedded) {
    return (
      <div className="space-y-3" data-testid="container-transaction-deep-dive">
        {body}
      </div>
    );
  }

  return (
    <Card data-testid="container-transaction-deep-dive">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <ScanSearch className="h-4 w-4" />
          Transaction Deep-Dive
        </CardTitle>
        <CardDescription className="text-xs">
          Pick any flagged transaction for a forensic breakdown: Boltzmann entropy, a color-coded link-probability
          heatmap, and — for CoinJoins — a fund-flow Sankey diagram. Runs entirely offline.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {body}
      </CardContent>
    </Card>
  );
}

export function DeepDiveDialog({
  txid,
  coinjoinTxids,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  showTrigger = true,
}: {
  txid: string;
  coinjoinTxids: Set<string>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled ? (controlledOnOpenChange ?? (() => {})) : setInternalOpen;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {showTrigger && (
        <DialogTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            title="Deep dive"
            aria-label="Deep dive into this transaction"
            data-testid={`button-deep-dive-${txid.slice(0, 8)}`}
          >
            <ScanSearch className="h-3 w-3" />
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-deep-dive">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanSearch className="h-4 w-4" />
            Transaction Deep-Dive
          </DialogTitle>
          <DialogDescription className="font-mono break-all">
            {txid}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <TransactionDeepDive
            txids={[txid]}
            coinjoinTxids={coinjoinTxids}
            autoAnalyse
            embedded
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
