/**
 * Database Doctor (Task #325).
 *
 * A strictly READ-ONLY diagnostic that reads raw rows straight from IndexedDB
 * via Dexie (`db`), bypassing the native read-engine and every normal read hook.
 * Its single job is to answer, in plain language, the question every other
 * screen has been failing to answer: "Is my data actually there and readable,
 * or is it still locked/blank?"
 *
 * It writes NOTHING to vault data. It never decrypts (so it needs no password)
 * — it only observes which fields are populated, which rows still carry the
 * legacy encryption markers left behind when the v27 migration stripped the
 * encryption flags without decrypting, and whether the one-time login decrypt +
 * search index repair ever completed. (The Balance Integrity card additionally
 * spools its stale-address report to a separate, local IndexedDB scratch store
 * — never the vault — see BalanceIntegrityCard below.)
 *
 * Reads are done in id-keyset batches with a yield between each so it stays
 * responsive even on very large vaults.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  Scale,
  RefreshCw,
  Ban,
  ExternalLink,
  ListChecks,
  Download,
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
import { isEncryptedPlaceholder } from "@/lib/legacy-decrypt";
import {
  detectStaleCachedBalances,
  recomputeAddressStats,
  type StaleBalanceCheckResult,
  type StaleAddressDetail,
} from "@/lib/data/address-stats";
import {
  clearStaleReport,
  appendStaleReportRows,
  getStaleReportWindow,
  exportStaleReport,
} from "@/lib/data/stale-balance-report-store";

// The markers the v27 migration left on rows whose ciphertext was preserved.
// These are kept on a row even AFTER a successful decrypt (the strip/cleanup step
// removes them later), so presence alone does not mean the row is unreadable —
// it only means cleanup is still pending. The "still locked" case is a marker
// present together with a blank real field (see isLockedUnreadable).
const LEGACY_MARKER_KEYS = ["_legacyEncryptedPayload", "isEncrypted", "encryptedPayload"] as const;

const BATCH_SIZE = 1000;
const SAMPLE_SIZE = 20;

type Phase = "idle" | "scanning" | "done" | "error";

interface TableCount {
  name: string;
  count: number;
  error: boolean;
}

interface RecordStats {
  total: number;
  blankInputString: number;
  placeholderInputString: number; // inputString === "[encrypted]" — value never restored
  populatedInputString: number;
  blankInputStringLower: number;
  blankLabel: number;
  lockedUnreadable: number; // payload present AND inputString blank/placeholder — the true "locked" signature
  markersRemaining: number; // rows carrying any leftover marker key (harmless cleanup candidates)
}

interface SampleRow {
  id: number | string;
  type: string;
  inputStringBlank: boolean;
  lockedUnreadable: boolean;
  hasMarker: boolean;
  raw: RawRow;
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

// Dump a raw record exactly as it is stored, untruncated, for forensic viewing.
function formatRaw(row: RawRow): string {
  try {
    return JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
  } catch {
    return String(row);
  }
}

// True when the row still carries ANY active encryption marker. IMPORTANT: the
// decrypt flow deliberately KEEPS these markers after successfully restoring the
// plaintext fields — they are the only recoverable copy until the separate
// strip/cleanup step removes them. So a marker alone does NOT mean the row is
// unreadable. The real "still locked" signature is a marker present AND a blank
// inputString (see isLockedUnreadable).
function hasActiveEncryptionMarker(row: RawRow): boolean {
  const legacy = row["_legacyEncryptedPayload"];
  if (typeof legacy === "string" && legacy.length > 0) return true;
  const payload = row["encryptedPayload"];
  if (typeof payload === "string" && payload.length > 0) return true;
  if (row["isEncrypted"] === true) return true;
  return false;
}

// The real value is unreadable when inputString is blank OR still holds the
// literal "[encrypted]" placeholder. A past migration blanked most fields but
// left inputString set to "[encrypted]", so treating placeholder as readable is
// exactly what made locked vaults look falsely healthy.
function isInputUnreadable(row: RawRow): boolean {
  const value = row["inputString"];
  return isBlank(value) || isEncryptedPlaceholder(value);
}

// The genuine "still locked" case: an encryption marker is present but the real
// value was never restored (inputString blank or "[encrypted]"). These are the
// records that make every screen look empty.
function isLockedUnreadable(row: RawRow): boolean {
  return hasActiveEncryptionMarker(row) && isInputUnreadable(row);
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
        placeholderInputString: 0,
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
          const inputPlaceholder = isEncryptedPlaceholder(row["inputString"]);
          const inputUnreadable = inputBlank || inputPlaceholder;
          if (inputBlank) recordStats.blankInputString += 1;
          else if (inputPlaceholder) recordStats.placeholderInputString += 1;
          else recordStats.populatedInputString += 1;

          if (isBlank(row["inputStringLower"])) recordStats.blankInputStringLower += 1;
          if (isBlank(row["label"])) recordStats.blankLabel += 1;

          const lockedUnreadable = isLockedUnreadable(row);
          const marker = hasAnyMarker(row);
          if (lockedUnreadable) recordStats.lockedUnreadable += 1;
          // "Markers remaining" is the harmless, readable bucket: a marker is
          // still present but the real field was restored (inputString holds a
          // genuine value — not blank and not the "[encrypted]" placeholder).
          // Locked-unreadable rows are tracked separately above.
          else if (marker && !inputUnreadable) recordStats.markersRemaining += 1;

          if (samples.length < SAMPLE_SIZE) {
            samples.push({
              id: (row["id"] as number | undefined) ?? "—",
              type: typeof row["type"] === "string" ? (row["type"] as string) : "—",
              inputStringBlank: inputBlank,
              lockedUnreadable,
              hasMarker: marker,
              raw: row,
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

        <BalanceIntegrityCard />

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
  } else if (
    recordStats.lockedUnreadable > 0 ||
    recordStats.blankInputString > 0 ||
    recordStats.placeholderInputString > 0
  ) {
    tone = "bad";
    title = "Some records are present but their contents are missing.";
    if (recordStats.lockedUnreadable > 0) {
      lines.push(
        `${recordStats.lockedUnreadable.toLocaleString()} of ${recordStats.total.toLocaleString()} records still hold locked (encrypted) data that was never unlocked — their visible fields are blank or show "[encrypted]", which is why those records appear empty everywhere.`,
      );
      lines.push(
        'Good news: this locked data is recoverable. Open Settings → "Restore Locked Data", enter your vault password, and let it finish to unlock these records. (Just logging out and back in may not be enough — a past migration can be wrongly marked finished, which is exactly this situation.)',
      );
    }
    const unreadableNoPayload =
      recordStats.blankInputString +
      recordStats.placeholderInputString -
      recordStats.lockedUnreadable;
    if (unreadableNoPayload > 0) {
      lines.push(
        `${unreadableNoPayload.toLocaleString()} records have a blank or "[encrypted]" address/transaction with no recoverable encrypted data (blank or incomplete).`,
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
    recordStats.blankInputString === 0 &&
    recordStats.placeholderInputString === 0
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
          label={'Showing "[encrypted]" placeholder'}
          value={stats.placeholderInputString.toLocaleString()}
          testid="stat-placeholder-input"
          highlight={stats.placeholderInputString > 0}
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
        {stats.lockedUnreadable > 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            {flags.legacyDecryptComplete
              ? 'The migration is marked complete, but these records are still locked — a past run finished early. Use Settings → "Restore Locked Data" to unlock them.'
              : 'The login-time unlock has not finished, so the locked records above are not recovered yet. Use Settings → "Restore Locked Data" to unlock them.'}
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
          The complete raw record exactly as stored in the database, untruncated. A "Locked" tag
          means the real values are still encrypted and the fields are blank. A "Recovered · marker"
          tag means the data was unlocked but a harmless leftover marker remains.
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
                  ) : s.hasMarker && !s.inputStringBlank ? (
                    <Badge variant="outline" className="gap-1" data-testid={`badge-recovered-${s.id}`}>
                      Recovered · marker
                    </Badge>
                  ) : null}
                </div>
                <pre
                  className="mt-1 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all"
                  data-testid={`sample-raw-${s.id}`}
                >
                  {formatRaw(s.raw)}
                </pre>
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

// Balance Integrity check (Task #374). Unlike the rest of this page, the *check*
// never modifies vault data — it samples (or, in "Check all addresses" mode,
// fully scans) synced address records and compares each one's cached balance
// against a value freshly computed from its participant rows (via
// detectStaleCachedBalances). The only thing it writes is a separate, local
// IndexedDB scratch store (see stale-balance-report-store.ts) holding the
// streamed stale-address report so the full set need not live in memory; the
// vault itself is untouched, and the scratch store is cleared on each run and on
// unmount. The check is cancellable. The optional "Recompute" action is the one
// explicit, user-initiated write to vault data on this page: it rebuilds the
// stale caches and then re-runs the check to confirm.
type BalanceCheckState =
  | { status: "idle" }
  | { status: "checking"; sampled: number; total?: number; checkAll: boolean }
  | { status: "done"; result: StaleBalanceCheckResult }
  | { status: "recomputing"; processed: number; total: number }
  | { status: "error"; message: string };

function formatSats(sats: number): string {
  return sats.toLocaleString() + " sats";
}

// Virtualized list of the specific addresses whose cached balance disagreed with
// a fresh recompute. Each row shows the cached vs. computed balance side by side
// and links to that address record on the Records page.
//
// The full stale set lives in a local IndexedDB scratch store (see
// stale-balance-report-store.ts), NOT in memory. This component only ever holds
// the rows for the windows the user has actually scrolled into view, so it stays
// bounded even when a full-table scan finds hundreds of thousands of stale
// addresses. Windows are fetched on demand and cached by row index.
const STALE_ROW_HEIGHT = 56;
const STALE_WINDOW_SIZE = 100;

export function StaleAddressList({ count }: { count: number }) {
  const parentRef = useRef<HTMLDivElement>(null);
  // Loaded rows keyed by absolute row index; only visited windows are present.
  const rowCacheRef = useRef<Map<number, StaleAddressDetail>>(new Map());
  // Window indices currently being fetched, so we never double-load one.
  const pendingRef = useRef<Set<number>>(new Set());
  const [cacheVersion, setCacheVersion] = useState(0);

  // A new run resets the store, so drop any cached rows when the count resets.
  useEffect(() => {
    if (count === 0) {
      rowCacheRef.current.clear();
      pendingRef.current.clear();
    }
  }, [count]);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => STALE_ROW_HEIGHT,
    overscan: 12,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const firstIndex = virtualItems.length ? virtualItems[0].index : 0;
  const lastIndex = virtualItems.length ? virtualItems[virtualItems.length - 1].index : 0;

  // Load any visible windows that aren't cached yet, then re-render.
  useEffect(() => {
    if (count === 0 || virtualItems.length === 0) return;
    const startWindow = Math.floor(firstIndex / STALE_WINDOW_SIZE);
    const endWindow = Math.floor(lastIndex / STALE_WINDOW_SIZE);
    const windowsToLoad: number[] = [];
    for (let w = startWindow; w <= endWindow; w++) {
      if (pendingRef.current.has(w)) continue;
      const offset = w * STALE_WINDOW_SIZE;
      const end = Math.min(offset + STALE_WINDOW_SIZE, count);
      let missing = false;
      for (let i = offset; i < end; i++) {
        if (!rowCacheRef.current.has(i)) { missing = true; break; }
      }
      if (missing) windowsToLoad.push(w);
    }
    if (windowsToLoad.length === 0) return;

    let cancelled = false;
    for (const w of windowsToLoad) pendingRef.current.add(w);
    (async () => {
      try {
        for (const w of windowsToLoad) {
          const offset = w * STALE_WINDOW_SIZE;
          const rows = await getStaleReportWindow(offset, STALE_WINDOW_SIZE);
          rows.forEach((row, idx) => rowCacheRef.current.set(offset + idx, row));
        }
        if (!cancelled) setCacheVersion((v) => v + 1);
      } finally {
        for (const w of windowsToLoad) pendingRef.current.delete(w);
      }
    })();
    return () => { cancelled = true; };
    // cacheVersion intentionally excluded: it would re-trigger after each load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstIndex, lastIndex, count]);

  return (
    <div className="border rounded-md" data-testid="list-stale-addresses">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 bg-muted/50 border-b text-xs font-medium text-muted-foreground">
        <span>Address</span>
        <span className="text-right">Cached</span>
        <span className="text-right">Computed</span>
        <span className="text-right">View</span>
      </div>
      <div
        ref={parentRef}
        className="h-[260px] overflow-auto"
        data-testid="scroll-stale-addresses"
      >
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
          data-cache-version={cacheVersion}
        >
          {virtualItems.map((virtualRow) => {
            const row = rowCacheRef.current.get(virtualRow.index);
            if (!row) {
              return (
                <div
                  key={`loading-${virtualRow.index}`}
                  className="absolute left-0 right-0 flex items-center px-3 border-b last:border-b-0"
                  style={{
                    height: `${STALE_ROW_HEIGHT}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  data-testid={`row-stale-loading-${virtualRow.index}`}
                >
                  <span className="text-xs text-muted-foreground">Loading…</span>
                </div>
              );
            }
            return (
              <div
                key={row.recordId}
                className="absolute left-0 right-0 grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 border-b last:border-b-0"
                style={{
                  height: `${STALE_ROW_HEIGHT}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                data-testid={`row-stale-address-${row.recordId}`}
              >
                <span
                  className="font-mono text-xs truncate"
                  title={row.address}
                  data-testid={`text-stale-address-${row.recordId}`}
                >
                  {row.address}
                </span>
                <span
                  className="text-right text-xs font-mono tabular-nums text-muted-foreground"
                  data-testid={`text-stale-cached-${row.recordId}`}
                >
                  {formatSats(row.cachedSats)}
                </span>
                <span
                  className="text-right text-xs font-mono tabular-nums"
                  data-testid={`text-stale-computed-${row.recordId}`}
                >
                  {formatSats(row.computedSats)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  asChild
                  data-testid={`link-stale-address-${row.recordId}`}
                >
                  <Link href={`/records?id=${row.recordId}`}>
                    <ExternalLink className="h-4 w-4" />
                    Open
                  </Link>
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function BalanceIntegrityCard() {
  const [state, setState] = useState<BalanceCheckState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  // Stale rows stream batch-by-batch into a local IndexedDB scratch store rather
  // than into a React array, so a full-table scan never holds the whole stale
  // set in memory. `staleRowsCount` tracks how many have been spooled so the
  // virtualized list (which reads windows back on demand) knows its row count.
  const [staleRowsCount, setStaleRowsCount] = useState(0);
  // Remembers whether the last run was a full-table scan, so the post-recompute
  // re-check repeats the same scope the user chose.
  const lastCheckAllRef = useRef(false);

  // Drop the scratch store when this card unmounts so diagnostic data does not
  // linger after the user leaves the page.
  useEffect(() => {
    return () => {
      void clearStaleReport();
    };
  }, []);

  const isChecking = state.status === "checking";
  const isRecomputing = state.status === "recomputing";
  const isBusy = isChecking || isRecomputing;

  const runCheck = useCallback(async (checkAll: boolean) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    lastCheckAllRef.current = checkAll;
    await clearStaleReport();
    setStaleRowsCount(0);
    setState({ status: "checking", sampled: 0, checkAll });
    try {
      const result = await detectStaleCachedBalances({
        signal: abort.signal,
        collectDetails: true,
        checkAll,
        // Awaited inside the scan: each batch is persisted before the next is
        // gathered, giving backpressure and keeping peak memory bounded.
        onStaleBatch: async (batch) => {
          await appendStaleReportRows(batch);
          setStaleRowsCount((c) => c + batch.length);
        },
        onProgress: (sampled, total) => setState({ status: "checking", sampled, total, checkAll }),
      });
      if (abort.signal.aborted) {
        setState({ status: "idle" });
        return;
      }
      setState({ status: "done", result });
    } catch (err) {
      if (abort.signal.aborted) {
        setState({ status: "idle" });
        return;
      }
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const recompute = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setState({ status: "recomputing", processed: 0, total: 0 });
    try {
      await recomputeAddressStats({
        origin: "user",
        signal: abort.signal,
        onProgress: ({ processed, total }) => setState({ status: "recomputing", processed, total }),
      });
      if (abort.signal.aborted) {
        setState({ status: "idle" });
        return;
      }
      // Re-run the read-only check so the user sees the now-corrected count,
      // matching the scope (sample vs. full-table) of the original run.
      await runCheck(lastCheckAllRef.current);
    } catch (err) {
      if (abort.signal.aborted) {
        setState({ status: "idle" });
        return;
      }
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [runCheck]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState({ status: "idle" });
  }, []);

  // Streamed export of the full stale-address report (CSV/JSON). Reads the rows
  // back from the local scratch store window-by-window so even a very large set
  // never lives in a single in-memory array; stays fully offline.
  const [exporting, setExporting] = useState<null | "csv" | "json">(null);

  const exportReport = useCallback(async (format: "csv" | "json") => {
    setExporting(format);
    try {
      const { blob, rowCount } = await exportStaleReport(format);
      if (rowCount === 0) return;
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        const stamp = new Date().toISOString().slice(0, 10);
        link.href = url;
        link.download = `stale-addresses-${stamp}.${format}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } finally {
        URL.revokeObjectURL(url);
      }
    } finally {
      setExporting(null);
    }
  }, []);

  const hasStale = state.status === "done" && state.result.staleCount > 0;
  const allGood = state.status === "done" && state.result.staleCount === 0;

  return (
    <Card data-testid="card-balance-integrity">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="h-5 w-5" />
          Balance integrity
        </CardTitle>
        <CardDescription>
          A read-only check that compares each synced address's cached balance against a value
          freshly recomputed from its transaction rows. "Run balance check" samples up to 2,000
          synced addresses for a quick read; "Check all addresses" scans every synced address (slower
          on large vaults). Neither changes anything — use the optional Recompute button to fix any
          that disagree.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={() => runCheck(false)} disabled={isBusy} data-testid="button-run-balance-check">
            {isChecking && !state.checkAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {isChecking && !state.checkAll ? "Checking…" : "Run balance check"}
          </Button>
          <Button
            variant="outline"
            onClick={() => runCheck(true)}
            disabled={isBusy}
            data-testid="button-check-all-balances"
          >
            {isChecking && state.checkAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
            {isChecking && state.checkAll ? "Checking all…" : "Check all addresses"}
          </Button>
          {hasStale && (
            <Button
              variant="outline"
              onClick={recompute}
              disabled={isBusy}
              data-testid="button-recompute-balances"
            >
              {isRecomputing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {isRecomputing ? "Recomputing…" : "Recompute"}
            </Button>
          )}
          {isBusy && (
            <Button
              variant="ghost"
              onClick={cancel}
              data-testid="button-cancel-balance-check"
            >
              <Ban className="h-4 w-4" />
              Cancel
            </Button>
          )}
        </div>

        {state.status === "idle" && (
          <p className="text-sm text-muted-foreground" data-testid="text-balance-idle">
            Click "Run balance check" to start. The check is safe to cancel at any time.
          </p>
        )}

        {state.status === "checking" && (
          <p className="text-sm text-muted-foreground" data-testid="text-balance-progress">
            {state.checkAll
              ? `Checking all addresses… ${state.sampled.toLocaleString()}${
                  state.total != null ? ` of ${state.total.toLocaleString()}` : ""
                } scanned so far.`
              : `Checking… ${state.sampled.toLocaleString()} addresses sampled so far.`}
          </p>
        )}

        {state.status === "recomputing" && (
          <p className="text-sm text-muted-foreground" data-testid="text-balance-recompute-progress">
            Recomputing balances… {state.processed.toLocaleString()}
            {state.total > 0 ? ` of ${state.total.toLocaleString()}` : ""} addresses.
          </p>
        )}

        {state.status === "error" && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2"
            data-testid="banner-balance-error"
          >
            <XCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
            <div className="text-sm text-destructive">{state.message}</div>
          </div>
        )}

        {state.status === "done" && (
          <div
            className={`rounded-md border p-3 flex items-start gap-3 ${
              hasStale
                ? "border-yellow-600/40 bg-yellow-600/10 dark:border-yellow-400/40 dark:bg-yellow-400/10"
                : "border-green-600/40 bg-green-600/10 dark:border-green-400/40 dark:bg-green-400/10"
            }`}
            data-testid="banner-balance-result"
          >
            {hasStale ? (
              <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
            )}
            <div className="space-y-1">
              <div className="font-medium" data-testid="text-balance-verdict">
                {hasStale
                  ? `${state.result.staleCount.toLocaleString()} of ${state.result.sampled.toLocaleString()} ${
                      state.result.checkedAll ? "synced" : "sampled"
                    } addresses have a stale cached balance.`
                  : `All ${state.result.sampled.toLocaleString()} ${
                      state.result.checkedAll ? "synced" : "sampled"
                    } addresses have up-to-date cached balances.`}
              </div>
              <p className="text-sm text-muted-foreground">
                {hasStale
                  ? 'These addresses have a cached balance that differs from a fresh recompute. Click "Recompute" above to rebuild them from your local transaction data.'
                  : state.result.sampled === 0
                    ? "No synced addresses were found to check."
                    : "Cached balances match the values computed from your transaction rows."}
              </p>
            </div>
          </div>
        )}

        {state.status === "done" && hasStale && staleRowsCount > 0 && (
          <div className="space-y-2">
            <div className="flex items-end justify-between gap-2 flex-wrap">
              <p className="text-sm text-muted-foreground" data-testid="text-stale-list-caption">
                {staleRowsCount < state.result.staleCount
                  ? `Showing the first ${staleRowsCount.toLocaleString()} of ${state.result.staleCount.toLocaleString()} stale addresses. Each opens its record on the Records page.`
                  : "Each row opens that address's record on the Records page."}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => exportReport("csv")}
                  disabled={exporting !== null}
                  data-testid="button-export-stale-csv"
                >
                  {exporting === "csv" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {exporting === "csv" ? "Exporting…" : "Export CSV"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => exportReport("json")}
                  disabled={exporting !== null}
                  data-testid="button-export-stale-json"
                >
                  {exporting === "json" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {exporting === "json" ? "Exporting…" : "Export JSON"}
                </Button>
              </div>
            </div>
            <StaleAddressList count={staleRowsCount} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
