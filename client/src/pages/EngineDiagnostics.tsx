/**
 * Engine Diagnostics (Task #271, Step 1 hard gate).
 *
 * A go/no-go screen the user can run on their REAL vault to prove the SQLite
 * read-engine foundation is rock-solid before any screen is ported onto it.
 *
 * It surfaces, in plain numbers:
 *   - storage mode (is it actually persistent?), persisted flag, quota estimate,
 *   - a live seed from the vault with throughput,
 *   - a reopen check that proves data survives closing/reopening the database,
 *   - the on-disk database size,
 *   - real query latencies (record counts, paging, search, the owned-UTXO
 *     anti-join, per-address aggregates).
 *
 * Nothing here touches the live Dexie data paths — the engine is an isolated
 * read replica until it is proven here.
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, XCircle, AlertTriangle, Database, HardDrive, Gauge, RefreshCw, Play, Square, Trash2, FlaskConical } from "lucide-react";
import {
  ensureEngineInit,
  getEngineStatus,
  seedAll,
  cancelSeeding,
  reopenAndVerify,
  runQueryBenchmark,
  generateSynthetic,
  clearEngine,
  type InitResult,
  type EngineStatus,
  type SeedProgress,
  type SeedResult,
  type QueryBenchmarkResult,
} from "@/lib/engine/engine-client";

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

interface StatRowProps {
  label: string;
  value: React.ReactNode;
  testid: string;
}
function StatRow({ label, value, testid }: StatRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums" data-testid={testid}>
        {value}
      </span>
    </div>
  );
}

export default function EngineDiagnostics() {
  const { toast } = useToast();
  const [init, setInit] = useState<InitResult | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null);
  const [seedResults, setSeedResults] = useState<SeedResult[] | null>(null);
  const seedStartRef = useRef<number>(0);
  const [throughput, setThroughput] = useState<number>(0);

  const [reopen, setReopen] = useState<{ before: number; after: number; ok: boolean } | null>(null);
  const [bench, setBench] = useState<QueryBenchmarkResult[] | null>(null);

  const [synthAddresses, setSynthAddresses] = useState("5000");
  const [synthTx, setSynthTx] = useState("100000");

  const refreshStatus = async () => {
    try {
      const s = await getEngineStatus();
      setStatus(s);
    } catch (e) {
      /* surfaced elsewhere */
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const r = await ensureEngineInit();
        if (!mounted) return;
        setInit(r);
        await refreshStatus();
      } catch (e) {
        if (!mounted) return;
        setInitError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSeed = async () => {
    setBusy("seed");
    setSeedResults(null);
    setSeedProgress(null);
    seedStartRef.current = performance.now();
    try {
      const results = await seedAll((p) => {
        setSeedProgress(p);
        const elapsed = (performance.now() - seedStartRef.current) / 1000;
        if (elapsed > 0) setThroughput(p.processed / elapsed);
      });
      setSeedResults(results);
      await refreshStatus();
      const failed = results.find((r) => !r.complete && !r.cancelled);
      if (failed) {
        toast({ title: "Seed incomplete", description: `${failed.table} did not finish.`, variant: "destructive" });
      } else {
        toast({ title: "Seed complete", description: "All tables mirrored." });
      }
    } catch (e) {
      toast({ title: "Seed failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    await cancelSeeding();
  };

  const handleReopen = async () => {
    setBusy("reopen");
    try {
      const r = await reopenAndVerify();
      setReopen({ before: r.before, after: r.after, ok: r.after >= r.before && r.before > 0 });
      await refreshStatus();
    } catch (e) {
      toast({ title: "Reopen failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleBenchmark = async () => {
    setBusy("bench");
    try {
      const r = await runQueryBenchmark();
      setBench(r);
    } catch (e) {
      toast({ title: "Benchmark failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleSynthetic = async () => {
    setBusy("synthetic");
    try {
      const addresses = Math.max(1, parseInt(synthAddresses, 10) || 0);
      const transactions = Math.max(1, parseInt(synthTx, 10) || 0);
      const res = await generateSynthetic({ addresses, transactions, participantsPerTx: 4, spentFraction: 0.5 });
      await refreshStatus();
      toast({
        title: "Synthetic data generated",
        description: `${fmtNum(res.records)} records, ${fmtNum(res.transactions)} txs, ${fmtNum(res.participants)} participants.`,
      });
    } catch (e) {
      toast({ title: "Generation failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy("clear");
    try {
      await clearEngine();
      setSeedResults(null);
      setReopen(null);
      setBench(null);
      await refreshStatus();
      toast({ title: "Engine cleared" });
    } catch (e) {
      toast({ title: "Clear failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const persistent = init?.storageMode === "opfs-sahpool";

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <FlaskConical className="h-6 w-6" />
            Engine Diagnostics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Proves the off-thread SQLite read-engine is solid at scale before any screen uses it. Safe to run on your real
            vault — it only reads your data into a separate, isolated database.
          </p>
        </div>

        {initError && (
          <Card className="border-destructive">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <XCircle className="h-5 w-5" /> Engine failed to start
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm" data-testid="text-init-error">{initError}</p>
            </CardContent>
          </Card>
        )}

        {/* Storage / persistence */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" /> Storage
            </CardTitle>
            <CardDescription>Is the engine database actually persistent on this machine?</CardDescription>
          </CardHeader>
          <CardContent>
            {!init ? (
              <p className="text-sm text-muted-foreground">Starting engine…</p>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-4 py-1.5">
                  <span className="text-sm text-muted-foreground">Storage mode</span>
                  {persistent ? (
                    <Badge data-testid="badge-storage-mode" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" /> OPFS (persistent)
                    </Badge>
                  ) : (
                    <Badge variant="destructive" data-testid="badge-storage-mode" className="gap-1">
                      <AlertTriangle className="h-3 w-3" /> In-memory (NOT persistent)
                    </Badge>
                  )}
                </div>
                <StatRow label="Durable storage granted" value={init.persisted == null ? "unknown" : init.persisted ? "yes" : "no"} testid="text-persisted" />
                <StatRow label="SQLite version" value={init.sqliteVersion} testid="text-sqlite-version" />
                <StatRow label="Storage used" value={fmtBytes(init.estimate.usage)} testid="text-storage-usage" />
                <StatRow label="Storage quota" value={fmtBytes(init.estimate.quota)} testid="text-storage-quota" />
                {!persistent && (
                  <p className="text-sm text-destructive mt-2" data-testid="text-no-persist-warning">
                    OPFS is unavailable here, so the engine cannot persist. Seeding a large vault into memory is blocked to
                    avoid crashing. This is a no-go until persistent storage works.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Seed */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" /> Mirror your vault
              </CardTitle>
              <CardDescription>Copies records, transactions and participants into the engine (resumable).</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {busy === "seed" ? (
                <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-seed">
                  <Square className="h-4 w-4" /> Cancel
                </Button>
              ) : (
                <Button onClick={handleSeed} disabled={!!busy || !init} data-testid="button-seed">
                  <Play className="h-4 w-4" /> Seed from vault
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {seedProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground capitalize">{seedProgress.table}</span>
                  <span className="tabular-nums" data-testid="text-seed-progress">
                    {fmtNum(seedProgress.processed)} / {fmtNum(seedProgress.total)}
                  </span>
                </div>
                <Progress value={seedProgress.total > 0 ? (seedProgress.processed / seedProgress.total) * 100 : 0} />
                <div className="text-xs text-muted-foreground tabular-nums" data-testid="text-throughput">
                  {fmtNum(Math.round(throughput))} rows/sec
                </div>
              </div>
            )}

            {/* Per-table status */}
            {status && (
              <div className="space-y-1">
                <Separator className="my-2" />
                {status.seedMeta.map((m) => {
                  const counts = status.counts as unknown as Record<string, number>;
                  const live = counts[m.tableName] ?? 0;
                  return (
                    <div key={m.tableName} className="flex items-center justify-between gap-4 py-1" data-testid={`row-table-${m.tableName}`}>
                      <span className="text-sm">{m.tableName}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {fmtNum(live)} mirrored{m.sourceCount > 0 ? ` / ${fmtNum(m.sourceCount)} source` : ""}
                        </span>
                        {m.complete ? (
                          <Badge variant="secondary" className="gap-1">
                            <CheckCircle2 className="h-3 w-3" /> ready
                          </Badge>
                        ) : (
                          <Badge variant="outline">pending</Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {seedResults && (
              <div className="text-xs text-muted-foreground" data-testid="text-seed-results">
                {seedResults.map((r) => (
                  <div key={r.table}>
                    {r.table}: {fmtNum(r.copied)} rows in {fmtMs(r.durationMs)}
                    {r.cancelled ? " (cancelled)" : r.complete ? " ✓" : " (incomplete)"}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Persistence reopen + DB size */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <RefreshCw className="h-5 w-5" /> Persistence check
              </CardTitle>
              <CardDescription>Closes and reopens the engine database to prove data survives.</CardDescription>
            </div>
            <Button variant="outline" onClick={handleReopen} disabled={!!busy || !init} data-testid="button-reopen">
              <RefreshCw className="h-4 w-4" /> Reopen &amp; verify
            </Button>
          </CardHeader>
          <CardContent>
            <StatRow label="Engine DB file size" value={fmtBytes(status?.fileStats.sizeBytes)} testid="text-db-size" />
            {reopen && (
              <div className="flex items-center justify-between gap-4 py-1.5">
                <span className="text-sm text-muted-foreground">Rows before / after reopen</span>
                <span className="flex items-center gap-2 text-sm font-medium tabular-nums" data-testid="text-reopen-result">
                  {fmtNum(reopen.before)} / {fmtNum(reopen.after)}
                  {reopen.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Benchmark */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Gauge className="h-5 w-5" /> Query latencies
              </CardTitle>
              <CardDescription>How fast the heavy reads run on the mirrored data.</CardDescription>
            </div>
            <Button variant="outline" onClick={handleBenchmark} disabled={!!busy || !init} data-testid="button-benchmark">
              <Gauge className="h-4 w-4" /> Run benchmark
            </Button>
          </CardHeader>
          <CardContent>
            {!bench ? (
              <p className="text-sm text-muted-foreground">Run the benchmark to see numbers.</p>
            ) : (
              <div className="space-y-1">
                {bench.map((b) => (
                  <div key={b.label} className="flex items-center justify-between gap-4 py-1" data-testid={`row-bench-${b.label.replace(/\W+/g, "-")}`}>
                    <span className="text-sm text-muted-foreground">{b.label}</span>
                    <span className="text-sm font-medium tabular-nums">
                      {fmtMs(b.ms)} <span className="text-muted-foreground">({fmtNum(b.rows)} rows)</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Synthetic data (benchmarking lever) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5" /> Synthetic load test
            </CardTitle>
            <CardDescription>
              Generates fake data directly in the engine to benchmark at scale without touching your vault.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label htmlFor="synth-addresses">Address records</Label>
                <Input
                  id="synth-addresses"
                  value={synthAddresses}
                  onChange={(e) => setSynthAddresses(e.target.value)}
                  className="w-40"
                  data-testid="input-synth-addresses"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="synth-tx">Transactions</Label>
                <Input
                  id="synth-tx"
                  value={synthTx}
                  onChange={(e) => setSynthTx(e.target.value)}
                  className="w-40"
                  data-testid="input-synth-tx"
                />
              </div>
              <Button variant="outline" onClick={handleSynthetic} disabled={!!busy || !init} data-testid="button-generate-synthetic">
                <FlaskConical className="h-4 w-4" /> Generate
              </Button>
              <Button variant="ghost" onClick={handleClear} disabled={!!busy || !init} data-testid="button-clear-engine">
                <Trash2 className="h-4 w-4" /> Clear engine
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Tip: generate a few million participants (≈ a large vault), then run the benchmark above to see real latencies.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
