import { useState, useCallback, useMemo, Fragment, useRef, useEffect } from "react";
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
  TrendingDown,
  Activity,
  Repeat2,
  Layers,
  Lock,
  Shuffle,
  ArrowRightLeft,
  ArrowDown,
  CornerDownRight,
  Zap,
  Network,
  ScanSearch,
  Info,
  List,
  GitBranch,
  RotateCw,
  Download,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
  Sankey,
} from "recharts";
import { useLiveQuery } from "dexie-react-hooks";
import { renderSourceNote } from "@/lib/renderSourceNote";
import { beginBulkOperation, endBulkOperation, db } from "@/lib/database";
import type { Record as DbRecord, PrivacyAuditHistoryEntry, TransactionParticipant } from "@/lib/database";
import { addPrivacyAuditHistoryEntry, clearPrivacyAuditHistory } from "@/lib/data/privacy-history-crud";
import { buildPrivacyHistoryCsv, buildPrivacyHistoryPdf } from "@/lib/privacy-history-export";
import { formatScoreDelta } from "@/lib/privacy-report-export";
import { createTag } from "@/lib/data/vocabulary-crud";
import { updateRecord, countRecordsByType, getRecordsPageByTypeIdReverseKeyset, getRecordsByInputStrings } from "@/lib/data/record-crud";
import { getTransactionByTxid } from "@/lib/data/transaction-crud";
import { getParticipantsByTxids } from "@/lib/data/record-queries";
import { useSettings, updatePeelChainViewMode, updateShowScoreBreakdown } from "@/hooks/use-settings";
import { useTags } from "@/hooks/use-tags";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useToast } from "@/hooks/use-toast";
import { ClickableAddress } from "@/components/ClickableAddress";
import { TxidLink } from "@/components/TxidLink";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import {
  runPrivacyAudit,
  PRIVACY_TAG_MAP,
  PRIVACY_TAG_NAMES,
  FINDING_TYPE_LABELS,
  PROXIMITY_FINDING_TYPES,
  getProximityTagName,
  getProximityTagColor,
  type PrivacyAuditResult,
  type PrivacyFinding,
  type EntityCitation,
  type PrivacyFindingType,
  type PrivacySeverity,
  type ScoreWaterfallEntry,
} from "@/lib/privacy-audit";
import { formatEntropy, type BoltzmannInput, type BoltzmannOutput } from "@/lib/boltzmann";
import type { BoltzmannResult } from "@/lib/boltzmann";

type ScanState = "idle" | "analyzing" | "tagging" | "complete";

const AUDIT_INPUT_BATCH = 1000;
const TAG_FETCH_BATCH = 500;

// Re-exported from the shared module so existing imports keep working. See
// client/src/lib/renderSourceNote.tsx for the implementation.
export { renderSourceNote };

// ─── Icon mapping ─────────────────────────────────────────────────────────────

const FINDING_TYPE_ICONS: Record<string, typeof Shield> = {
  SCRIPT_TYPE_MIXING: Fingerprint,
  DUST: AlertTriangle,
  DUST_SPENDING: AlertTriangle,
  CONSOLIDATION_ORIGIN: Combine,
  EXCHANGE_ORIGIN: Building2,
  TAINTED_UTXO_MERGE: Merge,
  ADDRESS_REUSE: Repeat2,
  ROUND_AMOUNT: Layers,
  COMMON_INPUT_OWNERSHIP: Network,
  UNNECESSARY_INPUT: Layers,
  RECURRING_PAYMENT: Repeat2,
  HIGH_ACTIVITY: Activity,
  COINBASE_ORIGIN: Zap,
  MULTISIG_ESCROW: Lock,
  OP_RETURN_METADATA: Info,
  UTXO_SET_EXPOSURE: Shield,
  COINJOIN_WHIRLPOOL: Shuffle,
  COINJOIN_WASABI: Shuffle,
  COINJOIN_JOINMARKET: Shuffle,
  POST_MIX_SPENDING: ArrowRightLeft,
  PEEL_CHAIN: TrendingDown,
  ENTITY_EXCHANGE: Building2,
  ENTITY_MIXER: Shuffle,
  ENTITY_DARKNET: ShieldAlert,
  ENTITY_MINING_POOL: Zap,
  ENTITY_GAMBLING: Activity,
  ENTITY_P2P: ArrowRightLeft,
  ENTITY_SCAM: ShieldAlert,
  PROXIMITY_EXCHANGE: Network,
  PROXIMITY_MIXER: Network,
  PROXIMITY_DARKNET: Network,
  PROXIMITY_MINING_POOL: Network,
  PROXIMITY_GAMBLING: Network,
  PROXIMITY_P2P: Network,
  PROXIMITY_SCAM: Network,
  FINGERPRINT_NVERSION: ScanSearch,
  FINGERPRINT_NLOCKTIME: ScanSearch,
  FINGERPRINT_RBF: ScanSearch,
  FINGERPRINT_BIP69: ScanSearch,
  FINGERPRINT_LOW_R: ScanSearch,
  FINGERPRINT_WITNESS_INCONSISTENCY: ScanSearch,
};

function getIcon(type: string): typeof Shield {
  return FINDING_TYPE_ICONS[type] ?? Shield;
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

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

// ─── Score gauge ──────────────────────────────────────────────────────────────

function gradeColor(grade: string): string {
  if (grade.startsWith("A")) return "text-green-600 dark:text-green-400";
  if (grade.startsWith("B")) return "text-blue-600 dark:text-blue-400";
  if (grade.startsWith("C")) return "text-yellow-600 dark:text-yellow-400";
  if (grade.startsWith("D")) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function scoreBarColor(score: number): string {
  if (score >= 80) return "#22c55e";
  if (score >= 60) return "#eab308";
  if (score >= 40) return "#f97316";
  return "#ef4444";
}

function ScoreGauge({ score, grade }: { score: number; grade: string }) {
  const color = scoreBarColor(score);
  return (
    <div className="flex flex-col items-center gap-2" data-testid="container-score-gauge">
      <div className="relative w-28 h-28 flex items-center justify-center">
        <svg viewBox="0 0 100 100" className="w-28 h-28 -rotate-90">
          <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="10" className="text-muted/30" />
          <circle
            cx="50" cy="50" r="42" fill="none"
            stroke={color} strokeWidth="10"
            strokeDasharray={`${(score / 100) * 264} 264`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-3xl font-bold ${gradeColor(grade)}`} data-testid="text-privacy-grade">{grade}</span>
          <span className="text-xs text-muted-foreground">{score}/100</span>
        </div>
      </div>
      <span className="text-xs text-muted-foreground text-center">Privacy Score</span>
    </div>
  );
}

// ─── Score waterfall chart ────────────────────────────────────────────────────

function WaterfallChart({ entries }: { entries: ScoreWaterfallEntry[] }) {
  if (entries.length <= 1) return null;

  const chartData = entries.map(e => ({
    name: e.count > 1 ? `${e.label} ×${e.count}` : e.label,
    delta: e.delta,
    running: e.runningScore,
    fill: e.delta < 0 ? "#ef4444" : e.delta > 0 ? "#22c55e" : "#64748b",
    label: e.label,
  }));

  return (
    <div data-testid="container-waterfall-chart">
      <h3 className="text-sm font-medium mb-2">Score Breakdown</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 60 }}>
          <XAxis
            dataKey="name"
            tick={{ fontSize: 9 }}
            angle={-45}
            textAnchor="end"
            interval={0}
          />
          <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
          <Tooltip
            formatter={(value: number, _name: string, entry: { payload?: { label: string; delta: number; running: number } }) => {
              const payload = entry.payload;
              if (!payload) return [value];
              if (payload.delta === 0) return [`Score: ${payload.running}`, payload.label];
              return [
                `Δ ${payload.delta > 0 ? "+" : ""}${payload.delta} → ${payload.running}`,
                payload.label,
              ];
            }}
            contentStyle={{ fontSize: 11 }}
          />
          <ReferenceLine y={80} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.5} />
          <ReferenceLine y={60} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.5} />
          <Bar dataKey="running" maxBarSize={32}>
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="text-xs text-muted-foreground mt-1">
        Each bar shows the running score after each finding type is applied.
      </p>
    </div>
  );
}

// ─── Boltzmann heatmap ────────────────────────────────────────────────────────

export function probColor(p: number): string {
  // 0 = green (hsl 130), 0.5 = yellow (hsl 65), 1 = red (hsl 0)
  const hue = Math.round(130 - p * 130);
  const sat = 70;
  const lit = 42;
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

// Convert an "hsl(H, S%, L%)" string to [r, g, b] (0–255).
function hslStringToRgb(hsl: string): [number, number, number] {
  const m = /hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/.exec(hsl);
  if (!m) throw new Error(`unsupported color: ${hsl}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}

// WCAG relative luminance of an [r, g, b] color (0–255 per channel).
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

// WCAG contrast ratio between two colors (1–21).
export function contrastRatio(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Pick the legible text color (white or black) for a filled heatmap cell.
// The green/yellow end of probColor() is perceptually light, so white text on
// it falls well below WCAG AA; choosing whichever of white/black has the higher
// contrast keeps every cell legible (and is theme-independent, so it reads the
// same in light and dark mode).
export function cellTextColor(p: number): string {
  const bg = hslStringToRgb(probColor(p));
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  return contrastRatio(bg, white) >= contrastRatio(bg, black)
    ? "#ffffff"
    : "#000000";
}

function BoltzmannHeatmap({ linkMatrix }: { linkMatrix: BoltzmannResult["linkMatrix"] }) {
  const inputCount  = Math.max(...linkMatrix.map((e) => e.inputIndex))  + 1;
  const outputCount = Math.max(...linkMatrix.map((e) => e.outputIndex)) + 1;

  // Build probability lookup
  const pMap = new Map<string, number>();
  for (const e of linkMatrix) pMap.set(`${e.inputIndex}-${e.outputIndex}`, e.probability);

  return (
    <div data-testid="container-boltzmann-heatmap">
      <h4 className="text-xs font-medium mb-2">Link Probability Heatmap</h4>
      <div className="overflow-auto">
        {/* Grid: rows = inputs, columns = outputs (plus label column) */}
        <div
          style={{ display: "grid", gridTemplateColumns: `auto repeat(${outputCount}, minmax(36px, 1fr))`, gap: 2 }}
        >
          {/* Header row */}
          <div className="text-xs text-muted-foreground text-right pr-1 pb-1 self-end">In ↓ Out →</div>
          {Array.from({ length: outputCount }, (_, j) => (
            <div key={j} className="text-xs text-center text-muted-foreground pb-1">O{j}</div>
          ))}

          {/* Data rows */}
          {Array.from({ length: inputCount }, (_, i) => (
            <Fragment key={i}>
              <div className="text-xs text-muted-foreground text-right pr-1 self-center">I{i}</div>
              {Array.from({ length: outputCount }, (_, j) => {
                const p = pMap.get(`${i}-${j}`) ?? 0;
                return (
                  <div
                    key={j}
                    title={`I${i}→O${j}: ${(p * 100).toFixed(0)}%`}
                    style={
                      p > 0
                        ? { backgroundColor: probColor(p), color: cellTextColor(p) }
                        : undefined
                    }
                    className={`rounded text-center text-xs py-1 font-mono ${
                      p > 0 ? "" : "bg-muted/30 text-muted-foreground"
                    }`}
                    data-testid={`cell-heatmap-${i}-${j}`}
                  >
                    {p > 0 ? `${(p * 100).toFixed(0)}` : "–"}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Each cell shows P(input funded output) across all valid transaction interpretations.
        Green = unlikely, yellow = possible, red = probable.
      </p>
    </div>
  );
}

// ─── CoinJoin fund-flow Sankey helper ─────────────────────────────────────────

interface SankeyData {
  nodes: { name: string }[];
  links: { source: number; target: number; value: number }[];
}

/** Build a proportional fund-flow Sankey model from a tx's inputs/outputs. */
export function buildSankey(inputs: TransactionParticipant[], outputs: TransactionParticipant[]): SankeyData {
  const nodes = [
    ...inputs.map((p, i) => ({ name: `In ${i + 1}\n${(p.amount / 1e8).toFixed(5)} BTC` })),
    ...outputs.map((p, i) => ({ name: `Out ${i + 1}\n${(p.amount / 1e8).toFixed(5)} BTC` })),
  ];
  // Distribute each input proportionally to all outputs (CoinJoin merges funds)
  const totalIn = inputs.reduce((s, p) => s + p.amount, 0) || 1;
  const links: { source: number; target: number; value: number }[] = [];
  inputs.forEach((inp, si) => {
    outputs.forEach((out, ti) => {
      const value = Math.round((inp.amount / totalIn) * out.amount);
      if (value > 0) links.push({ source: si, target: inputs.length + ti, value });
    });
  });
  return { nodes, links };
}

// ─── Transaction deep-dive (heatmap + summary + CoinJoin Sankey) ───────────────

interface DeepDiveData {
  inputs: TransactionParticipant[];
  outputs: TransactionParticipant[];
  totalIn: number;
  totalOut: number;
  fee: number;
  isCoinJoin: boolean;
}

// Condense a caught error into a short, single-line reason that is safe to show
// to the user. Strips multi-line stack traces and clamps the length so we never
// leak a raw stack trace into the UI.
function summariseError(raw: string): string {
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

  const analyse = useCallback(async (txid: string) => {
    if (!txid) return;
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
        return;
      }

      const totalIn = inputs.reduce((s, p) => s + p.amount, 0);
      const totalOut = outputs.reduce((s, p) => s + p.amount, 0);
      // Safe fee extraction — tx.fee may be undefined for unconfirmed/legacy rows
      const fee = tx?.fee != null ? Math.max(0, tx.fee) : Math.max(0, totalIn - totalOut);
      setData({ inputs, outputs, totalIn, totalOut, fee, isCoinJoin: coinjoinTxids.has(txid) });

      const bInputs: BoltzmannInput[] = inputs.map((p, i) => ({ index: i, address: p.address, amount: Math.round(p.amount) }));
      const bOutputs: BoltzmannOutput[] = outputs.map((p, i) => ({ index: i, address: p.address, amount: Math.round(p.amount) }));

      // Run Boltzmann in a dedicated worker to keep the UI thread responsive
      if (!workerRef.current) {
        workerRef.current = new Worker(
          new URL('../lib/boltzmann.worker.ts', import.meta.url),
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
      };
      worker.onerror = (e: ErrorEvent) => {
        setMessage("Couldn't analyse this transaction — the calculation failed unexpectedly.");
        setErrorDetail(summariseError(e.message || "The analysis worker stopped unexpectedly."));
        setFailCount(c => c + 1);
        setCanRetry(true);
        setLoading(false);
      };
      worker.postMessage({ id, inputs: bInputs, outputs: bOutputs, fee });
    } catch (err) {
      setMessage("Couldn't load this transaction's data.");
      setErrorDetail(summariseError(err instanceof Error ? err.message : String(err)));
      setFailCount(c => c + 1);
      setCanRetry(true);
      setLoading(false);
    }
  }, [coinjoinTxids]);

  // When opened directly from a finding, run the analysis immediately for the
  // pre-selected transaction so the user lands on results, not an empty panel.
  useEffect(() => {
    if (autoAnalyse && selectedTxid && !autoRunRef.current) {
      autoRunRef.current = true;
      analyse(selectedTxid);
    }
  }, [autoAnalyse, selectedTxid, analyse]);

  // Tear down the Boltzmann worker when the panel unmounts. The worker is
  // created lazily on first analyse and reused, but never terminated — without
  // this it keeps running (and could deliver late messages to a now-unmounted
  // component) after the deep-dive is closed or navigated away from.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // When the user switches to a different transaction, immediately hide the
  // previously analysed transaction's results, summary and any error/message.
  // Otherwise the stale numbers would keep showing under a different txid until
  // Analyse is clicked again — letting a user read one transaction's privacy
  // result while believing it belongs to another. Results reappear only after
  // the newly selected transaction is analysed.
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
                link={{ stroke: "hsl(var(--muted-foreground) / 0.25)" }}
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

// ─── Per-finding deep-dive dialog ─────────────────────────────────────────────

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
        {/* Only mount (and auto-run) the analysis while the dialog is open */}
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

// ─── Peel-chain visualization ─────────────────────────────────────────────────

interface PeelStep {
  txid: string;
  carriedIn: number;      // total input value entering this hop
  payment: number;        // value peeled off to an external address
  paymentAddress: string;
  change: number;         // value returned to our (change) address
  changeAddress: string;
}

const PEEL_PAYMENT_COLOR = "hsl(var(--chart-5))"; // payment peeled off to external address
const PEEL_CHANGE_COLOR = "hsl(var(--chart-2))"; // change forwarded along the chain
const PEEL_COINJOIN_COLOR = "hsl(var(--chart-4))"; // mixing (CoinJoin) hop highlight

function shortPeelAddr(a: string): string {
  if (!a || a === "—") return "—";
  return a.length > 16 ? `${a.slice(0, 7)}…${a.slice(-5)}` : a;
}

function shortPeelTxid(t: string): string {
  return t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t;
}

// Node-link diagram of the peel chain. Transactions form a vertical spine;
// change outputs flow down the spine (becoming the next hop's input) while
// payments branch off to the right toward external addresses.
function PeelChainGraph({ steps, coinjoinTxids }: { steps: PeelStep[]; coinjoinTxids: Set<string> }) {
  const { openRecordPreviewByAddress } = useRecordPreview();
  const { toast } = useToast();
  const [deepDiveTxid, setDeepDiveTxid] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
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
  const copyAddr = async (value: string) => {
    if (!value || value === "—") return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedAddr(value);
      window.setTimeout(() => {
        setCopiedAddr((prev) => (prev === value ? null : prev));
      }, 1500);
      toast({ title: "Address copied", description: shortPeelAddr(value) });
    } catch {
      toast({ title: "Copy failed", description: "Could not copy to clipboard", variant: "destructive" });
    }
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

          {/* Edges first so nodes render on top */}
          {steps.map((step, i) => {
            const ty = txY(i);
            const cy = changeY(i);
            const nextTy = txY(i + 1);
            const isLast = i === steps.length - 1;
            return (
              <Fragment key={`edges-${step.txid}`}>
                {/* Payment branch to the right */}
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
                  fill={PEEL_PAYMENT_COLOR}
                >
                  {fmt(step.payment)}
                </text>
                {/* Change forwarded down the spine */}
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
                  fill={PEEL_CHANGE_COLOR}
                >
                  {fmt(step.change)}
                </text>
                {/* Change address spends into the next transaction */}
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

          {/* Nodes */}
          {steps.map((step, i) => {
            const ty = txY(i);
            const cy = changeY(i);
            const isLast = i === steps.length - 1;
            const isCoinJoin = coinjoinTxids.has(step.txid);
            return (
              <Fragment key={`nodes-${step.txid}`}>
                {/* Transaction node — click to view the record; badge opens the forensic deep-dive */}
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
                  {/* Highlight ring for CoinJoin (mixing) hops */}
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
                  {/* Deep-dive affordance badge on the node */}
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
                  {/* CoinJoin (mixing) marker on the node */}
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

                {/* Payment address node */}
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
                  {/* Copy-address affordance badge on the node */}
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
                      {copiedAddr === step.paymentAddress ? (
                        <Check x={-4} y={-4} width={8} height={8} color={PEEL_PAYMENT_COLOR} />
                      ) : (
                        <Copy x={-4} y={-4} width={8} height={8} color={PEEL_PAYMENT_COLOR} />
                      )}
                    </g>
                  )}
                </g>

                {/* Change address node on the spine */}
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
                  {/* Copy-address affordance badge on the node */}
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
                      {copiedAddr === step.changeAddress ? (
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
          // The change output is the one going back to one of our change addresses.
          // Fall back to the smaller output if no address match is available.
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
                    <ClickableAddress address={step.paymentAddress} />
                  </div>
                </div>
                <div className="bg-muted/40 rounded p-2">
                  <div className="text-xs font-medium text-muted-foreground mb-1">Change forwarded</div>
                  <div className="text-sm font-mono" data-testid={`text-peel-change-${i}`}>
                    {(step.change / 1e8).toFixed(6)} BTC
                  </div>
                  <div className="mt-1">
                    <ClickableAddress address={step.changeAddress} />
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

// ─── Privacy history timeline ─────────────────────────────────────────────────

function formatHistoryDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PrivacyHistoryCard() {
  const history = useLiveQuery(
    () => db.privacyAuditHistory.orderBy("timestamp").toArray(),
  );
  const { toast } = useToast();

  // Per-run export selection. Keyed by entry.id (falling back to its
  // timestamp). An empty set means "export everything" so the default keeps
  // the original behaviour of exporting all stored runs.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // True when the last "Select range" matched zero stored runs. Distinguishes
  // an empty-range result from the "nothing picked = all runs" default so the
  // hint can warn the user instead of silently reverting to all runs.
  const [rangeMatchedNone, setRangeMatchedNone] = useState(false);

  const entryKey = useCallback(
    (entry: PrivacyAuditHistoryEntry) => entry.id ?? entry.timestamp,
    [],
  );

  // The runs that will actually be exported: the hand-picked selection when any
  // run is checked, otherwise the full history (newest → oldest is applied by
  // the export builders themselves).
  const exportList = useMemo(() => {
    const list = history ?? [];
    if (selectedIds.size === 0) return list;
    return list.filter((e) => selectedIds.has(e.id ?? e.timestamp));
  }, [history, selectedIds]);

  const toggleSelected = useCallback((key: number) => {
    setRangeMatchedNone(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setRangeMatchedNone(false);
    setSelectedIds(new Set((history ?? []).map((e) => e.id ?? e.timestamp)));
  }, [history]);

  const clearSelection = useCallback(() => {
    setRangeMatchedNone(false);
    setSelectedIds(new Set());
  }, []);

  // Convenience: check every run whose timestamp falls within the chosen date
  // range (inclusive). Empty bounds are treated as open-ended. When the range
  // matches no stored runs, leave the existing selection untouched and surface
  // a clear, non-destructive message instead of silently reverting to the
  // "export all runs" default.
  const selectRange = useCallback(() => {
    const list = history ?? [];
    const fromTs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : -Infinity;
    const toTs = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : Infinity;
    const matched = list.filter((e) => e.timestamp >= fromTs && e.timestamp <= toTs);
    if (matched.length === 0) {
      setRangeMatchedNone(true);
      toast({
        title: "No runs in that date range",
        description:
          "Nothing was selected. Adjust the dates or pick runs by hand — your current selection is unchanged.",
      });
      return;
    }
    setRangeMatchedNone(false);
    setSelectedIds(new Set(matched.map((e) => e.id ?? e.timestamp)));
  }, [history, fromDate, toDate, toast]);

  const chartData = useMemo(
    () =>
      (history ?? []).map((h) => ({
        ts: h.timestamp,
        date: formatHistoryDate(h.timestamp),
        score: h.score,
        grade: h.grade,
      })),
    [history],
  );

  // Build the per-run rows (newest first) annotated with which finding types
  // changed compared to the immediately preceding run.
  const rows = useMemo(() => {
    const list = history ?? [];
    const out: {
      entry: PrivacyAuditHistoryEntry;
      scoreDelta: number | null;
      changes: { type: string; from: number; to: number }[];
    }[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      const prev = i > 0 ? list[i - 1] : null;
      const scoreDelta = prev ? entry.score - prev.score : null;
      const changes: { type: string; from: number; to: number }[] = [];
      if (prev) {
        const types = Array.from(
          new Set([
            ...Object.keys(entry.findingTypeCounts ?? {}),
            ...Object.keys(prev.findingTypeCounts ?? {}),
          ]),
        );
        for (const type of types) {
          const to = entry.findingTypeCounts?.[type] ?? 0;
          const from = prev.findingTypeCounts?.[type] ?? 0;
          if (to !== from) changes.push({ type, from, to });
        }
        changes.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
      }
      out.push({ entry, scoreDelta, changes });
    }
    return out;
  }, [history]);

  const handleClear = useCallback(async () => {
    try {
      await clearPrivacyAuditHistory();
      toast({ title: "History Cleared", description: "All privacy audit history was removed." });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Clear Failed",
        description: e instanceof Error ? e.message : "Could not clear history.",
      });
    }
  }, [toast]);

  const handleExportCsv = useCallback(() => {
    const list = exportList;
    if (list.length === 0) return;
    try {
      const csv = buildPrivacyHistoryCsv(list);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `privacy-history-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({
        title: "History Exported",
        description: `${list.length} audit run${list.length === 1 ? "" : "s"} exported to CSV.`,
      });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Export Failed",
        description: e instanceof Error ? e.message : "Could not export history.",
      });
    }
  }, [exportList, toast]);

  const handleExportPdf = useCallback(async () => {
    const list = exportList;
    if (list.length === 0) return;
    try {
      const blob = await buildPrivacyHistoryPdf(list);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `privacy-history-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({
        title: "History Exported",
        description: `${list.length} audit run${list.length === 1 ? "" : "s"} exported to PDF.`,
      });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Export Failed",
        description: e instanceof Error ? e.message : "Could not export history.",
      });
    }
  }, [exportList, toast]);

  if (!history || history.length === 0) return null;

  const latest = history[history.length - 1];
  const first = history[0];
  const overallDelta = latest.score - first.score;

  return (
    <Card data-testid="container-privacy-history">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Privacy History
          </CardTitle>
          <CardDescription className="text-xs">
            {history.length} audit{history.length === 1 ? "" : "s"} recorded
            {history.length > 1 && (
              <>
                {" · "}
                <span
                  className={
                    overallDelta > 0
                      ? "text-green-600 dark:text-green-400"
                      : overallDelta < 0
                      ? "text-red-600 dark:text-red-400"
                      : ""
                  }
                  data-testid="text-history-overall-delta"
                >
                  {overallDelta > 0 ? "+" : ""}
                  {overallDelta} pts overall
                </span>
              </>
            )}
            {" · keeps last 30 runs"}
            {selectedIds.size > 0 && (
              <>
                {" · "}
                <span className="font-medium" data-testid="text-history-selected-count">
                  {selectedIds.size} selected for export
                </span>
              </>
            )}
          </CardDescription>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            data-testid="button-export-history-csv"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPdf}
            data-testid="button-export-history-pdf"
          >
            <Download className="h-4 w-4" />
            Export PDF
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            data-testid="button-clear-history"
          >
            Clear
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {chartData.length > 1 ? (
          <div data-testid="container-history-sparkline">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                <Tooltip
                  formatter={(value: number, _name, entry: { payload?: { grade: string } }) => [
                    `${value}/100 (${entry.payload?.grade ?? ""})`,
                    "Score",
                  ]}
                  contentStyle={{ fontSize: 11 }}
                />
                <ReferenceLine y={80} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.5} />
                <ReferenceLine y={60} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.5} />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="text-history-need-more">
            Run the audit again over time to see your score trend appear here.
          </p>
        )}

        <div
          className="flex flex-wrap items-end gap-3 rounded-md border p-3"
          data-testid="container-history-export-selection"
        >
          <div className="space-y-1">
            <Label htmlFor="history-from-date" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="history-from-date"
              type="date"
              value={fromDate}
              onChange={(e) => {
                setRangeMatchedNone(false);
                setFromDate(e.target.value);
              }}
              className="h-9 w-[10.5rem]"
              data-testid="input-history-from-date"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-to-date" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="history-to-date"
              type="date"
              value={toDate}
              onChange={(e) => {
                setRangeMatchedNone(false);
                setToDate(e.target.value);
              }}
              className="h-9 w-[10.5rem]"
              data-testid="input-history-to-date"
            />
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={selectRange}
              disabled={!fromDate && !toDate}
              data-testid="button-history-select-range"
            >
              Select range
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={selectAll}
              data-testid="button-history-select-all"
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              disabled={selectedIds.size === 0}
              data-testid="button-history-clear-selection"
            >
              Clear selection
            </Button>
          </div>
          <p
            className={`w-full text-xs ${
              rangeMatchedNone ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
            }`}
            data-testid="text-history-export-hint"
          >
            {rangeMatchedNone
              ? "0 runs fall in that date range — selection unchanged. Adjust the dates or pick runs by hand."
              : selectedIds.size === 0
              ? "No runs picked — exports will include all stored runs."
              : `Exports will include ${selectedIds.size} selected run${
                  selectedIds.size === 1 ? "" : "s"
                }.`}
          </p>
        </div>

        <div className="space-y-2">
          {rows.map(({ entry, scoreDelta, changes }) => {
            const key = entryKey(entry);
            return (
            <div
              key={entry.id ?? entry.timestamp}
              className="border rounded-md p-3 space-y-2"
              data-testid={`row-history-${entry.id ?? entry.timestamp}`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Checkbox
                    checked={selectedIds.has(key)}
                    onCheckedChange={() => toggleSelected(key)}
                    aria-label={`Select run from ${formatHistoryDate(entry.timestamp)} for export`}
                    data-testid={`checkbox-history-select-${entry.id ?? entry.timestamp}`}
                  />
                  <span className="text-xs text-muted-foreground" data-testid="text-history-date">
                    {formatHistoryDate(entry.timestamp)}
                  </span>
                  <Badge variant="outline" data-testid="badge-history-grade">
                    {entry.grade}
                  </Badge>
                  <span className="text-sm font-medium" data-testid="text-history-score">
                    {entry.score}/100
                  </span>
                  {scoreDelta !== null && scoreDelta !== 0 && (
                    <span
                      className={`text-xs font-mono ${
                        scoreDelta > 0
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                      data-testid="text-history-delta"
                    >
                      {scoreDelta > 0 ? "+" : ""}
                      {scoreDelta}
                    </span>
                  )}
                  {entry.owner || entry.walletName ? (
                    <>
                      {entry.owner && (
                        <Badge
                          variant="secondary"
                          className="text-xs"
                          data-testid="badge-history-scope-owner"
                        >
                          Owner: {entry.owner}
                        </Badge>
                      )}
                      {entry.walletName && (
                        <Badge
                          variant="secondary"
                          className="text-xs"
                          data-testid="badge-history-scope-wallet"
                        >
                          Wallet: {entry.walletName}
                        </Badge>
                      )}
                    </>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="text-xs"
                      data-testid="badge-history-scope-all"
                    >
                      All
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {entry.totalFindings} issue{entry.totalFindings === 1 ? "" : "s"}
                </span>
              </div>

              {changes.length > 0 && (
                <div className="flex flex-wrap gap-1" data-testid="container-history-changes">
                  {changes.slice(0, 8).map((c) => {
                    const improved = c.to < c.from;
                    return (
                      <Badge
                        key={c.type}
                        variant="secondary"
                        className="text-xs"
                        data-testid={`badge-history-change-${c.type.toLowerCase()}`}
                      >
                        <span
                          className={
                            improved
                              ? "text-green-600 dark:text-green-400"
                              : "text-red-600 dark:text-red-400"
                          }
                        >
                          {improved ? "▾" : "▴"}
                        </span>
                        <span className="ml-1">
                          {FINDING_TYPE_LABELS[c.type as PrivacyFindingType] ?? c.type}: {c.from}→{c.to}
                        </span>
                      </Badge>
                    );
                  })}
                  {changes.length > 8 && (
                    <span className="text-xs text-muted-foreground self-center">
                      +{changes.length - 8} more
                    </span>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PrivacyAudit() {
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [result, setResult] = useState<PrivacyAuditResult | null>(null);
  const [taggingProgress, setTaggingProgress] = useState({ current: 0, total: 0 });
  const [selectedOwner, setSelectedOwner] = useState<string>("all");
  const [selectedWallet, setSelectedWallet] = useState<string>("all");
  const [openTypes, setOpenTypes] = useState<Record<string, boolean>>({});
  const { showScoreBreakdown } = useSettings();
  const showWaterfall = showScoreBreakdown;
  const setShowWaterfall = (next: boolean | ((v: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(showWaterfall) : next;
    void updateShowScoreBreakdown(value);
  };

  const { tags } = useTags();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { toast } = useToast();

  const runAudit = useCallback(async () => {
    try {
      setResult(null);
      setStatusMessage("Loading address records...");
      setScanState("analyzing");

      const totalAddresses = await countRecordsByType("address");

      if (totalAddresses === 0) {
        toast({ title: "No Records", description: "No address records found to audit." });
        setScanState("idle");
        return;
      }

      const userAddresses: string[] = [];
      let beforeIdExclusive: number | undefined = undefined;
      let scanned = 0;
      while (true) {
        const batch = await getRecordsPageByTypeIdReverseKeyset("address", {
          limit: AUDIT_INPUT_BATCH,
          beforeIdExclusive,
        });
        if (batch.length === 0) break;
        for (const r of batch) {
          if (selectedOwner !== "all" && r.owner !== selectedOwner) continue;
          if (selectedWallet !== "all" && r.walletName !== selectedWallet) continue;
          if (r.inputString) userAddresses.push(r.inputString);
        }
        scanned += batch.length;
        setStatusMessage(
          `Loading address records… ${scanned.toLocaleString()} / ${totalAddresses.toLocaleString()}`
        );
        beforeIdExclusive = batch[batch.length - 1].id ?? undefined;
        if (batch.length < AUDIT_INPUT_BATCH || beforeIdExclusive == null) break;
        await new Promise((r) => setTimeout(r, 0));
      }

      if (userAddresses.length === 0) {
        toast({ title: "No Matching Records", description: "No address records match the selected filters." });
        setScanState("idle");
        return;
      }

      const auditResult = await runPrivacyAudit(userAddresses, (msg) => setStatusMessage(msg));
      setResult(auditResult);
      setScanState("complete");

      // Persist a snapshot so users can track their score over time.
      try {
        const allItems = [...auditResult.findings, ...auditResult.warnings];
        const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
        const findingTypeCounts: { [type: string]: number } = {};
        for (const f of allItems) {
          severityCounts[f.severity] += 1;
          findingTypeCounts[f.type] = (findingTypeCounts[f.type] ?? 0) + 1;
        }
        await addPrivacyAuditHistoryEntry({
          timestamp: Date.now(),
          score: auditResult.score,
          grade: auditResult.grade,
          totalFindings: allItems.length,
          transactionsAnalyzed: auditResult.transactionsAnalyzed,
          addressesScanned: auditResult.addressesScanned,
          severityCounts,
          findingTypeCounts,
          owner: selectedOwner !== "all" ? selectedOwner : undefined,
          walletName: selectedWallet !== "all" ? selectedWallet : undefined,
        });
      } catch (historyError) {
        console.error("Failed to save privacy audit history:", historyError);
      }

      toast({
        title: auditResult.isClean ? "All Clear" : "Audit Complete",
        description: auditResult.isClean
          ? `${auditResult.transactionsAnalyzed} transactions analyzed — no privacy issues found. Score: ${auditResult.score}/100 (${auditResult.grade})`
          : `Score: ${auditResult.score}/100 (${auditResult.grade}) — ${auditResult.findings.length} finding(s), ${auditResult.warnings.length} warning(s).`,
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

  const hasProximityFindings = useMemo(() => {
    if (!result) return false;
    return [...result.findings, ...result.warnings].some(f => PROXIMITY_FINDING_TYPES.has(f.type));
  }, [result]);

  const tagProximityFindings = useCallback(async () => {
    if (!result) return;

    // Collect proximity findings only
    const proximityItems = [...result.findings, ...result.warnings].filter(f =>
      PROXIMITY_FINDING_TYPES.has(f.type)
    );

    if (proximityItems.length === 0) {
      toast({ title: "Nothing to Tag", description: "No proximity findings found." });
      return;
    }

    // Map owned address → Set<proximity tag names>
    const addressToProximityTags = new Map<string, Set<string>>();
    for (const f of proximityItems) {
      const tagName = getProximityTagName(f);
      if (!tagName) continue;
      for (const addr of f.addresses) {
        const existing = addressToProximityTags.get(addr);
        if (existing) existing.add(tagName);
        else addressToProximityTags.set(addr, new Set([tagName]));
      }
    }

    if (addressToProximityTags.size === 0) {
      toast({ title: "Nothing to Tag", description: "No addresses found in proximity findings." });
      return;
    }

    setScanState("tagging");
    setTaggingProgress({ current: 0, total: addressToProximityTags.size });

    try {
      // Ensure all required proximity tags exist in the vocabulary
      const existingTagNames = new Set(tags.map(t => t.name));
      const allProximityTagNames = new Set<string>();
      for (const tagSet of addressToProximityTags.values()) {
        for (const t of tagSet) allProximityTagNames.add(t);
      }
      for (const tagName of allProximityTagNames) {
        if (!existingTagNames.has(tagName)) {
          // Derive category from the tag name: proximity:<category>-<n>hop
          const match = tagName.match(/^proximity:([^-]+(?:-[^-]+)*)-(\d+)hop$/);
          const color = match
            ? getProximityTagColor(match[1] as Parameters<typeof getProximityTagColor>[0])
            : "#64748b";
          try {
            await createTag(tagName, color);
          } catch {
            // Already exists — safe to ignore
          }
        }
      }

      const tagAddresses = Array.from(addressToProximityTags.keys());
      const addressToRecord = new Map<string, DbRecord>();
      for (let i = 0; i < tagAddresses.length; i += TAG_FETCH_BATCH) {
        const slice = tagAddresses.slice(i, i + TAG_FETCH_BATCH);
        const found = await getRecordsByInputStrings(slice);
        for (const r of found) {
          if (r.inputString) addressToRecord.set(r.inputString, r);
        }
      }

      // Collect all proximity tag names for stripping old ones before re-applying
      const proximityTagPrefix = "proximity:";

      beginBulkOperation();
      try {
        const entries = Array.from(addressToProximityTags.entries());
        for (let idx = 0; idx < entries.length; idx++) {
          const [address, tagNames] = entries[idx];
          const record = addressToRecord.get(address);
          if (record?.id) {
            const existingTags = (record.tags || []).filter(
              (t: string) => !t.startsWith(proximityTagPrefix)
            );
            await updateRecord(record.id, { tags: [...existingTags, ...Array.from(tagNames)] });
          }
          setTaggingProgress({ current: idx + 1, total: entries.length });
          if (idx % 10 === 9) await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        endBulkOperation();
      }

      setScanState("complete");
      toast({
        title: "Proximity Tags Applied",
        description: `Applied proximity tags to ${addressToProximityTags.size} address record(s).`,
      });
    } catch (error) {
      console.error("Proximity tagging failed:", error);
      toast({
        variant: "destructive",
        title: "Tagging Failed",
        description: error instanceof Error ? error.message : "An error occurred during proximity tagging.",
      });
      setScanState("complete");
    }
  }, [result, tags, toast]);

  const tagFindings = useCallback(async () => {
    if (!result) return;

    const allItems = [...result.findings, ...result.warnings];
    const addressToFindings = new Map<string, Set<string>>();
    for (const f of allItems) {
      const tagInfo = PRIVACY_TAG_MAP[f.type];
      if (!tagInfo) continue;
      for (const addr of f.addresses) {
        const existing = addressToFindings.get(addr);
        if (existing) existing.add(tagInfo.tagName);
        else addressToFindings.set(addr, new Set([tagInfo.tagName]));
      }
    }

    if (addressToFindings.size === 0) {
      toast({ title: "Nothing to Tag", description: "No addresses found in the findings." });
      return;
    }

    setScanState("tagging");
    setTaggingProgress({ current: 0, total: addressToFindings.size });

    try {
      const existingTagNames = new Set(tags.map((t) => t.name));
      for (const info of Object.values(PRIVACY_TAG_MAP)) {
        if (info && !existingTagNames.has(info.tagName)) {
          await createTag(info.tagName, info.color);
        }
      }

      const tagAddresses = Array.from(addressToFindings.keys());
      const addressToRecord = new Map<string, DbRecord>();
      for (let i = 0; i < tagAddresses.length; i += TAG_FETCH_BATCH) {
        const slice = tagAddresses.slice(i, i + TAG_FETCH_BATCH);
        const found = await getRecordsByInputStrings(slice);
        for (const r of found) {
          if (r.inputString) addressToRecord.set(r.inputString, r);
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
            await updateRecord(record.id, { tags: [...existingTags, ...Array.from(tagNames)] });
          }
          setTaggingProgress({ current: idx + 1, total: tagEntries.length });
          if (idx % 10 === 9) await new Promise((r) => setTimeout(r, 0));
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

  const groupedFindings = useMemo(() => {
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
      label: FINDING_TYPE_LABELS[type] ?? type,
      Icon: getIcon(type),
      highestSeverity: items.reduce<PrivacySeverity>((best, f) => {
        const order: Record<PrivacySeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return order[f.severity] < order[best] ? f.severity : best;
      }, "LOW"),
    }));
  }, [result]);

  const allFindingTxids = useMemo(() => {
    if (!result) return [];
    const seen = new Set<string>();
    const txids: string[] = [];
    for (const f of [...result.findings, ...result.warnings]) {
      for (const t of f.txids) {
        if (!seen.has(t)) { seen.add(t); txids.push(t); }
      }
    }
    return txids;
  }, [result]);

  const coinjoinWarningTxids = useMemo(() => {
    if (!result) return [];
    const seen = new Set<string>();
    const txids: string[] = [];
    for (const f of result.warnings) {
      if (!f.type.startsWith("COINJOIN_")) continue;
      for (const t of f.txids) {
        if (!seen.has(t)) { seen.add(t); txids.push(t); }
      }
    }
    return txids;
  }, [result]);

  const coinjoinWarningSet = useMemo(() => new Set(coinjoinWarningTxids), [coinjoinWarningTxids]);

  const countBySeverity = (severity: PrivacySeverity) => {
    if (!result) return 0;
    return [...result.findings, ...result.warnings].filter((f) => f.severity === severity).length;
  };

  const progressPercent =
    scanState === "tagging" && taggingProgress.total > 0
      ? Math.round((taggingProgress.current / taggingProgress.total) * 100)
      : 0;

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4 max-w-4xl mx-auto">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            Privacy Audit
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-page-description">
            Scan your transaction history for privacy vulnerabilities using on-chain heuristics, entity detection,
            wallet fingerprinting, and Boltzmann linkability analysis. Everything runs fully offline.
          </p>
        </div>

        {/* Config card */}
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
                    {owners.map((o) => (
                      <SelectItem key={o.name} value={o.name}>
                        {o.name}
                      </SelectItem>
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
                    {walletNames.map((w) => (
                      <SelectItem key={w.name} value={w.name}>
                        {w.name}
                      </SelectItem>
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
                    {scanState === "analyzing" ? "Analyzing…" : "Tagging…"}
                  </>
                )}
              </Button>
            </div>

            {scanState === "tagging" && (
              <div className="space-y-1">
                <Progress value={progressPercent} className="h-2" data-testid="progress-audit" />
                <p className="text-xs text-muted-foreground" data-testid="text-progress-status">
                  Applying tags… {taggingProgress.current} / {taggingProgress.total}
                </p>
              </div>
            )}

            {scanState === "analyzing" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span data-testid="text-analyzing-status">{statusMessage || "Analyzing transactions…"}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <PrivacyHistoryCard />

        {result?.needsResync && (
          <Card className="border-amber-500/40 bg-amber-500/5" data-testid="banner-needs-resync">
            <CardContent className="p-3 flex items-start gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Fingerprinting data incomplete</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {result.fingerprintCoverage != null && result.fingerprintCoverage < 1
                    ? `${Math.round(result.fingerprintCoverage * 100)}% of synced transactions have raw fingerprint data — `
                    : "Some synced transactions are missing raw fingerprint data — "}
                  wallet fingerprinting checks (nVersion, RBF, BIP69, low-R, mixed witness) are partial until those
                  addresses are re-synced via Transaction Sync.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {result && (
          <>
            {/* Score summary */}
            <Card data-testid="container-score-summary">
              <CardContent className="p-4">
                <div className="flex flex-wrap gap-4 items-start justify-between">
                  <ScoreGauge score={result.score} grade={result.grade} />
                  <div className="flex-1 min-w-[200px] grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="text-center">
                      <div className="text-2xl font-bold" data-testid="text-stat-total">
                        {result.findings.length + result.warnings.length}
                      </div>
                      <div className="text-xs text-muted-foreground">Total Issues</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold" data-testid="text-stat-txs">
                        {result.transactionsAnalyzed.toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">Txs Analyzed</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold" data-testid="text-stat-addresses">
                        {result.addressesScanned.toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">Addresses Scanned</div>
                    </div>
                    <div className="col-span-2 sm:col-span-3 flex flex-wrap gap-1" data-testid="container-severity-summary">
                      {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as PrivacySeverity[]).map((sev) => {
                        const count = countBySeverity(sev);
                        if (count === 0) return null;
                        return (
                          <Badge
                            key={sev}
                            {...getSeverityBadgeProps(sev)}
                            data-testid={`badge-severity-${sev.toLowerCase()}`}
                          >
                            {count} {sev}
                          </Badge>
                        );
                      })}
                      {result.isClean && (
                        <Badge className="bg-green-500 text-white no-default-hover-elevate no-default-active-elevate" data-testid="text-clean-badge">
                          <ShieldCheck className="h-3 w-3 mr-1" /> Clean
                        </Badge>
                      )}
                    </div>
                  </div>

                  {result.scoreWaterfall.length > 1 && (
                    <div className="w-full mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowWaterfall(v => !v)}
                        data-testid="button-toggle-waterfall"
                      >
                        <ChevronDown className={`h-3 w-3 mr-1 transition-transform ${showWaterfall ? "rotate-180" : ""}`} />
                        {showWaterfall ? "Hide" : "Show"} Score Breakdown
                      </Button>
                      {showWaterfall && (
                        <div className="mt-2">
                          <WaterfallChart entries={result.scoreWaterfall} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Proximity data-sparsity caveat — mandatory whenever the audit ran */}
            <Card className="border-blue-500/30 bg-blue-500/5" data-testid="banner-proximity-caveat">
              <CardContent className="p-3 flex items-start gap-3">
                <Network className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-blue-700 dark:text-blue-400">
                    Entity proximity is measured over locally synced data only
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    The proximity scores above reflect the shortest path to known entities
                    <strong> through transactions already imported into KYUTXO</strong>. If an address
                    has never been synced, no path to it can be found — "no proximity finding"
                    means "not in your local data," not "safe."
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Actions */}
            {!result.isClean && (
              <div className="flex flex-wrap justify-end gap-2">
                {hasProximityFindings && (
                  <Button
                    variant="outline"
                    onClick={tagProximityFindings}
                    disabled={scanState === "tagging"}
                    data-testid="button-tag-proximity-findings"
                  >
                    {scanState === "tagging" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Network className="mr-2 h-4 w-4" />
                    )}
                    Tag Proximity Findings
                  </Button>
                )}
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

            {/* Per-transaction deep-dive: heatmap, entropy, and CoinJoin fund-flow */}
            {allFindingTxids.length > 0 && (
              <TransactionDeepDive
                txids={allFindingTxids}
                coinjoinTxids={coinjoinWarningSet}
              />
            )}

            {/* Clean state */}
            {groupedFindings.length === 0 && result.isClean && (
              <Card>
                <CardContent className="p-8 text-center">
                  <ShieldCheck className="h-12 w-12 text-green-500 mx-auto mb-3" />
                  <h3 className="text-lg font-medium" data-testid="text-no-findings">
                    No Privacy Issues Found
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Your transaction history shows no detectable privacy vulnerabilities.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Finding groups */}
            <div className="space-y-3">
              {groupedFindings.map(({ type, items, label, Icon, highestSeverity }) => {
                const isOpen = openTypes[type] ?? true;
                return (
                  <Collapsible
                    key={type}
                    open={isOpen}
                    onOpenChange={(open) => setOpenTypes((prev) => ({ ...prev, [type]: open }))}
                  >
                    <Card>
                      <CollapsibleTrigger asChild>
                        <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 py-3 px-4">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span
                              className="font-medium text-sm"
                              data-testid={`text-group-title-${type.toLowerCase()}`}
                            >
                              {label}
                            </span>
                            <Badge
                              {...getSeverityBadgeProps(highestSeverity)}
                              data-testid={`badge-group-severity-${type.toLowerCase()}`}
                            >
                              {items.length}
                            </Badge>
                          </div>
                          <ChevronDown
                            className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ${
                              isOpen ? "rotate-180" : ""
                            }`}
                          />
                        </CardHeader>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <CardContent className="pt-0 pb-4 px-4 space-y-3">
                          {items.map((finding, idx) => (
                            <FindingCard
                              key={`${finding.type}-${idx}`}
                              finding={finding}
                              coinjoinTxids={coinjoinWarningSet}
                            />
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

// ─── Finding card ─────────────────────────────────────────────────────────────

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
  const citations = (finding.details?.citations as EntityCitation[] | undefined) ?? [];
  const hopPath = (finding.details?.hopPath as string[] | undefined) ?? [];
  const hopTxids = (finding.details?.hopTxids as string[] | undefined) ?? [];

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
                  {finding.txids.slice(0, 10).map((txid) => (
                    <span key={txid} className="inline-flex items-center gap-0.5">
                      <TxidLink txid={txid} />
                      <DeepDiveDialog txid={txid} coinjoinTxids={coinjoinTxids} />
                    </span>
                  ))}
                  {finding.txids.length > 10 && (
                    <span className="text-xs text-muted-foreground">
                      +{finding.txids.length - 10} more
                    </span>
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
                      <ClickableAddress address={addr} />
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
                <div className="flex flex-wrap gap-1 mt-1">
                  {finding.addresses.slice(0, 10).map((addr) => (
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
