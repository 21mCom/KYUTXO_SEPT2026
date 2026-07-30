import { useState, useRef } from "react";
import { Loader2, Upload, Trash2, AlertTriangle } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { isElectron, getElectronAPI } from "@/lib/electron";
import JSZip from "jszip";
import {
  peekManifest,
  restoreV3Backup,
  evaluateDiskSpace,
  RestoreInterruptedError,
  AttachmentWriteError,
  type AttachmentFileWriter,
} from "@/lib/backup/restore";
import { BackupCancelledError } from "@/lib/backup/sink";
import { blobChunks } from "@/lib/backup/zip-stream";
import { isV3Manifest, parseInline } from "@/lib/backup/format";
import {
  previewSettingsPreferences,
  type PortablePreferencePreview,
} from "@/lib/backup/inline-tables";
import { runLegacyJsonRestore } from "@/lib/backup/legacy-restore-pipeline";
import { createRestoreAttachmentWriter } from "@/lib/backup/restore-attachment-writer";
import { runPostRestoreTxidBackfill } from "@/lib/backup/post-restore-backfill";
import { getSettings, updateSettings } from "@/lib/data/settings-crud";
import { base64ToBuffer, deriveKey, decrypt } from "@/lib/crypto";
import { resetOrphanCheckGate } from "@/lib/orphan-check-session";
import { loadEntitySnapshotFromStorage } from "@/lib/data/entity-list-store";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// The Restore-from-Backup flow: two-stage dialog (configure + portable-
// preference confirm), v3 streaming restore with cancel support and disk-space
// pre-flight, plus the legacy whole-file JSON restore path. Split out of
// data-management-section.tsx so each flow stays reviewable.
export function RestoreBackupFlow() {
  const { toast } = useToast();

  // Restore state
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreMode, setRestoreMode] = useState<"replace" | "merge">("replace");
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [restoreMessage, setRestoreMessage] = useState("");
  const [backupInfo, setBackupInfo] = useState<{ encrypted: boolean; date: string; recordCount: number } | null>(null);
  // True when the selected file is a v3 streaming backup. The v3 restore
  // pipeline ALWAYS clears the vault and restores in replace mode — it has no
  // merge implementation — so the "Merge with existing" choice must be disabled
  // (and the mode forced to "replace") to keep the UI honest. Without this, a
  // user picking "Merge" on a v3 backup would silently get their data wiped.
  const [isV3Backup, setIsV3Backup] = useState(false);
  // Cancel support for the v3 streaming restore. `restoreCancellable` gates the
  // cancel button (the legacy whole-file path has no abort point). `clearedRef`
  // tracks the point of no return — once the destructive clear runs, cancelling
  // can no longer keep the existing vault, so we warn before allowing it.
  const [restoreCancellable, setRestoreCancellable] = useState(false);
  const [showCancelRestoreConfirm, setShowCancelRestoreConfirm] = useState(false);
  // Confirmation before lowering the Privacy Audit History limit when a large
  // number of runs would be deleted, so a misclick doesn't silently wipe a lot
  // of history. Holds the pending new limit and how many runs would be removed.
  const [restoreStage, setRestoreStage] = useState<"configure" | "confirm">("configure");
  const [prefPreview, setPrefPreview] = useState<PortablePreferencePreview[] | null>(null);
  const restoreAbortRef = useRef<AbortController | null>(null);
  const restoreClearedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Pre-flight disk-space warning (Electron only): set when a restore is about
  // to start but the disk likely lacks room for the backup's attachment files.
  // The warning is shown BEFORE the destructive clear, so the user can free
  // space without losing their current vault. `bypassDiskCheckRef` lets the
  // user proceed anyway (the check is a safeguard, not a hard gate).
  const [diskWarning, setDiskWarning] = useState<{ requiredBytes: number; freeBytes: number } | null>(null);
  const bypassDiskCheckRef = useRef(false);
  // Pre-flight disk-space info shown in the confirm stage (Electron + v3 only),
  // so the user sees the exact estimate before clicking "Restore Now."
  const [diskSpacePreview, setDiskSpacePreview] = useState<{ estimatedBytes: number; freeBytes: number } | null>(null);

  // Handle file selection for restore
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setRestoreFile(file);
    setBackupInfo(null);
    setRestoreStage("configure");
    setPrefPreview(null);
    setDiskSpacePreview(null);
    setIsV3Backup(false);

    try {
      // v3 streaming backups: read ONLY the manifest (first ZIP entry) via the
      // streaming peek so a multi-GB backup is never loaded into memory just to
      // preview it. The v3 manifest carries counts/encrypted/date in plaintext.
      const manifestPeek = await peekManifest(blobChunks(file));
      if (isV3Manifest(manifestPeek)) {
        // v3 backups only support replace mode (see isV3Backup above). Force
        // the mode so a previously-selected "Merge" can't silently carry over.
        setIsV3Backup(true);
        setRestoreMode("replace");
        setBackupInfo({
          encrypted: manifestPeek.encrypted || false,
          date: manifestPeek.exportDate || "Unknown",
          recordCount: manifestPeek.counts?.records ?? 0,
        });
        return;
      }

      // Legacy backups (single backup.json holding the whole vault): unchanged
      // whole-file read for backward compatibility.
      const zip = await JSZip.loadAsync(file);
      const backupFile = zip.file("backup.json");

      if (!backupFile) {
        throw new Error("Invalid backup file - missing backup.json");
      }

      const content = await backupFile.async("text");
      const backup = JSON.parse(content);

      setBackupInfo({
        encrypted: backup.encrypted || false,
        date: backup.exportDate || "Unknown",
        recordCount: backup.encrypted ? -1 : (backup.data?.records?.length || 0),
      });
    } catch (error) {
      console.error("Failed to read backup file:", error);
      toast({
        variant: "destructive",
        title: "Invalid Backup",
        description: "Could not read the backup file. Make sure it's a valid KYUTXO backup.",
      });
      setRestoreFile(null);
    }
  };

  // First stage of restoring a v3 backup: read (without touching the vault)
  // which portable preferences the backup will carry over, then move to the
  // confirmation stage so the user can review them BEFORE the destructive
  // restore runs. Legacy (pre-v3) backups have no preview step and restore
  // directly. Nothing here clears or writes any data.
  const handlePrepareRestore = async () => {
    if (!restoreFile) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a backup file.",
      });
      return;
    }

    try {
      const manifestPeek = await peekManifest(blobChunks(restoreFile));
      if (isV3Manifest(manifestPeek)) {
        let key: CryptoKey | null = null;
        if (manifestPeek.encrypted) {
          if (!restorePassword) {
            toast({
              variant: "destructive",
              title: "Password required",
              description: "Enter the password used to encrypt this backup.",
            });
            return;
          }
          const salt = base64ToBuffer(manifestPeek.salt ?? "");
          key = await deriveKey(restorePassword, salt);
        }

        let inline: Record<string, unknown>;
        try {
          const rawInline = await parseInline(manifestPeek, key);
          // For plaintext backups: warn when the `inline` field is present (not
          // null/undefined) but is not a proper object — this indicates a
          // malformed backup that would silently show "no preferences" otherwise.
          if (
            !manifestPeek.encrypted &&
            manifestPeek.inline !== undefined &&
            manifestPeek.inline !== null &&
            (typeof rawInline !== "object" || Array.isArray(rawInline))
          ) {
            toast({
              variant: "destructive",
              title: "Malformed backup data",
              description:
                "This backup's inline preference data is present but couldn't be read. Preferences won't carry over. The rest of the backup is still valid — you can continue.",
            });
            inline = {};
          } else {
            inline = rawInline as Record<string, unknown>;
          }
        } catch {
          // A wrong password (or corrupted inline data) fails here, BEFORE any
          // destructive work — surface it and stay on the configure stage.
          toast({
            variant: "destructive",
            title: "Could not read backup",
            description: "The password may be incorrect, or the backup is corrupted.",
          });
          return;
        }

        const settingsRows = Array.isArray(inline.settings) ? (inline.settings as any[]) : [];
        setPrefPreview(previewSettingsPreferences(settingsRows));

        // Pre-flight space disclosure: fetch disk space so the confirm stage can
        // show "estimated X needed, Y available" before the user clicks Restore.
        // Best-effort only — if the probe fails, skip the info row.
        setDiskSpacePreview(null);
        if (isElectron()) {
          try {
            const space = await getElectronAPI().getDiskSpace();
            if (space.success && typeof space.freeBytes === "number") {
              const estimatedBytes =
                typeof manifestPeek.totalAttachmentBytes === "number"
                  ? manifestPeek.totalAttachmentBytes
                  : restoreFile.size;
              setDiskSpacePreview({ estimatedBytes, freeBytes: space.freeBytes });
            }
          } catch { /* best-effort */ }
        }

        setRestoreStage("confirm");
        return;
      }

      // Legacy backups: read the (possibly encrypted) settings rows WITHOUT
      // touching the vault, then show the same configure -> confirm preview the
      // v3 path uses. A wrong password fails here, before any destructive work.
      const zip = await JSZip.loadAsync(restoreFile);
      const backupFile = zip.file("backup.json");
      if (!backupFile) {
        throw new Error("Invalid backup file - missing backup.json");
      }
      const backup = JSON.parse(await backupFile.async("text"));

      let legacyData = backup.data;
      if (backup.encrypted) {
        if (!restorePassword) {
          toast({
            variant: "destructive",
            title: "Password required",
            description: "Enter the password used to encrypt this backup.",
          });
          return;
        }
        try {
          const salt = base64ToBuffer(backup.salt);
          const backupKey = await deriveKey(restorePassword, salt);
          legacyData = JSON.parse(await decrypt(backup.data, backupKey));
        } catch {
          // Wrong password (or corrupted payload) surfaces here, BEFORE any
          // destructive work — stay on the configure stage.
          toast({
            variant: "destructive",
            title: "Could not read backup",
            description: "The password may be incorrect, or the backup is corrupted.",
          });
          return;
        }
      }

      // For plaintext legacy backups: warn when backup.data is present but is not
      // a proper plain object — this would silently produce a no-data restore.
      if (
        !backup.encrypted &&
        backup.data !== undefined &&
        backup.data !== null &&
        (typeof legacyData !== "object" || Array.isArray(legacyData))
      ) {
        toast({
          variant: "destructive",
          title: "Malformed backup data",
          description:
            "This backup's data payload is present but couldn't be read. Records and other data may not restore. Check that the backup file is not corrupt.",
        });
      }

      const legacySettings = Array.isArray(legacyData?.settings)
        ? (legacyData.settings as any[])
        : [];
      setPrefPreview(previewSettingsPreferences(legacySettings));
      setRestoreStage("confirm");
    } catch (error) {
      console.error("Failed to prepare restore:", error);
      toast({
        variant: "destructive",
        title: "Invalid Backup",
        description: "Could not read the backup file. Make sure it's a valid KYUTXO backup.",
      });
    }
  };

  // Restore from backup handler
  const handleRestore = async () => {
    if (!restoreFile) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a backup file.",
      });
      return;
    }

    setIsRestoring(true);
    setRestoreProgress(0);
    setRestoreMessage("Reading backup file...");
    setRestoreCancellable(false);
    restoreClearedRef.current = false;
    restoreAbortRef.current = null;

    // Clear any Needs Review files left by previous restores so they don't
    // accumulate across repeated restores. Best-effort: a failure here must
    // never block the restore itself.
    if (isElectron()) {
      try {
        const api = getElectronAPI();
        const listed = await api.listNeedsReview();
        if (listed.success && listed.files) {
          for (const f of listed.files) {
            await api.deleteNeedsReview(f.name).catch(() => {});
          }
        }
      } catch { /* best-effort */ }
    }

    // Portable-prefs snapshot — declared here (outer scope) so the `undoInlinePrefs`
    // helper below is accessible from both the try block and the catch block.
    // The actual value is populated inside the try, just before `restoreV3Backup`.
    type PortablePrefsSnapshot = {
      disableOrphanCheck?: boolean;
      cancelConfirmThreshold?: number;
      privacyHistoryLimit?: number;
      fundTrailTxLimit?: number;
      intermediaryAddressCap?: number;
      entityListSnapshot?: unknown;
    };
    let preRestorePrefs: PortablePrefsSnapshot | null = null;

    // Undo any portable-pref writes the backup's inline-restore phase applied to
    // the settings table. Called after every post-clear failure so the user never
    // sees half-applied backup prefs in an otherwise empty vault.
    const undoInlinePrefs = async () => {
      if (!preRestorePrefs) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await updateSettings("default", preRestorePrefs as any, { skipNotification: true });
        // Re-sync the in-memory entity list from DB so the active privacy-audit
        // list reflects the restored (pre-restore) snapshot, not the backup's.
        await loadEntitySnapshotFromStorage();
      } catch {
        // Non-fatal — prefs may not exist yet on a fresh vault; the user has
        // already been informed about the cancel/failure.
      }
    };

    try {
      // v3 streaming backups: peek the manifest (first ZIP entry) without
      // reading the whole archive. If it is a v3 backup, restore it with the
      // streaming pipeline that never loads a whole table into memory. Older
      // backups (no formatVersion / a `.data` blob) fall through to the legacy
      // JSON path below, which is left untouched for backward compatibility.
      const manifestPeek = await peekManifest(blobChunks(restoreFile));
      if (isV3Manifest(manifestPeek)) {
        // Defence in depth: the v3 pipeline is replace-only (it always clears
        // the vault). The UI disables the Merge option for v3 backups, but if a
        // stale "merge" selection ever reaches this point, refuse loudly rather
        // than silently wiping data the user asked to keep.
        if (restoreMode === "merge") {
          setIsRestoring(false);
          setRestoreMessage("");
          setRestoreProgress(0);
          toast({
            variant: "destructive",
            title: "Merge not supported for this backup",
            description:
              "New-format backups can only replace all existing data. Select \"Replace all data\" to continue — no changes were made.",
          });
          return;
        }
        // Pre-flight disk-space check (Electron only). Attachment files are
        // stored UNCOMPRESSED in the v3 ZIP and are what a restore writes to
        // disk. v3 manifests record the exact total attachment bytes
        // (`totalAttachmentBytes`), so we use that as the estimate; older
        // backups that lack it fall back to the backup file's own size (a safe
        // upper bound, since the compressed NDJSON tables only inflate it).
        // Running this BEFORE the destructive clear lets the user free space
        // without losing their current vault — a disk-full failure during
        // attachment writes would otherwise be discovered only after the clear.
        // Best-effort: if the probe fails we let the restore proceed rather than
        // block it.
        if (isElectron() && !bypassDiskCheckRef.current) {
          try {
            const space = await getElectronAPI().getDiskSpace();
            if (space.success && typeof space.freeBytes === "number") {
              const estimatedBytes =
                typeof manifestPeek.totalAttachmentBytes === "number"
                  ? manifestPeek.totalAttachmentBytes
                  : restoreFile.size;
              const estimate = evaluateDiskSpace(estimatedBytes, space.freeBytes);
              if (!estimate.sufficient) {
                setIsRestoring(false);
                setRestoreCancellable(false);
                setRestoreProgress(0);
                setRestoreMessage("");
                setDiskWarning({
                  requiredBytes: estimate.requiredBytes,
                  freeBytes: space.freeBytes,
                });
                return;
              }
            }
          } catch {
            // Probe failed — fall through and let the restore proceed.
          }
        }
        bypassDiskCheckRef.current = false;

        // Shared with the one-click demo-vault loader so both restore entry
        // points write/sweep attachment files identically.
        const attachmentWriter: AttachmentFileWriter = createRestoreAttachmentWriter();

        // Populate the portable-prefs snapshot BEFORE the destructive clear so
        // that `undoInlinePrefs` (declared above the outer try) can roll back any
        // backup prefs that `restoreSettingsPreferences()` already merged into the
        // settings table if the restore is later cancelled or interrupted.
        try {
          const cur = await getSettings("default");
          if (cur) {
            preRestorePrefs = {
              disableOrphanCheck: cur.disableOrphanCheck,
              cancelConfirmThreshold: cur.cancelConfirmThreshold,
              privacyHistoryLimit: cur.privacyHistoryLimit,
              fundTrailTxLimit: cur.fundTrailTxLimit,
              intermediaryAddressCap: cur.intermediaryAddressCap,
              entityListSnapshot: cur.entityListSnapshot,
            };
          }
        } catch {
          // Non-fatal — if we can't read the prefs we simply won't restore them.
        }

        const controller = new AbortController();
        restoreAbortRef.current = controller;
        setRestoreCancellable(true);

        const result = await restoreV3Backup({
          source: blobChunks(restoreFile),
          password: restorePassword || undefined,
          attachmentWriter,
          signal: controller.signal,
          onProgress: (p) => {
            // Once clearing begins, the existing vault is being destroyed; mark
            // the point of no return so cancel prompts for confirmation.
            if (p.percent >= 8) restoreClearedRef.current = true;
            setRestoreProgress(p.percent);
            setRestoreMessage(p.phase);
          },
        });

        setRestoreProgress(100);
        setRestoreMessage("Restore complete! Checking for missing transaction data...");

        // --- Post-restore txid backfill (shared helper, never throws) ---
        // Detect orphaned transaction records and fetch their on-chain data.
        // If the provider is unreachable, the helper defers gracefully and the
        // suffix tells the user.
        const backfill = await runPostRestoreTxidBackfill({
          onMessage: setRestoreMessage,
          onPercent: setRestoreProgress,
        });
        // When orphans were found, mention the "(owning record absent)" detail;
        // otherwise note that existing data was replaced (mirrors the pre-split
        // toast wording exactly).
        const v3OrphanMsg = result.counts.orphanedAttachmentFiles > 0
          ? ` ${result.counts.orphanedAttachmentFiles} attachment file${result.counts.orphanedAttachmentFiles !== 1 ? "s" : ""} could not be re-linked${backfill.orphansFound ? " (owning record absent)" : ""} — find them in the "Needs Review" section of Settings to re-attach or delete them.`
          : "";
        const v3LostMsg = result.counts.orphanedAttachmentFilesLost > 0
          ? ` Warning: ${result.counts.orphanedAttachmentFilesLost} of those file${result.counts.orphanedAttachmentFilesLost !== 1 ? "s" : ""} could not be saved to Needs Review and ${result.counts.orphanedAttachmentFilesLost !== 1 ? "their" : "its"} contents were lost.`
          : "";
        const v3ReplacedMsg = backfill.orphansFound ? "" : " Existing data was replaced.";
        toast({
          title: "Restore Successful",
          description: `Restored ${result.counts.records} records, ${result.counts.blockchainTransactions} transactions, ${result.counts.transactionParticipants} participants, ${result.counts.attachmentFiles} attachment files${result.counts.lineageSnapshots > 0 ? `, ${result.counts.lineageSnapshots} snapshot${result.counts.lineageSnapshots !== 1 ? "s" : ""}` : ""}.${v3ReplacedMsg}${backfill.suffix}${v3OrphanMsg}${v3LostMsg}`,
          ...(result.counts.orphanedAttachmentFiles > 0 && isElectron() ? {
            action: (
              <button
                className="shrink-0 rounded border px-2 py-1 text-xs font-medium"
                onClick={() => getElectronAPI().openNeedsReviewFolder()}
              >
                Open folder
              </button>
            ) as any,
          } : {}),
        });

        // A restore can introduce transaction records missing on-chain data.
        // Reset the once-per-session orphan-check gate so the startup check in
        // OrphanedTxNotifier re-evaluates after the reload and re-prompts (or
        // auto-backfills) via the normal path. It sets the gate again on load,
        // so this cannot loop.
        resetOrphanCheckGate();

        setTimeout(() => {
          setRestoreDialogOpen(false);
          setRestoreFile(null);
          setRestorePassword("");
          setRestoreProgress(0);
          setRestoreMessage("");
          setBackupInfo(null);
          setRestoreStage("configure");
          setPrefPreview(null);
          setDiskSpacePreview(null);
          window.location.reload();
        }, 1500);
        return;
      }

      // Legacy whole-file JSON restore — the full pipeline (decrypt, clear,
      // per-table restore, attachment files, summary message) lives in
      // @/lib/backup/legacy-restore-pipeline so it is testable outside React.
      const legacySummary = await runLegacyJsonRestore(
        restoreFile,
        restorePassword,
        restoreMode,
        {
          onProgress: (percent, message) => {
            setRestoreProgress(percent);
            setRestoreMessage(message);
          },
          onCleared: () => {
            // The destructive clear has run — the cancel/error handlers must
            // now reload rather than just close the dialog.
            restoreClearedRef.current = true;
          },
        },
      );

      // --- Post-restore txid backfill (shared helper, never throws) ---
      const legacyBackfill = await runPostRestoreTxidBackfill({
        onMessage: setRestoreMessage,
        onPercent: setRestoreProgress,
      });

      const legacyOrphanCount = legacySummary.orphanedFilesRouted;
      const legacyOrphanSuffix = legacyOrphanCount > 0
        ? ` ${legacyOrphanCount} attachment file${legacyOrphanCount !== 1 ? "s" : ""} could not be re-linked (owning record absent) — find them in the "Needs Review" section of Settings to re-attach or delete them.`
        : "";
      const legacyOrphanLostSuffix = legacySummary.orphanedFilesLost > 0
        ? ` Warning: ${legacySummary.orphanedFilesLost} recovered attachment file${legacySummary.orphanedFilesLost !== 1 ? "s" : ""} could not be saved to Needs Review and ${legacySummary.orphanedFilesLost !== 1 ? "their" : "its"} contents were lost.`
        : "";
      toast({
        title: "Restore Successful",
        description: legacySummary.baseMessage + legacyBackfill.suffix + legacyOrphanSuffix + legacyOrphanLostSuffix,
        ...(legacyOrphanCount > 0 && isElectron() ? {
          action: (
            <button
              className="shrink-0 rounded border px-2 py-1 text-xs font-medium"
              onClick={() => getElectronAPI().openNeedsReviewFolder()}
            >
              Open folder
            </button>
          ) as any,
        } : {}),
      });

      // A restore can introduce transaction records missing on-chain data. Reset
      // the once-per-session orphan-check gate so the startup check in
      // OrphanedTxNotifier re-evaluates after the reload and re-prompts (or
      // auto-backfills) via the normal path. It sets the gate again on load, so
      // this cannot loop.
      resetOrphanCheckGate();

      // Close dialog and reset state
      setTimeout(() => {
        setRestoreDialogOpen(false);
        setRestoreFile(null);
        setRestorePassword("");
        setRestoreProgress(0);
        setRestoreMessage("");
        setBackupInfo(null);
        // Reload to refresh all data
        window.location.reload();
      }, 1500);


    } catch (error) {
      // User-initiated cancel of the v3 streaming restore. The library tells us
      // which side of the destructive clear the cancel happened on so we can
      // give an honest message about the resulting vault state.
      if (error instanceof BackupCancelledError) {
        setRestoreProgress(0);
        setRestoreMessage("");
        if (error.clearedBeforeCancel) {
          // Old data was already wiped and only part of the backup written; the
          // library reset the vault to a known-empty state. Reload so the UI
          // reflects the empty vault and prompt the user to restore again.
          toast({
            variant: "destructive",
            title: "Restore Cancelled",
            description:
              "Your existing data had already been cleared, so the vault is now empty. Run the restore again to recover your data.",
          });
          // Undo any portable-preference writes the backup's inline-restore phase
          // already applied to the settings table (entity-list snapshot, etc.)
          // so a cancelled restore never leaves half-applied backup prefs behind.
          await undoInlinePrefs();
          // A cancel-after-clear can leave partially-written transaction records
          // (missing on-chain data) behind. Reset the once-per-session
          // orphan-check gate so the startup check re-evaluates after the reload,
          // the same way a successful restore does. The check re-sets the gate on
          // load, so this cannot loop.
          resetOrphanCheckGate();
          setTimeout(() => {
            setRestoreDialogOpen(false);
            setRestoreFile(null);
            setRestorePassword("");
            setBackupInfo(null);
            window.location.reload();
          }, 2000);
        } else {
          // Cancelled before the clear: nothing was touched.
          toast({
            title: "Restore Cancelled",
            description: "No changes were made — your existing data is intact.",
          });
        }
        return;
      }
      // A single attachment file could not be written (e.g. the disk is full or
      // the write endpoint rejected the file). This can surface either directly
      // (raw AttachmentWriteError — the write failed BEFORE the destructive
      // clear, so the existing vault was never touched) or wrapped as the cause
      // of a RestoreInterruptedError (the failure happened AFTER the clear, so
      // the vault has been reset to empty). In both cases give a specific,
      // plain-language message instead of a raw endpoint error — but be honest
      // about whether the existing vault was wiped, since those are opposite
      // outcomes for the user's data.
      const attachmentWriteFailure =
        error instanceof AttachmentWriteError
          ? error
          : error instanceof RestoreInterruptedError &&
              error.cause instanceof AttachmentWriteError
            ? error.cause
            : null;
      if (attachmentWriteFailure) {
        console.error("Restore failed writing an attachment:", attachmentWriteFailure);
        setRestoreProgress(0);
        setRestoreMessage("");
        const writtenBefore = attachmentWriteFailure.filesWrittenBefore;
        const filesSavedMsg =
          writtenBefore === 1
            ? "1 attachment file was saved before the failure."
            : `${writtenBefore} attachment files were saved before the failure.`;
        // Surface the underlying cause so the user can self-diagnose (corrupt
        // bytes, permission denied, endpoint offline, etc.) instead of being
        // pointed only at the disk-full guess. Prefer the original cause's
        // message, falling back to the AttachmentWriteError's own message.
        const rawReason =
          attachmentWriteFailure.cause instanceof Error
            ? attachmentWriteFailure.cause.message
            : attachmentWriteFailure.cause !== undefined
              ? String(attachmentWriteFailure.cause)
              : attachmentWriteFailure.message;
        const reason = rawReason?.trim();
        const reasonMsg = reason ? `Reason: ${reason}. ` : "";
        // A wrapped failure means the vault crossed the destructive clear and was
        // reset to empty; a raw one means the failure happened first, so the
        // existing vault is intact.
        const vaultWasCleared = error instanceof RestoreInterruptedError;
        const vaultStateMsg = vaultWasCleared
          ? "The vault was reset to empty, so no partial data was left behind."
          : "Your existing data was left untouched.";
        toast({
          variant: "destructive",
          title: "Restore Failed — Couldn't Write Attachment",
          description:
            `Restore failed while saving the attachment file "${attachmentWriteFailure.relPath}" — your disk may be full, the file was rejected, or the write failed for another reason. ` +
            `${reasonMsg}${filesSavedMsg} ${vaultStateMsg} Check the reason above (free up disk space, fix file permissions, or reconnect the storage), then run the restore again.`,
        });
        if (vaultWasCleared) {
          // Undo any portable-preference writes the backup's inline-restore phase
          // already applied to the settings table before the failure, so no
          // backup prefs bleed into the now-empty vault.
          await undoInlinePrefs();
          // The reset-to-empty contract clears everything, so re-evaluate the
          // once-per-session orphan check after reload, the same as other paths.
          resetOrphanCheckGate();
          setTimeout(() => {
            setRestoreDialogOpen(false);
            setRestoreFile(null);
            setRestorePassword("");
            setBackupInfo(null);
            window.location.reload();
          }, 3000);
        } else {
          // Nothing was cleared — the existing vault is intact, so just reset the
          // dialog. No reload (the data is unchanged) and no orphan-gate reset.
          setRestoreDialogOpen(false);
          setRestoreFile(null);
          setRestorePassword("");
          setBackupInfo(null);
        }
        return;
      }
      // Cancelled after the clear, but the vault could NOT be reset to a clean
      // state — it is in an unknown partial state. Be explicit and reload so the
      // UI reflects the real (partial) contents and prompt a re-restore.
      if (error instanceof RestoreInterruptedError) {
        console.error("Restore interrupted:", error);
        setRestoreProgress(0);
        setRestoreMessage("");
        toast({
          variant: "destructive",
          title: "Restore Interrupted",
          description: error.message,
        });
        // Undo any portable-preference writes that the backup's inline-restore
        // phase applied to settings before the interruption, so the partially-
        // restored vault doesn't silently carry the backup's preferences.
        await undoInlinePrefs();
        // The vault is in an unknown partial state that can include transaction
        // records missing on-chain data. Reset the once-per-session orphan-check
        // gate so the startup check re-evaluates after the reload, the same way a
        // successful restore does. The check re-sets the gate on load, so this
        // cannot loop.
        resetOrphanCheckGate();
        setTimeout(() => {
          setRestoreDialogOpen(false);
          setRestoreFile(null);
          setRestorePassword("");
          setBackupInfo(null);
          window.location.reload();
        }, 2500);
        return;
      }
      console.error("Restore failed:", error);
      toast({
        variant: "destructive",
        title: "Restore Failed",
        description: (error instanceof Error ? error.message : "Failed to restore backup") +
          (restoreClearedRef.current
            ? " Your existing vault data was already cleared before this error occurred — the vault may be empty or partially restored."
            : ""),
      });
      setRestoreProgress(0);
      setRestoreMessage("");
    } finally {
      setIsRestoring(false);
      setRestoreCancellable(false);
      restoreAbortRef.current = null;
      restoreClearedRef.current = false;
    }
  };

  // Cancel button on the restore dialog. Before the destructive clear we abort
  // immediately (existing data is safe). After it, we confirm first because the
  // vault has already been wiped and cancelling will leave it empty.
  const handleRequestCancelRestore = () => {
    if (restoreClearedRef.current) {
      setShowCancelRestoreConfirm(true);
    } else {
      restoreAbortRef.current?.abort();
      setRestoreMessage("Cancelling...");
    }
  };

  const confirmCancelRestore = () => {
    setShowCancelRestoreConfirm(false);
    restoreAbortRef.current?.abort();
    setRestoreMessage("Cancelling...");
  };

  return (
    <>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Restore from Backup</Label>
                <p className="text-sm text-muted-foreground">
                  Import data from a previously exported backup file
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setRestoreDialogOpen(true)}
                data-testid="button-open-restore"
              >
                <Upload className="h-4 w-4 mr-2" />
                Restore
              </Button>
            </div>

      {/* Restore Dialog */}
      <Dialog open={restoreDialogOpen} onOpenChange={(open) => {
        if (!open && !isRestoring) {
          setRestoreDialogOpen(false);
          setRestoreFile(null);
          setRestorePassword("");
          setRestoreProgress(0);
          setRestoreMessage("");
          setBackupInfo(null);
          setIsV3Backup(false);
          setRestoreStage("configure");
          setPrefPreview(null);
          setDiskSpacePreview(null);
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Restore from Backup
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {restoreStage === "configure" && (
            <>
            <div className="space-y-2">
              <Label>Select backup file</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleFileSelect}
                className="hidden"
                data-testid="input-restore-file"
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRestoring}
                >
                  {restoreFile ? restoreFile.name : "Choose ZIP file..."}
                </Button>
                {restoreFile && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setRestoreFile(null);
                      setBackupInfo(null);
                      setIsV3Backup(false);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                    disabled={isRestoring}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {backupInfo && (
              <div className="p-3 bg-muted rounded-lg space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Backup Date:</span>
                  <span className="font-medium">
                    {new Date(backupInfo.date).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Encrypted:</span>
                  <Badge variant={backupInfo.encrypted ? "default" : "secondary"}>
                    {backupInfo.encrypted ? "Yes" : "No"}
                  </Badge>
                </div>
                {!backupInfo.encrypted && backupInfo.recordCount >= 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Records:</span>
                    <span className="font-medium">{backupInfo.recordCount}</span>
                  </div>
                )}
              </div>
            )}

            {backupInfo?.encrypted && (
              <div className="space-y-2">
                <Label htmlFor="restore-password">Backup password</Label>
                <Input
                  id="restore-password"
                  type="password"
                  value={restorePassword}
                  onChange={(e) => setRestorePassword(e.target.value)}
                  placeholder="Enter the password used to encrypt this backup"
                  disabled={isRestoring}
                  data-testid="input-restore-password"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>Restore mode</Label>
              <RadioGroup
                value={restoreMode}
                onValueChange={(value) => setRestoreMode(value as "replace" | "merge")}
                disabled={isRestoring}
              >
                <div className="flex items-start space-x-3 p-3 rounded-lg border bg-background hover-elevate">
                  <RadioGroupItem value="replace" id="mode-replace" data-testid="radio-replace" />
                  <div className="space-y-1">
                    <Label htmlFor="mode-replace" className="font-medium cursor-pointer">
                      Replace all data
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Delete all existing data and replace with backup contents
                    </p>
                  </div>
                </div>
                <div className={`flex items-start space-x-3 p-3 rounded-lg border bg-background ${isV3Backup ? "opacity-60" : "hover-elevate"}`}>
                  <RadioGroupItem
                    value="merge"
                    id="mode-merge"
                    data-testid="radio-merge"
                    disabled={isV3Backup}
                  />
                  <div className="space-y-1">
                    <Label
                      htmlFor="mode-merge"
                      className={`font-medium ${isV3Backup ? "cursor-not-allowed" : "cursor-pointer"}`}
                    >
                      Merge with existing
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Add backup data to existing records, skipping duplicates
                    </p>
                    {isV3Backup && (
                      <p
                        className="text-xs text-muted-foreground"
                        data-testid="text-merge-unavailable-v3"
                      >
                        Merge isn't available for this backup — new-format backups
                        always replace all existing data.
                      </p>
                    )}
                  </div>
                </div>
              </RadioGroup>
            </div>
            </>
            )}

            {restoreStage === "confirm" && (
              <div className="space-y-3" data-testid="restore-preferences-preview">
                <div>
                  <Label>Preferences this backup will restore</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    These portable preferences travel with your backup. Anything
                    marked "Kept (this device)" is left exactly as it is now.
                    Other device-only settings — theme, column layout, node
                    connection — are never touched by a restore.
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/40 divide-y">
                  {(prefPreview ?? []).map((p) => (
                    <div
                      key={p.key}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      data-testid={`pref-preview-${p.key}`}
                    >
                      <span className="font-medium">{p.label}</span>
                      {p.fromBackup ? (
                        <Badge variant="default" data-testid={`pref-status-${p.key}`}>
                          From backup: {p.backupValue}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" data-testid={`pref-status-${p.key}`}>
                          Kept (this device)
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
                {!isRestoring && prefPreview && !prefPreview.some((p) => p.fromBackup) && (
                  <p className="text-xs text-muted-foreground" data-testid="text-no-prefs-carried">
                    This backup doesn't change any of your portable preferences —
                    they'll all stay as they are on this device.
                  </p>
                )}
                {diskSpacePreview && !isRestoring && (
                  <div
                    className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-sm"
                    data-testid="disk-space-preview"
                  >
                    <span className="text-muted-foreground">Estimated disk space needed</span>
                    <span className={diskSpacePreview.estimatedBytes > diskSpacePreview.freeBytes ? "text-destructive font-medium" : "font-medium"}>
                      {formatBytes(diskSpacePreview.estimatedBytes)}
                      {" "}
                      <span className="text-muted-foreground font-normal">
                        ({formatBytes(diskSpacePreview.freeBytes)} free)
                      </span>
                    </span>
                  </div>
                )}
              </div>
            )}

            {isRestoring && (
              <div className="space-y-2" data-testid="restore-progress">
                <div className="flex items-center justify-between text-sm">
                  <span data-testid="text-restore-phase">{restoreMessage}</span>
                  <span>{restoreProgress}%</span>
                </div>
                <Progress value={restoreProgress} />
                {restoreCancellable && (
                  <p className="text-xs text-muted-foreground">
                    {restoreClearedRef.current
                      ? "Existing data has been cleared. Cancelling now will leave the vault empty."
                      : "You can cancel safely until the existing data starts being replaced."}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            {isRestoring ? (
              <Button
                variant="destructive"
                onClick={handleRequestCancelRestore}
                disabled={!restoreCancellable}
                data-testid="button-cancel-restore"
              >
                {restoreCancellable ? "Cancel Restore" : "Restoring..."}
              </Button>
            ) : restoreStage === "confirm" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setRestoreStage("configure")}
                  data-testid="button-back-restore"
                >
                  Back
                </Button>
                <Button
                  onClick={handleRestore}
                  disabled={!restoreFile || (backupInfo?.encrypted && !restorePassword)}
                  data-testid="button-confirm-restore"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Restore Now
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => {
                  setRestoreDialogOpen(false);
                  setRestoreFile(null);
                  setRestorePassword("");
                  setRestoreProgress(0);
                  setRestoreMessage("");
                  setBackupInfo(null);
                  setIsV3Backup(false);
                  setRestoreStage("configure");
                  setPrefPreview(null);
                  setDiskSpacePreview(null);
                }}>
                  Cancel
                </Button>
                <Button
                  onClick={handlePrepareRestore}
                  disabled={!restoreFile || (backupInfo?.encrypted && !restorePassword)}
                  data-testid="button-continue-restore"
                >
                  Continue
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-flight low-disk-space warning. Shown BEFORE the destructive clear so
          the user can free space without losing their current vault. */}
      <AlertDialog
        open={diskWarning !== null}
        onOpenChange={(open) => !open && setDiskWarning(null)}
      >
        <AlertDialogContent data-testid="dialog-disk-warning">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Not enough free disk space
            </AlertDialogTitle>
            <AlertDialogDescription>
              {diskWarning
                ? `This backup needs about ${formatBytes(diskWarning.requiredBytes)} of free space to restore, but only ${formatBytes(diskWarning.freeBytes)} is available. Your current data has NOT been touched. Free up some space and try again, or continue anyway — but if the disk fills up partway through, your existing vault will already have been replaced.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setDiskWarning(null)}
              data-testid="button-cancel-disk-warning"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                bypassDiskCheckRef.current = true;
                setDiskWarning(null);
                void handleRestore();
              }}
              data-testid="button-proceed-disk-warning"
            >
              Restore Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showCancelRestoreConfirm} onOpenChange={setShowCancelRestoreConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Cancel restore?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your existing data has already been cleared to make room for the backup.
              If you cancel now, the vault will be left empty and you'll need to run
              the restore again to recover your data. Continue restoring instead?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-keep-restoring">Keep restoring</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancelRestore}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-cancel-restore"
            >
              Cancel and empty vault
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
