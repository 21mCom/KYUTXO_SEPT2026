/**
 * Engine Diagnostics (Task #272, Step 1 hard gate).
 *
 * A go/no-go screen the user runs on their REAL vault to prove the NATIVE
 * better-sqlite3 read-engine is rock-solid before any screen is ported onto it.
 *
 * It surfaces, in plain numbers:
 *   - where the engine database lives (the USB in portable mode) and its state,
 *   - a live full-rebuild seed from the vault with throughput,
 *   - an explicit PRAGMA integrity_check,
 *   - a reopen check that proves data survives closing/reopening the database,
 *   - the on-disk database size,
 *   - real query latencies (record counts, paging, search, the owned-UTXO
 *     anti-join, per-address aggregates).
 *
 * The engine runs only in the desktop app (it is a Node-side worker_thread), so
 * in the browser preview this page shows a desktop-only notice. Nothing here
 * touches the live Dexie data paths — the engine is an isolated read replica
 * until it is proven here.
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
import { CheckCircle2, XCircle, AlertTriangle, Database, HardDrive, Gauge, RefreshCw, Play, Square, Trash2, FlaskConical, ShieldCheck, MonitorSmartphone } from "lucide-react";
import {
  isEngineAvailable,
  ensureEngineInit,
  getEngineStatus,
  getDbInfo,
  seedAll,
  cancelSeeding,
  reopenAndVerify,
  engineIntegrityCheck,
  runQueryBenchmark,
  generateSynthetic,
  clearEngine,
  ENGINE_UNAVAILABLE_MESSAGE,
  type EngineSnapshot,
  type EngineState,
  type DbInfo,
  type SeedProgress,
  type SeedResult,
  type BenchmarkRow,
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

const STATE_VARIANT: Record<EngineState, "default" | "secondary" | "destructive" | "outline"> = {
  EMPTY: "outline",
  LOADING: "secondary",
  INDEXING: "secondary",
  READY: "default",
  ERROR: "destructive",
};

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
  const available = isEngineAvailable();
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null);
  const [seedResults, setSeedResults] = useState<SeedResult[] | null>(null);
  const seedStartRef = useRef<number>(0);
  const [throughput, setThroughput] = useState<number>(0);

  const [reopen, setReopen] = useState<{ before: number; after: number; ok: boolean } | null>(null);
  const [integrity, setIntegrity] = useState<string | null>(null);
  const [bench, setBench] = useState<BenchmarkRow[] | null>(null);

  const [synthAddresses, setSynthAddresses] = useState("5000");
  const [synthTx, setSynthTx] = useState("100000");

  const refreshStatus = async () => {
    try {
      setSnapshot(await getEngineStatus());
    } catch {
      /* surfaced elsewhere */
    }
  };

  useEffect(() => {
    if (!available) return;
    let mounted = true;
    (async () => {
      try {
        const snap = await ensureEngineInit();
        if (!mounted) return;
        setSnapshot(snap);
        try {
          setDbInfo(await getDbInfo());
        } catch {
          /* path is informational */
        }
      } catch (e) {
        if (!mounted) return;
        setInitError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [available]);

  const handleSeed = async () => {
    setBusy("seed");
    setSeedResults(null);
    setSeedProgress(null);
    setThroughput(0);
    seedStartRef.current = performance.now();
    try {
      const results = await seedAll((p) => {
        setSeedProgress(p);
        const elapsed = (performance.now() - seedStartRef.current) / 1000;
        if (elapsed > 0) setThroughput(p.processed / elapsed);
      });
      setSeedResults(results);
      await refreshStatus();
      const cancelled = results.some((r) => r.cancelled);
      if (cancelled) {
        toast({ title: "Seed cancelled", description: "The engine was reset to empty.", variant: "destructive" });
      } else {
        toast({ title: "Seed complete", description: "Vault mirrored, indexed and verified." });
      }
    } catch (e) {
      toast({ title: "Seed failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      await refreshStatus();
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = () => {
    cancelSeeding();
  };

  const handleReopen = async () => {
    setBusy("reopen");
    try {
      const r = await reopenAndVerify();
      setReopen({ before: r.before, after: r.after, ok: r.ready && r.after >= r.before && r.before > 0 });
      await refreshStatus();
    } catch (e) {
      toast({ title: "Reopen failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleIntegrity = async () => {
    setBusy("integrity");
    try {
      setIntegrity(await engineIntegrityCheck());
    } catch (e) {
      toast({ title: "Integrity check failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleBenchmark = async () => {
    setBusy("bench");
    try {
      setBench(await runQueryBenchmark());
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
      await refreshStatus();
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
      setIntegrity(null);
      setBench(null);
      await refreshStatus();
      toast({ title: "Engine cleared" });
    } catch (e) {
      toast({ title: "Clear failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const state = snapshot?.state ?? "EMPTY";
  const integrityOk = integrity === "ok";

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <FlaskConical className="h-6 w-6" />
            Engine Diagnostics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Proves the native, off-thread SQLite read-engine is solid at scale before any screen uses it. Safe to run on
            your real vault — it only reads your data into a separate, isolated database.
          </p>
        </div>

        {!available ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MonitorSmartphone className="h-5 w-5" /> Desktop app required
              </CardTitle>
              <CardDescription>This diagnostic runs only in the KYUTXO desktop application.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground" data-testid="text-desktop-only">
                {ENGINE_UNAVAILABLE_MESSAGE}
              </p>
            </CardContent>
          </Card>
        ) : initError ? (
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
        ) : (
          <>
            {/* Engine database */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5" /> Engine database
                </CardTitle>
                <CardDescription>A single native SQLite file that lives next to your vault data.</CardDescription>
              </CardHeader>
              <CardContent>
                {!snapshot ? (
                  <p className="text-sm text-muted-foreground">Starting engine…</p>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-4 py-1.5">
                      <span className="text-sm text-muted-foreground">State</span>
                      <Badge variant={STATE_VARIANT[state]} data-testid="badge-engine-state" className="gap-1">
                        {state === "READY" ? <CheckCircle2 className="h-3 w-3" /> : state === "ERROR" ? <AlertTriangle className="h-3 w-3" /> : null}
                        {state}
                      </Badge>
                    </div>
                    <StatRow label="Ready for reads" value={snapshot.ready ? "yes" : "no"} testid="text-ready" />
                    <StatRow
                      label="Storage"
                      value={dbInfo?.portableMode ? "Portable (USB)" : "App data folder"}
                      testid="text-portable-mode"
                    />
                    <div className="flex items-start justify-between gap-4 py-1.5">
                      <span className="text-sm text-muted-foreground shrink-0">Database file</span>
                      <span className="text-sm font-medium break-all text-right" data-testid="text-db-path">
                        {dbInfo?.dbPath ?? snapshot.dbPath ?? "—"}
                      </span>
                    </div>
                    <StatRow label="Database file size" value={fmtBytes(snapshot.fileStats?.sizeBytes)} testid="text-db-size" />
                    {snapshot.errorMessage && (
                      <p className="text-sm text-destructive mt-2" data-testid="text-engine-error">{snapshot.errorMessage}</p>
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
                  <CardDescription>
                    Full rebuild: copies records, transactions and participants into the engine, then builds indexes and
                    verifies. Cancelling resets the engine to empty.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {busy === "seed" ? (
                    <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-seed">
                      <Square className="h-4 w-4" /> Cancel
                    </Button>
                  ) : (
                    <Button onClick={handleSeed} disabled={!!busy || !snapshot} data-testid="button-seed">
                      <Play className="h-4 w-4" /> Seed from vault
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {seedProgress && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-muted-foreground">{seedProgress.table}</span>
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
                {snapshot && (
                  <div className="space-y-1">
                    <Separator className="my-2" />
                    {snapshot.seedMeta.map((m) => {
                      const counts = snapshot.counts as unknown as Record<string, number>;
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
                        {r.cancelled ? " (cancelled)" : r.complete ? " — done" : " (incomplete)"}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Integrity check */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5" /> Integrity check
                  </CardTitle>
                  <CardDescription>Runs PRAGMA integrity_check across the whole database.</CardDescription>
                </div>
                <Button variant="outline" onClick={handleIntegrity} disabled={!!busy || !snapshot} data-testid="button-integrity">
                  <ShieldCheck className="h-4 w-4" /> Run integrity check
                </Button>
              </CardHeader>
              <CardContent>
                {integrity == null ? (
                  <p className="text-sm text-muted-foreground">Run the check to confirm the database is not corrupt.</p>
                ) : (
                  <div className="flex items-center justify-between gap-4 py-1.5">
                    <span className="text-sm text-muted-foreground">Result</span>
                    <span className="flex items-center gap-2 text-sm font-medium" data-testid="text-integrity-result">
                      {integrityOk ? "ok" : integrity}
                      {integrityOk ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive" />
                      )}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Persistence reopen */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <RefreshCw className="h-5 w-5" /> Persistence check
                  </CardTitle>
                  <CardDescription>Closes and reopens the engine database to prove data survives.</CardDescription>
                </div>
                <Button variant="outline" onClick={handleReopen} disabled={!!busy || !snapshot} data-testid="button-reopen">
                  <RefreshCw className="h-4 w-4" /> Reopen &amp; verify
                </Button>
              </CardHeader>
              <CardContent>
                {reopen ? (
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
                ) : (
                  <p className="text-sm text-muted-foreground">Seed first, then reopen to prove the data is durable.</p>
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
                <Button variant="outline" onClick={handleBenchmark} disabled={!!busy || !snapshot} data-testid="button-benchmark">
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
                  Generates fake data directly in the engine to benchmark at scale without touching your vault. This
                  replaces the engine contents.
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
                  <Button variant="outline" onClick={handleSynthetic} disabled={!!busy || !snapshot} data-testid="button-generate-synthetic">
                    <FlaskConical className="h-4 w-4" /> Generate
                  </Button>
                  <Button variant="ghost" onClick={handleClear} disabled={!!busy || !snapshot} data-testid="button-clear-engine">
                    <Trash2 className="h-4 w-4" /> Clear engine
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Tip: generate a few million participants (≈ a large vault), then run the benchmark above to see real
                  latencies on this machine.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
