/**
 * Database Doctor (Task #325).
 *
 * A strictly READ-ONLY diagnostic that reads raw rows straight from IndexedDB
 * via Dexie (`db`), bypassing the native read-engine and every normal read hook.
 * Its single job is to answer, in plain language, the question every other
 * screen has been failing to answer: "Is my data actually there and readable,
 * or is it still locked/blank?"
 *
 * It writes NOTHING. It never decrypts (so it needs no password) — it only
 * observes which fields are populated, which rows still carry the legacy
 * encryption markers left behind when the v27 migration stripped the encryption
 * flags without decrypting, and whether the one-time login decrypt + search
 * index repair ever completed.
 *
 * Reads are done in id-keyset batches with a yield between each so it stays
 * responsive even on very large vaults.
 */
import { useCallback, useState } from "react";
import { Link } from "wouter";
import {
  Stethoscope,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Lock,
  Database,
  ArrowLeft,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { db } from "@/lib/database";
import {
  isLegacyDecryptComplete,
  getLegacyDecryptCompletedTables,
  isInputStringLowerRepaired,
} from "@/lib/vault";

// The markers the v27 migration left on rows whose ciphertext was preserved but
// never decrypted. Presence of `_legacyEncryptedPayload` means the row's real
// fields are still locked away and the visible fields are blank.
const LEGACY_MARKER_KEYS = ["_legacyEncryptedPayload", "isEncrypted", "encryptedPayload"] as const;

const BATCH_SIZE = 1000;
const SAMPLE_SIZE = 20;
const MAX_PREVIEW_CHARS = 64;

type Phase = "idle" | "scanning" | "done" | "error";

interface TableCount {
  name: string;
  count: number;
  error: boolean;
}

interface RecordStats {
  total: number;
  blankInputString: number;
  populatedInputString: number;
  blankInputStringLower: number;
  blankLabel: number;
  lockedUnreadable: number; // payload present AND inputString blank — the true "locked" signature
  markersRemaining: number; // rows carrying any leftover marker key (harmless cleanup candidates)
}

interface SampleRow {
  id: number | string;
  type: string;
  inputStringPreview: string;
  inputStringBlank: boolean;
  inputStringLowerBlank: boolean;
  labelPreview: string;
  labelBlank: boolean;
  lockedUnreadable: boolean;
  hasMarker: boolean;
}

interface MigrationFlags {
  legacyDecryptComplete: boolean;
  completedTables: string[];
  inputStringLowerRepaired: boolean;
}

interface DoctorResult {
  tableCounts: TableCount[];
  recordStats: RecordStats;
  samples: SampleRow[];
  flags: MigrationFlags;
}

type RawRow = globalThis.Record<string, unknown>;

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function preview(value: unknown): string {
  if (isBlank(value)) return "";
  const str = String(value);
  return str.length > MAX_PREVIEW_CHARS ? `${str.slice(0, MAX_PREVIEW_CHARS)}…` : str;
}

// True when the row still carries its encrypted payload. IMPORTANT: the decrypt
// flow deliberately KEEPS this marker after successfully restoring the plaintext
// fields — it is the only recoverable copy until the separate strip/cleanup step
// removes it. So a payload alone does NOT mean the row is unreadable. The real
// "still locked" signature is the payload present AND a blank inputString.
function hasEncryptedPayload(row: RawRow): boolean {
  const payload = row["_legacyEncryptedPayload"];
  return typeof payload === "string" && payload.length > 0;
}

// The genuine "still locked" case: encrypted data is present but the real value
// was never restored (inputString blank). These are the records that make every
// screen look empty.
function isLockedUnreadable(row: RawRow): boolean {
  return hasEncryptedPayload(row) && isBlank(row["inputString"]);
}

function hasAnyMarker(row: RawRow): boolean {
  for (const key of LEGACY_MARKER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const v = row[key];
      // A leftover `false`/empty marker still counts as "present" — it tells us
      // the strip pass touched this row.
      if (v !== undefined) return true;
    }
  }
  return false;
}

export default function DatabaseDoctor() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<DoctorResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isScanning = phase === "scanning";

  const runCheck = useCallback(async () => {
    setPhase("scanning");
    setProgress("Reading migration status…");
    setErrorMessage(null);
    setResult(null);

    try {
      // 1. Migration flags (from the separate vault settings DB).
      const [legacyDecryptComplete, completedTables, inputStringLowerRepaired] = await Promise.all([
        isLegacyDecryptComplete().catch(() => false),
        getLegacyDecryptCompletedTables().catch(() => [] as string[]),
        isInputStringLowerRepaired().catch(() => false),
      ]);

      // 2. Per-table counts for every table in the vault.
      setProgress("Counting rows in every table…");
      const tableCounts: TableCount[] = [];
      for (const table of db.tables) {
        try {
          const count = await table.count();
          tableCounts.push({ name: table.name, count, error: false });
        } catch {
          tableCounts.push({ name: table.name, count: 0, error: true });
        }
      }
      tableCounts.sort((a, b) => a.name.localeCompare(b.name));

      // 3. Deep scan of the records table in id-keyset batches.
      const recordStats: RecordStats = {
        total: 0,
        blankInputString: 0,
        populatedInputString: 0,
        blankInputStringLower: 0,
        blankLabel: 0,
        lockedUnreadable: 0,
        markersRemaining: 0,
      };
      const samples: SampleRow[] = [];

      let lastId = 0;
      let hasMore = true;
      while (hasMore) {
        let chunk: RawRow[];
        try {
          chunk = (await db.records
            .where("id")
            .above(lastId)
            .limit(BATCH_SIZE)
            .toArray()) as unknown as RawRow[];
        } catch (err) {
          throw new Error(
            `Failed reading the records table: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (chunk.length === 0) break;
        lastId = Number(chunk[chunk.length - 1].id);

        for (const row of chunk) {
          recordStats.total += 1;

          const inputBlank = isBlank(row["inputString"]);
          if (inputBlank) recordStats.blankInputString += 1;
          else recordStats.populatedInputString += 1;

          if (isBlank(row["inputStringLower"])) recordStats.blankInputStringLower += 1;
          if (isBlank(row["label"])) recordStats.blankLabel += 1;

          const lockedUnreadable = isLockedUnreadable(row);
          const marker = hasAnyMarker(row);
          if (lockedUnreadable) recordStats.lockedUnreadable += 1;
          if (marker) recordStats.markersRemaining += 1;

          if (samples.length < SAMPLE_SIZE) {
            samples.push({
              id: (row["id"] as number | undefined) ?? "—",
              type: typeof row["type"] === "string" ? (row["type"] as string) : "—",
              inputStringPreview: preview(row["inputString"]),
              inputStringBlank: inputBlank,
              inputStringLowerBlank: isBlank(row["inputStringLower"]),
              labelPreview: preview(row["label"]),
              labelBlank: isBlank(row["label"]),
              lockedUnreadable,
              hasMarker: marker,
            });
          }
        }

        setProgress(`Checked ${recordStats.total.toLocaleString()} records…`);
        if (chunk.length < BATCH_SIZE) hasMore = false;
        // Yield so the UI stays responsive on large vaults.
        await new Promise((r) => setTimeout(r, 0));
      }

      setResult({
        tableCounts,
        recordStats,
        samples,
        flags: { legacyDecryptComplete, completedTables, inputStringLowerRepaired },
      });
      setPhase("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    } finally {
      setProgress("");
    }
  }, []);

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="space-y-2">
          <Link href="/settings">
            <Button variant="ghost" size="sm" data-testid="link-back-settings">
              <ArrowLeft className="h-4 w-4" />
              Back to Settings
            </Button>
          </Link>
          <h1
            className="text-2xl font-semibold flex items-center gap-2"
            data-testid="text-page-title"
          >
            <Stethoscope className="h-6 w-6" />
            Database Doctor
          </h1>
          <p className="text-sm text-muted-foreground">
            A safe, read-only health check. It looks directly at your stored data and tells you, in
            plain language, whether your records are actually there and readable — or whether they
            are still locked from an unfinished migration. It never changes, deletes, or unlocks
            anything.
          </p>
        </div>

        <Card data-testid="card-run-check">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Run the health check
            </CardTitle>
            <CardDescription>
              No password needed. This reads your data exactly as it is stored, without decrypting
              anything.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button onClick={runCheck} disabled={isScanning} data-testid="button-run-check">
              {isScanning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {isScanning ? "Checking…" : "Run health check"}
            </Button>
            {isScanning && progress && (
              <p className="text-sm text-muted-foreground" data-testid="text-progress">
                {progress}
              </p>
            )}
          </CardContent>
        </Card>

        {phase === "error" && errorMessage && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-4 flex items-start gap-2"
            data-testid="banner-error"
          >
            <XCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
            <div className="text-sm text-destructive">{errorMessage}</div>
          </div>
        )}

        {phase === "done" && result && <Verdict result={result} />}

        {phase === "done" && result && (
          <>
            <RecordHealthCard stats={result.recordStats} flags={result.flags} />
            <SamplesCard samples={result.samples} />
            <TableCountsCard tableCounts={result.tableCounts} />
            <MigrationStatusCard flags={result.flags} />
          </>
        )}
      </div>
    </div>
  );
}

function Verdict({ result }: { result: DoctorResult }) {
  const { recordStats, flags } = result;

  let tone: "good" | "bad" | "warn" = "good";
  let title = "Your data looks healthy and readable.";
  const lines: string[] = [];

  if (recordStats.total === 0) {
    tone = "warn";
    title = "Your vault has no records at all.";
    lines.push(
      "The records table is empty. If you expected data here, it may be stored in a different vault file, or it was never imported.",
    );
  } else if (recordStats.lockedUnreadable > 0 || recordStats.blankInputString > 0) {
    tone = "bad";
    title = "Some records are present but their contents are missing.";
    if (recordStats.lockedUnreadable > 0) {
      lines.push(
        `${recordStats.lockedUnreadable.toLocaleString()} of ${recordStats.total.toLocaleString()} records still hold locked (encrypted) data that was never unlocked — their visible fields are blank, which is why those records show as empty everywhere.`,
      );
    }
    const blankNoPayload = recordStats.blankInputString - recordStats.lockedUnreadable;
    if (blankNoPayload > 0) {
      lines.push(
        `${blankNoPayload.toLocaleString()} records have a blank address/transaction with no recoverable encrypted data (blank or incomplete).`,
      );
    }
    if (recordStats.lockedUnreadable > 0 && !flags.legacyDecryptComplete) {
      lines.push(
        "The one-time unlock that runs when you log in has not finished. Logging out and back in with your correct vault password lets it try again.",
      );
    }
  } else if (recordStats.blankInputStringLower > 0) {
    tone = "warn";
    title = "Your records have data, but the search index is incomplete.";
    lines.push(
      `${recordStats.blankInputStringLower.toLocaleString()} records are missing their lowercase search key, so search may not find them. This is repaired automatically the next time you log in.`,
    );
  } else {
    lines.push(
      `All ${recordStats.total.toLocaleString()} records have their data populated and none are locked.`,
    );
    if (!flags.legacyDecryptComplete) {
      tone = "warn";
      lines.push(
        "Note: the migration is not yet marked complete, even though the data looks readable. It will be confirmed on your next login.",
      );
    }
  }

  // Leftover markers are NORMAL after a successful unlock — the decrypt step keeps
  // them until the separate cleanup tool removes them. Only mention them (as a
  // harmless note) when the data is actually readable, so we never imply locked
  // data when there is none.
  if (
    recordStats.markersRemaining > 0 &&
    recordStats.lockedUnreadable === 0 &&
    recordStats.blankInputString === 0
  ) {
    lines.push(
      `${recordStats.markersRemaining.toLocaleString()} records still carry leftover migration markers. This is harmless — your data is readable — but you can tidy them up with the cleanup tool in Settings.`,
    );
  }

  const styles: globalThis.Record<typeof tone, string> = {
    good: "border-green-600/40 bg-green-600/10 dark:border-green-400/40 dark:bg-green-400/10",
    warn: "border-yellow-600/40 bg-yellow-600/10 dark:border-yellow-400/40 dark:bg-yellow-400/10",
    bad: "border-destructive/40 bg-destructive/10",
  };

  const Icon = tone === "good" ? CheckCircle2 : tone === "warn" ? AlertTriangle : XCircle;
  const iconColor =
    tone === "good"
      ? "text-green-600 dark:text-green-400"
      : tone === "warn"
        ? "text-yellow-600 dark:text-yellow-400"
        : "text-destructive";

  return (
    <div className={`rounded-md border p-4 flex items-start gap-3 ${styles[tone]}`} data-testid="banner-verdict">
      <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${iconColor}`} />
      <div className="space-y-1">
        <div className="font-medium" data-testid="text-verdict-title">
          {title}
        </div>
        {lines.map((line, i) => (
          <p key={i} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function StatLine({
  label,
  value,
  testid,
  highlight,
}: {
  label: string;
  value: string;
  testid: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={`text-sm font-medium tabular-nums ${highlight ? "text-destructive" : ""}`}
        data-testid={testid}
      >
        {value}
      </span>
    </div>
  );
}

function RecordHealthCard({ stats, flags }: { stats: RecordStats; flags: MigrationFlags }) {
  return (
    <Card data-testid="card-record-health">
      <CardHeader>
        <CardTitle>Records breakdown</CardTitle>
        <CardDescription>
          A detailed look at the records table — the one that feeds nearly every screen.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StatLine label="Total records" value={stats.total.toLocaleString()} testid="stat-total" />
        <StatLine
          label="With a populated address/transaction"
          value={stats.populatedInputString.toLocaleString()}
          testid="stat-populated-input"
        />
        <StatLine
          label="With a blank address/transaction"
          value={stats.blankInputString.toLocaleString()}
          testid="stat-blank-input"
          highlight={stats.blankInputString > 0}
        />
        <StatLine
          label="Missing lowercase search key"
          value={stats.blankInputStringLower.toLocaleString()}
          testid="stat-blank-input-lower"
          highlight={stats.blankInputStringLower > 0}
        />
        <StatLine
          label="With a blank label"
          value={stats.blankLabel.toLocaleString()}
          testid="stat-blank-label"
        />
        <Separator className="my-2" />
        <StatLine
          label="Locked & unreadable (encrypted, never unlocked)"
          value={stats.lockedUnreadable.toLocaleString()}
          testid="stat-locked-unreadable"
          highlight={stats.lockedUnreadable > 0}
        />
        <StatLine
          label="Carrying leftover cleanup markers (harmless)"
          value={stats.markersRemaining.toLocaleString()}
          testid="stat-markers-remaining"
        />
        {stats.lockedUnreadable > 0 && !flags.legacyDecryptComplete && (
          <p className="text-xs text-muted-foreground mt-2">
            The login-time unlock is not marked complete, so the locked records above have not been
            recovered yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SamplesCard({ samples }: { samples: SampleRow[] }) {
  return (
    <Card data-testid="card-samples">
      <CardHeader>
        <CardTitle>First {samples.length} records (raw)</CardTitle>
        <CardDescription>
          Exactly what is stored for your first records. A "Locked" tag means the real values are
          still encrypted and the visible fields below are blank. A "Recovered · marker" tag means
          the data was unlocked but a harmless leftover marker remains.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {samples.length === 0 ? (
          <p className="text-sm text-muted-foreground italic" data-testid="text-no-samples">
            No records found.
          </p>
        ) : (
          <div className="space-y-2">
            {samples.map((s) => (
              <div
                key={String(s.id)}
                className="rounded-md border p-3 space-y-1"
                data-testid={`sample-row-${s.id}`}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-mono text-xs text-muted-foreground">
                    #{s.id} · {s.type}
                  </span>
                  {s.lockedUnreadable ? (
                    <Badge variant="destructive" className="gap-1">
                      <Lock className="h-3 w-3" />
                      Locked
                    </Badge>
                  ) : s.hasMarker ? (
                    <Badge variant="outline" className="gap-1" data-testid={`badge-recovered-${s.id}`}>
                      Recovered · marker
                    </Badge>
                  ) : null}
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Address/Tx: </span>
                  {s.inputStringBlank ? (
                    <span className="italic text-destructive" data-testid={`sample-input-blank-${s.id}`}>
                      (blank)
                    </span>
                  ) : (
                    <span className="font-mono break-all">{s.inputStringPreview}</span>
                  )}
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Label: </span>
                  {s.labelBlank ? (
                    <span className="italic text-muted-foreground">(blank)</span>
                  ) : (
                    <span className="break-all">{s.labelPreview}</span>
                  )}
                </div>
                {!s.inputStringBlank && s.inputStringLowerBlank && (
                  <div className="text-xs text-yellow-600 dark:text-yellow-400">
                    Missing lowercase search key — search may not find this record.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TableCountsCard({ tableCounts }: { tableCounts: TableCount[] }) {
  return (
    <Card data-testid="card-table-counts">
      <CardHeader>
        <CardTitle>All tables</CardTitle>
        <CardDescription>How many rows are stored in each part of your vault.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {tableCounts.map((t) => (
            <div
              key={t.name}
              className="flex items-center justify-between gap-4 py-1"
              data-testid={`table-count-${t.name}`}
            >
              <span className="text-sm font-mono">{t.name}</span>
              {t.error ? (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  read error
                </Badge>
              ) : (
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t.count.toLocaleString()}
                </span>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function MigrationStatusCard({ flags }: { flags: MigrationFlags }) {
  return (
    <Card data-testid="card-migration-status">
      <CardHeader>
        <CardTitle>Migration status</CardTitle>
        <CardDescription>
          Whether the one-time data unlock and search-index repair have finished.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-4 py-1.5">
          <span className="text-sm text-muted-foreground">Data unlock complete</span>
          {flags.legacyDecryptComplete ? (
            <Badge variant="secondary" className="gap-1" data-testid="badge-decrypt-complete">
              <CheckCircle2 className="h-3 w-3" />
              yes
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1" data-testid="badge-decrypt-incomplete">
              <XCircle className="h-3 w-3" />
              not finished
            </Badge>
          )}
        </div>
        <div className="flex items-center justify-between gap-4 py-1.5">
          <span className="text-sm text-muted-foreground">Search index repaired</span>
          {flags.inputStringLowerRepaired ? (
            <Badge variant="secondary" className="gap-1" data-testid="badge-search-repaired">
              <CheckCircle2 className="h-3 w-3" />
              yes
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1" data-testid="badge-search-not-repaired">
              not yet
            </Badge>
          )}
        </div>
        <div className="flex items-start justify-between gap-4 py-1.5">
          <span className="text-sm text-muted-foreground shrink-0">Tables already unlocked</span>
          <span className="text-sm text-right break-words" data-testid="text-completed-tables">
            {flags.completedTables.length > 0 ? flags.completedTables.join(", ") : "none"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
