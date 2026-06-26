import { useState, useCallback, useMemo, Fragment, useRef } from "react";
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
  Zap,
  Network,
  ScanSearch,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
  Sankey,
} from "recharts";
import { beginBulkOperation, endBulkOperation } from "@/lib/database";
import type { Record as DbRecord } from "@/lib/database";
import { createTag } from "@/lib/data/vocabulary-crud";
import { updateRecord, countRecordsByType, getRecordsPageByTypeIdReverseKeyset, getRecordsByInputStrings } from "@/lib/data/record-crud";
import { getTransactionByTxid } from "@/lib/data/transaction-crud";
import { getParticipantsByTxids } from "@/lib/data/record-queries";
import { useTags } from "@/hooks/use-tags";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useToast } from "@/hooks/use-toast";
import { ClickableAddress } from "@/components/ClickableAddress";
import { TxidLink } from "@/components/TxidLink";
import {
  runPrivacyAudit,
  PRIVACY_TAG_MAP,
  PRIVACY_TAG_NAMES,
  FINDING_TYPE_LABELS,
  type PrivacyAuditResult,
  type PrivacyFinding,
  type PrivacyFindingType,
  type PrivacySeverity,
  type ScoreWaterfallEntry,
} from "@/lib/privacy-audit";
import { formatEntropy, type BoltzmannInput, type BoltzmannOutput } from "@/lib/boltzmann";
import type { BoltzmannResult } from "@/lib/boltzmann";

type ScanState = "idle" | "analyzing" | "tagging" | "complete";

const AUDIT_INPUT_BATCH = 1000;
const TAG_FETCH_BATCH = 500;

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

function probColor(p: number): string {
  // 0 = green (hsl 130), 0.5 = yellow (hsl 50), 1 = red (hsl 0)
  const hue = Math.round(130 - p * 130);
  const sat = 70;
  const lit = 42;
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
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
                    style={{ backgroundColor: p > 0 ? probColor(p) : undefined }}
                    className={`rounded text-center text-xs py-1 font-mono ${
                      p > 0 ? "text-white" : "bg-muted/30 text-muted-foreground"
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

// ─── Boltzmann panel ──────────────────────────────────────────────────────────

function BoltzmannPanel({ txids }: { txids: string[] }) {
  const [selectedTxid, setSelectedTxid] = useState<string>(txids[0] ?? "");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BoltzmannResult | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingIdRef = useRef<string | null>(null);

  const analyse = useCallback(async (txid: string) => {
    if (!txid) return;
    setLoading(true);
    setResult(null);
    try {
      const tx = await getTransactionByTxid(txid);
      if (!tx) { setLoading(false); return; }
      const participants = await getParticipantsByTxids([txid]);
      const inputs: BoltzmannInput[] = participants
        .filter(p => p.role === "input")
        .map((p, i) => ({ index: i, address: p.address, amount: Math.round(p.amount) }));
      const outputs: BoltzmannOutput[] = participants
        .filter(p => p.role === "output")
        .map((p, i) => ({ index: i, address: p.address, amount: Math.round(p.amount) }));
      // Safe fee extraction — tx.fee may be undefined for unconfirmed/legacy rows
      const fee = tx.fee != null ? Math.max(0, tx.fee) : 0;

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
      worker.onerror = () => setLoading(false);
      worker.postMessage({ id, inputs, outputs, fee });
    } catch {
      setLoading(false);
    }
  }, []);

  if (txids.length === 0) return null;

  return (
    <Card data-testid="container-boltzmann-panel">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <ScanSearch className="h-4 w-4" />
          Boltzmann Linkability Analysis
        </CardTitle>
        <CardDescription className="text-xs">
          Computes transaction entropy and link-probability matrix. 0 bits = fully traceable; higher = more interpretations.
          Runs entirely offline.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1 min-w-[200px] flex-1">
            <label className="text-xs text-muted-foreground">Transaction</label>
            <Select value={selectedTxid} onValueChange={setSelectedTxid}>
              <SelectTrigger data-testid="select-boltzmann-txid">
                <SelectValue placeholder="Select transaction" />
              </SelectTrigger>
              <SelectContent>
                {txids.slice(0, 50).map(t => (
                  <SelectItem key={t} value={t}>
                    {t.substring(0, 20)}…
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="default"
            variant="outline"
            onClick={() => analyse(selectedTxid)}
            disabled={loading || !selectedTxid}
            data-testid="button-analyse-boltzmann"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ScanSearch className="h-4 w-4 mr-1" />}
            Analyse
          </Button>
        </div>

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
      </CardContent>
    </Card>
  );
}

// ─── CoinJoin fund-flow Sankey ────────────────────────────────────────────────

function CoinJoinFlowPanel({ txids }: { txids: string[] }) {
  const [selectedTxid, setSelectedTxid] = useState<string>(txids[0] ?? "");
  const [loading, setLoading] = useState(false);
  const [sankeyData, setSankeyData] = useState<{
    nodes: { name: string }[];
    links: { source: number; target: number; value: number }[];
  } | null>(null);

  const load = useCallback(async (txid: string) => {
    if (!txid) return;
    setLoading(true);
    setSankeyData(null);
    try {
      const participants = await getParticipantsByTxids([txid]);
      const inputs = participants.filter(p => p.role === "input");
      const outputs = participants.filter(p => p.role === "output");
      if (inputs.length === 0 || outputs.length === 0) { setLoading(false); return; }

      const nodes = [
        ...inputs.map((p, i) => ({ name: `In ${i + 1}\n${(p.amount / 1e8).toFixed(5)} BTC` })),
        ...outputs.map((p, i) => ({ name: `Out ${i + 1}\n${(p.amount / 1e8).toFixed(5)} BTC` })),
      ];

      // Distribute each input proportionally to all outputs (CoinJoin merges funds)
      const totalIn = inputs.reduce((s, p) => s + p.amount, 0);
      const links: { source: number; target: number; value: number }[] = [];
      inputs.forEach((inp, si) => {
        outputs.forEach((out, ti) => {
          const value = Math.round((inp.amount / totalIn) * out.amount);
          if (value > 0) links.push({ source: si, target: inputs.length + ti, value });
        });
      });

      setSankeyData({ nodes, links });
    } finally {
      setLoading(false);
    }
  }, []);

  if (txids.length === 0) return null;

  return (
    <Card data-testid="container-coinjoin-flow-panel">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Shuffle className="h-4 w-4" />
          CoinJoin Fund-Flow Visualizer
        </CardTitle>
        <CardDescription className="text-xs">
          Sankey diagram of how inputs flow to outputs in a CoinJoin transaction. Equal output sizes make linkage ambiguous.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1 min-w-[200px] flex-1">
            <label className="text-xs text-muted-foreground">CoinJoin Transaction</label>
            <Select value={selectedTxid} onValueChange={setSelectedTxid}>
              <SelectTrigger data-testid="select-coinjoin-txid">
                <SelectValue placeholder="Select transaction" />
              </SelectTrigger>
              <SelectContent>
                {txids.slice(0, 30).map(t => (
                  <SelectItem key={t} value={t}>{t.substring(0, 20)}…</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="default"
            variant="outline"
            onClick={() => load(selectedTxid)}
            disabled={loading || !selectedTxid}
            data-testid="button-load-coinjoin-flow"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Shuffle className="h-4 w-4 mr-1" />}
            Visualize
          </Button>
        </div>

        {sankeyData && sankeyData.links.length > 0 && (
          <div className="overflow-x-auto" data-testid="container-coinjoin-sankey">
            <Sankey
              width={560}
              height={Math.max(160, sankeyData.nodes.length * 22)}
              data={sankeyData}
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
        )}

        {!loading && !sankeyData && (
          <p className="text-xs text-muted-foreground">
            Select a CoinJoin transaction and click Visualize to see the fund-flow diagram.
          </p>
        )}
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
  const [showWaterfall, setShowWaterfall] = useState(false);

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

            {/* Actions */}
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

            {/* CoinJoin fund-flow Sankey — shown when CoinJoin warnings are present */}
            {coinjoinWarningTxids.length > 0 && (
              <CoinJoinFlowPanel txids={coinjoinWarningTxids} />
            )}

            {/* Boltzmann panel */}
            {allFindingTxids.length > 0 && (
              <BoltzmannPanel txids={allFindingTxids} />
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

function FindingCard({ finding }: { finding: PrivacyFinding }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="border rounded-md p-3 space-y-2"
      data-testid={`card-finding-${finding.type.toLowerCase()}`}
    >
      <div className="flex items-start gap-2 flex-wrap">
        <Badge {...getSeverityBadgePropsLocal(finding.severity)} data-testid="badge-finding-severity">
          {finding.severity}
        </Badge>
        <p className="text-sm flex-1">{finding.description}</p>
        {finding.scoreDelta !== undefined && finding.scoreDelta < 0 && (
          <span className="text-xs text-red-500 dark:text-red-400 font-mono shrink-0" data-testid="text-score-delta">
            {finding.scoreDelta > -1 ? "<-1" : Math.round(finding.scoreDelta)} pts
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
                <div className="flex flex-wrap gap-1 mt-1">
                  {finding.txids.slice(0, 10).map((txid) => (
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

            <div
              className="bg-muted/50 rounded p-2 mt-2"
              data-testid="container-remediation"
            >
              <span className="text-xs font-medium text-muted-foreground">Remediation:</span>
              <p className="text-xs mt-0.5" data-testid="text-remediation">
                {finding.correction}
              </p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
