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
import { isV3Manifest, parseInline, ATTACHMENTS_DIR } from "@/lib/backup/format";
import {
  restoreNodeSettingsRows,
  restoreSettingsPreferences,
  previewSettingsPreferences,
  type PortablePreferencePreview,
} from "@/lib/backup/inline-tables";
import {
  restoreLegacyRecords,
  restoreLegacyAttachments,
  restoreLegacyTransactions,
  restoreLegacyAddressSyncState,
} from "@/lib/backup/legacy-restore";
import type { LegacyAttachmentsResult } from "@/lib/backup/legacy-restore";
import {
  restoreLegacyVocabulary,
  restoreLegacyCustomFields,
  restoreLegacyDerivationTemplates,
  restoreLegacyEvidence,
  restoreLegacyPriceData,
  restoreLegacyLineage,
  restoreLegacySnapshots,
} from "@/lib/backup/legacy-restore-misc";
import { clearAllRecords } from "@/lib/data/record-crud";
import { clearTransactions, clearParticipants } from "@/lib/data/transaction-crud";
import { clearUtxoLineage, clearCustodySegments, clearLineageSnapshots } from "@/lib/data/lineage-crud";
import { clearEvidence, clearEvidenceAttachments } from "@/lib/data/evidence-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import { clearRecordOrigins } from "@/lib/data/record-origins-crud";
import { clearCustomFields } from "@/lib/data/custom-fields-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import { clearPriceData } from "@/lib/data/price-data-crud";
import { clearNodeSettings, getNodeSettings } from "@/lib/data/node-settings-crud";
import { clearDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import { clearDustFlags, restoreDustFlagRows } from "@/lib/data/dust-flags-crud";
import { getSettings, updateSettings } from "@/lib/data/settings-crud";
import { db } from "@/lib/database";
import { base64ToBuffer, deriveKey, decrypt } from "@/lib/crypto";
import {
  detectOrphanedTxRecords,
  runTxidBackfill,
  formatSkippedReasons,
} from "@/lib/txid-backfill";
import { resetOrphanCheckGate } from "@/lib/orphan-check-session";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { loadEntitySnapshotFromStorage } from "@/lib/data/entity-list-store";
import { deleteFile } from "@/lib/attachments";

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

    try {
      // v3 streaming backups: read ONLY the manifest (first ZIP entry) via the
      // streaming peek so a multi-GB backup is never loaded into memory just to
      // preview it. The v3 manifest carries counts/encrypted/date in plaintext.
      const manifestPeek = await peekManifest(blobChunks(file));
      if (isV3Manifest(manifestPeek)) {
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

        const attachmentWriter: AttachmentFileWriter = {
          async write(relativePath, fileData) {
            if (isElectron()) {
              const api = getElectronAPI();
              const result = await api.writeAttachment(relativePath, fileData);
              if (!result.success) {
                throw new Error(result.error || `Failed to write attachment ${relativePath}`);
              }
            } else {
              const formData = new FormData();
              formData.append('file', new Blob([fileData]));
              formData.append('relativePath', relativePath);
              const response = await fetch('/api/attachments/write', {
                method: 'POST',
                body: formData,
              });
              if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || response.statusText);
              }
            }
          },
          // Used to sweep files this restore wrote if it fails/cancels after
          // the destructive clear, AND to reclaim OLD-vault files a successful
          // restore left behind, so neither is stranded on disk.
          async delete(relativePath) {
            await deleteFile(`${ATTACHMENTS_DIR}/${relativePath}`);
          },
          // Snapshot of every attachment file on disk before the write phase,
          // so a successful restore can delete prior-vault files the new vault
          // does not reference (relative paths, no `attachments/` prefix).
          async list() {
            if (isElectron()) {
              const api = getElectronAPI();
              const result = await api.listAllAttachments();
              if (!result.success) {
                throw new Error(result.error || "Failed to list attachments");
              }
              return result.files ?? [];
            }
            const response = await fetch("/api/attachments/list-all");
            if (!response.ok) {
              throw new Error(`Failed to list attachments: ${response.status}`);
            }
            const data = await response.json();
            return data.files ?? [];
          },
          // Orphaned files: owning record absent. Route to Needs Review folder
          // under the original filename. Best-effort in Electron; no-op in web.
          async writeReview(originalFilename, fileData) {
            if (isElectron()) {
              const api = getElectronAPI();
              const result = await api.writeNeedsReview(originalFilename, fileData);
              if (!result.success) {
                throw new Error(result.error ?? `Failed to write ${originalFilename} to Needs Review folder`);
              }
            }
          },
        };

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

        // --- Post-restore txid backfill ---
        // Detect orphaned transaction records and fetch their on-chain data.
        // If the provider is unreachable, defer gracefully and tell the user.
        try {
          const { txids } = await detectOrphanedTxRecords();
          if (txids.length > 0) {
            setRestoreMessage(`Rebuilding on-chain data for ${txids.length} transaction${txids.length !== 1 ? "s" : ""}…`);
            const nodeSettings = await getNodeSettings('default');
            let backfillSummary = "";
            if (!nodeSettings) {
              backfillSummary = ` ${txids.length} transaction${txids.length !== 1 ? "s" : ""} need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;
            } else {
              try {
                const provider = createProviderFromSettings(nodeSettings);
                await provider.getBlockHeight(); // connectivity probe
                const bfResult = await runTxidBackfill(provider, txids, {
                  onProgress: (p) => {
                    const pct = p.orphansFound > 0
                      ? Math.round(p.processed / p.orphansFound * 100)
                      : 100;
                    setRestoreMessage(
                      `Rebuilding ${p.processed.toLocaleString()} of ${p.orphansFound.toLocaleString()} transactions…`
                    );
                    setRestoreProgress(pct);
                  },
                });
                const parts: string[] = [];
                if (bfResult.rebuilt > 0) parts.push(`${bfResult.rebuilt} rebuilt`);
                if (bfResult.skipped > 0) {
                  const skippedDetail = formatSkippedReasons(bfResult.skippedReasons);
                  parts.push(skippedDetail || `${bfResult.skipped} skipped`);
                }
                if (bfResult.failed > 0) parts.push(`${bfResult.failed} failed`);
                if (bfResult.prevoutsResolved > 0) parts.push(`${bfResult.prevoutsResolved} input addresses resolved`);
                backfillSummary = parts.length > 0
                  ? ` Transaction data: ${parts.join("; ")}.`
                  : "";
              } catch {
                backfillSummary = ` ${txids.length} transaction${txids.length !== 1 ? "s" : ""} need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;
              }
            }
            const v3OrphanMsg = result.counts.orphanedAttachmentFiles > 0
              ? ` ${result.counts.orphanedAttachmentFiles} attachment file${result.counts.orphanedAttachmentFiles !== 1 ? "s" : ""} could not be re-linked (owning record absent) — find them in the "Needs Review" section of Settings to re-attach or delete them.`
              : "";
            const v3LostMsg = result.counts.orphanedAttachmentFilesLost > 0
              ? ` Warning: ${result.counts.orphanedAttachmentFilesLost} of those file${result.counts.orphanedAttachmentFilesLost !== 1 ? "s" : ""} could not be saved to Needs Review and ${result.counts.orphanedAttachmentFilesLost !== 1 ? "their" : "its"} contents were lost.`
              : "";
            toast({
              title: "Restore Successful",
              description: `Restored ${result.counts.records} records, ${result.counts.blockchainTransactions} transactions, ${result.counts.transactionParticipants} participants, ${result.counts.attachmentFiles} attachment files${result.counts.lineageSnapshots > 0 ? `, ${result.counts.lineageSnapshots} snapshot${result.counts.lineageSnapshots !== 1 ? "s" : ""}` : ""}.${backfillSummary}${v3OrphanMsg}${v3LostMsg}`,
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
          } else {
            const v3OrphanMsg = result.counts.orphanedAttachmentFiles > 0
              ? ` ${result.counts.orphanedAttachmentFiles} attachment file${result.counts.orphanedAttachmentFiles !== 1 ? "s" : ""} could not be re-linked — find them in the "Needs Review" section of Settings to re-attach or delete them.`
              : "";
            const v3LostMsg = result.counts.orphanedAttachmentFilesLost > 0
              ? ` Warning: ${result.counts.orphanedAttachmentFilesLost} of those file${result.counts.orphanedAttachmentFilesLost !== 1 ? "s" : ""} could not be saved to Needs Review and ${result.counts.orphanedAttachmentFilesLost !== 1 ? "their" : "its"} contents were lost.`
              : "";
            toast({
              title: "Restore Successful",
              description: `Restored ${result.counts.records} records, ${result.counts.blockchainTransactions} transactions, ${result.counts.transactionParticipants} participants, ${result.counts.attachmentFiles} attachment files${result.counts.lineageSnapshots > 0 ? `, ${result.counts.lineageSnapshots} snapshot${result.counts.lineageSnapshots !== 1 ? "s" : ""}` : ""}. Existing data was replaced.${v3OrphanMsg}${v3LostMsg}`,
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
          }
        } catch {
          const v3OrphanMsgFallback = result.counts.orphanedAttachmentFiles > 0
            ? ` ${result.counts.orphanedAttachmentFiles} attachment file${result.counts.orphanedAttachmentFiles !== 1 ? "s" : ""} could not be re-linked — find them in the "Needs Review" section of Settings to re-attach or delete them.`
            : "";
          const v3LostMsgFallback = result.counts.orphanedAttachmentFilesLost > 0
            ? ` Warning: ${result.counts.orphanedAttachmentFilesLost} of those file${result.counts.orphanedAttachmentFilesLost !== 1 ? "s" : ""} could not be saved to Needs Review and ${result.counts.orphanedAttachmentFilesLost !== 1 ? "their" : "its"} contents were lost.`
            : "";
          toast({
            title: "Restore Successful",
            description: `Restored ${result.counts.records} records, ${result.counts.blockchainTransactions} transactions, ${result.counts.transactionParticipants} participants, ${result.counts.attachmentFiles} attachment files${result.counts.lineageSnapshots > 0 ? `, ${result.counts.lineageSnapshots} snapshot${result.counts.lineageSnapshots !== 1 ? "s" : ""}` : ""}. Existing data was replaced.${v3OrphanMsgFallback}${v3LostMsgFallback}`,
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
        }

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

      const zip = await JSZip.loadAsync(restoreFile);
      const backupFile = zip.file("backup.json");
      
      if (!backupFile) {
        throw new Error("Invalid backup file");
      }

      setRestoreProgress(10);
      const content = await backupFile.async("text");
      const backup = JSON.parse(content);

      let data = backup.data;

      // If backup is encrypted, decrypt it
      if (backup.encrypted) {
        setRestoreMessage("Decrypting backup...");
        setRestoreProgress(20);

        if (!restorePassword) {
          throw new Error("Password required for encrypted backup");
        }

        // Properly decode the salt from base64
        const salt = base64ToBuffer(backup.salt);
        const backupKey = await deriveKey(restorePassword, salt);

        try {
          const decrypted = await decrypt(backup.data, backupKey);
          data = JSON.parse(decrypted);
        } catch {
          throw new Error("Invalid password or corrupted backup");
        }
      }

      setRestoreProgress(30);
      setRestoreMessage("Processing data...");

      const { 
        records, 
        tags, 
        categories, 
        attachments, 
        recordOrigins, 
        customFields: backupCustomFields,
        owners = [],
        walletNames = [],
        seedNames = [],
        walletSoftware = [],
        derivationTemplates = [],
        evidence = [],
        evidenceAttachments = [],
        priceData = [],
        settings: backupSettings = [],
        nodeSettings: backupNodeSettings = [],
        utxoLineage = [],
        custodySegments = [],
        lineageSnapshots = [],
        blockchainTransactions = [],
        transactionParticipants = [],
        addressSyncState = [],
        dustFlags = [],
      } = data;

      if (restoreMode === "replace") {
        setRestoreMessage("Clearing existing data...");
        setRestoreProgress(40);
        
        await clearAllRecords({ skipNotification: true });
        await db.tags.clear();
        await db.categories.clear();
        await clearAttachments({ skipNotification: true });
        await clearRecordOrigins({ skipNotification: true });
        await clearCustomFields({ skipNotification: true });
        await db.owners.clear();
        await db.walletNames.clear();
        await db.seedNames.clear();
        await db.walletSoftware.clear();
        await clearDerivationTemplates({ skipNotification: true });
        await clearEvidence({ skipNotification: true });
        await clearEvidenceAttachments({ skipNotification: true });
        await clearPriceData({ skipNotification: true });
        await clearNodeSettings({ skipNotification: true });
        await clearUtxoLineage({ skipNotification: true });
        await clearCustodySegments({ skipNotification: true });
        await clearLineageSnapshots({ skipNotification: true });
        await clearTransactions({ skipNotification: true });
        await clearParticipants({ skipNotification: true });
        await clearAddressSyncState({ skipNotification: true });
        // Dust flags point at transaction outputs; a replace restore wipes the
        // transactions above, so stale flags must never survive it. Cleared
        // even though most legacy backups predate the dustFlags table.
        await clearDustFlags({ skipNotification: true });
        // Mark the vault as wiped so the cancel/error handlers know to
        // reload rather than just close the dialog.
        restoreClearedRef.current = true;
      }

      setRestoreProgress(50);
      setRestoreMessage("Restoring records...");

      // Track statistics
      let recordsAdded = 0;
      let recordsSkipped = 0;

      // Backup record id -> live record id. bulkCreateRecords assigns fresh
      // autoincrement ids (it does NOT preserve the backup's ids), and in merge
      // mode an incoming record may map to an already-present record. Every
      // dependent row (attachments, transaction participants, address sync
      // state) must rewrite its recordId through this map, or it would link to
      // the wrong record — or to none at all.
      const recordIdMap = new Map<number, number>();

      // Restore records (de-dup by inputString in merge mode; backup id -> live
      // id recorded in recordIdMap for dependent rows). Shared with tests via
      // the legacy-restore helpers.
      const recordResult = await restoreLegacyRecords(records, restoreMode, recordIdMap);
      recordsAdded = recordResult.recordsAdded;
      recordsSkipped = recordResult.recordsSkipped;
      if (records && records.length > 0) {
        setRestoreProgress(70);
      }

      setRestoreMessage("Restoring tags and categories...");

      // Restore vocabulary (tags, categories, owners, wallet names, seed names,
      // wallet software). Merge mode skips entries whose name already exists;
      // replace mode adds every entry (cleared above). Shared with tests via the
      // legacy-restore-misc helpers.
      const vocabResult = await restoreLegacyVocabulary(
        { tags, categories, owners, walletNames, seedNames, walletSoftware },
        restoreMode,
      );
      const tagsAdded = vocabResult.tagsAdded;
      const categoriesAdded = vocabResult.categoriesAdded;
      const vocabularyAdded = vocabResult.vocabularyAdded;

      setRestoreProgress(80);
      setRestoreMessage("Restoring attachments...");

      // Restore attachment metadata (de-dup by objectStoragePath in merge mode;
      // recordId remapped through recordIdMap, orphans tracked). Shared with
      // tests via the legacy-restore helpers.
      const legacyAttResult: LegacyAttachmentsResult = await restoreLegacyAttachments(
        attachments,
        restoreMode,
        recordIdMap,
      );
      const attachmentsAdded = legacyAttResult.attachmentsAdded;
      const legacyOrphanedRelPaths = legacyAttResult.orphanedRelPaths;

      // Restore attachment files from ZIP. Orphaned files (whose owning record
      // was absent) are routed to the Needs Review folder rather than the normal
      // attachment pool, so no hidden copy is left behind.
      setRestoreProgress(85);
      setRestoreMessage("Restoring attachment files...");
      
      let attachmentFilesRestored = 0;
      let attachmentFilesErrors = 0;
      let legacyOrphanedFilesRouted = 0;
      let legacyOrphanedFilesLost = 0;
      const attachmentsFolder = zip.folder("attachments");
      if (attachmentsFolder) {
        const filePromises: Promise<void>[] = [];
        
        attachmentsFolder.forEach((relativePath, file) => {
          if (!file.dir) {
            filePromises.push((async () => {
              try {
                const fileData = await file.async("arraybuffer");

                // Check if this file belongs to an orphaned attachment (no
                // owning record). If so, route to the Needs Review folder.
                const orphanFilename = legacyOrphanedRelPaths.get(relativePath);
                if (orphanFilename !== undefined) {
                  // Best-effort: a single Needs Review write failure must not
                  // abort the restore. Track lost bytes separately so the
                  // post-restore toast can warn the user instead of silently
                  // dropping recovered evidence.
                  if (isElectron()) {
                    try {
                      const api = getElectronAPI();
                      const result = await api.writeNeedsReview(orphanFilename, fileData);
                      if (!result.success) {
                        throw new Error(result.error ?? `Failed to write ${orphanFilename} to Needs Review folder`);
                      }
                      legacyOrphanedFilesRouted++;
                    } catch (err) {
                      console.error(`Failed to route orphaned attachment file ${relativePath} to Needs Review:`, err);
                      legacyOrphanedFilesLost++;
                    }
                  } else {
                    // Web mode has no Needs Review folder (the write is a no-op),
                    // mirroring the v3 restore path which counts these as routed.
                    legacyOrphanedFilesRouted++;
                  }
                  return;
                }

                if (isElectron()) {
                  const api = getElectronAPI();
                  const result = await api.writeAttachment(relativePath, fileData);
                  if (!result.success) {
                    console.error(`Failed to restore attachment file ${relativePath}:`, result.error);
                    attachmentFilesErrors++;
                    return;
                  }
                } else {
                  // Web mode: use API endpoint
                  const formData = new FormData();
                  formData.append('file', new Blob([fileData]));
                  formData.append('relativePath', relativePath);
                  
                  const response = await fetch('/api/attachments/write', {
                    method: 'POST',
                    body: formData,
                  });
                  
                  if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    console.error(`Failed to restore attachment file ${relativePath}:`, errorData.error || response.statusText);
                    attachmentFilesErrors++;
                    return;
                  }
                }
                
                attachmentFilesRestored++;
              } catch (err) {
                console.error(`Failed to restore attachment file ${relativePath}:`, err);
                attachmentFilesErrors++;
              }
            })());
          }
        });
        
        await Promise.all(filePromises);
      }

      setRestoreProgress(90);
      setRestoreMessage("Restoring custom fields...");

      // Restore custom fields (merge mode de-dups by `slug`; replace mode adds
      // every field). Shared with tests via the legacy-restore-misc helpers.
      const customFieldsAdded = await restoreLegacyCustomFields(
        backupCustomFields,
        restoreMode,
      );

      setRestoreProgress(96);
      setRestoreMessage("Restoring derivation templates...");

      // Restore derivation templates (merge mode de-dups by
      // `fingerprint:scriptType`; replace mode adds every template). Shared with
      // tests via the legacy-restore-misc helpers.
      const templatesAdded = await restoreLegacyDerivationTemplates(
        derivationTemplates,
        restoreMode,
      );

      setRestoreProgress(97);
      setRestoreMessage("Restoring evidence and additional data...");

      // Restore evidence documents and their attachments. Evidence rows get
      // fresh auto-increment ids on restore (clear() does NOT reset IndexedDB
      // key generation), so the attachments' evidenceId must be remapped to the
      // new ids — otherwise restore orphans/mislinks every evidence file. In
      // merge mode the shared helper also skips evidence documents whose identity
      // already exists (and their attachments) so merging the same/overlapping
      // backup more than once doesn't accumulate duplicates; replace mode adds
      // every row (the table was cleared above). The shared helper does this
      // remapping/de-dup (mirroring the v3 path) and is covered by a regression
      // test.
      const evidenceResult = await restoreLegacyEvidence(
        evidence,
        evidenceAttachments,
        restoreMode,
      );
      const evidenceAdded = evidenceResult.evidenceAdded;
      const evidenceAttachmentsAdded = evidenceResult.evidenceAttachmentsAdded;

      // Restore price data (v2.2.0+, not encrypted): no id remapping. In merge
      // mode rows whose [date+currency+asset] already exists are skipped so an
      // overlapping backup doesn't double up daily price rows; replace mode
      // cleared the table above and adds every row. Shared with the v3 inline
      // path via restorePriceDataRows so the two paths can never diverge.
      const priceDataAdded = await restoreLegacyPriceData(priceData, restoreMode);

      // Restore node settings (v2.2.0+, not encrypted). Uses the shared helper
      // so the legacy path and the v3 streaming path can never diverge in how
      // the nodeSettings singleton is restored (id preserved, `put` semantics).
      await restoreNodeSettingsRows(backupNodeSettings);

      // Restore the small allow-list of portable settings preferences (e.g.
      // disableOrphanCheck). Shared helper keeps the legacy and v3 paths from
      // diverging; fields absent from older backups are left at their defaults.
      await restoreSettingsPreferences(backupSettings);

      // Restore UTXO lineage data and custody segments (v2.2.0+, not encrypted):
      // backup ids stripped, no id remapping. In replace mode the tables were
      // cleared above and rows are appended as-is. In merge mode segments whose
      // unique `segmentId` already exists (and lineage edges already present) are
      // skipped, so a merge over an already-present segment no longer throws on
      // the unique index and aborts the restore. Shared with tests via the
      // legacy-restore-misc helpers; only lineage rows are surfaced to the user.
      const lineageResult = await restoreLegacyLineage(utxoLineage, custodySegments, restoreMode);
      const lineageDataAdded = lineageResult.lineageAdded;

      // Restore lineage snapshots (selective-disclosure / Continuity Certificate
      // proof artifacts). New backups stream these, but legacy/inline backups
      // carry them here. backup ids stripped, no remapping. In replace mode the
      // table was cleared above; in merge mode snapshots whose unique
      // `snapshotId` already exists are skipped so the unique index is not
      // violated mid-restore.
      const snapshotsResult = await restoreLegacySnapshots(lineageSnapshots, restoreMode);
      const snapshotsAdded = snapshotsResult.snapshotsAdded;

      // Restore dust flags (user-flagged dust outputs, Dexie v35). Legacy JSON
      // backups produced by KYUTXO never carried a `dustFlags` key (the v3 ZIP
      // format predates the table), so this is defensive: a hand-edited or
      // third-party legacy JSON that DOES include dustFlags must not lose them
      // silently. Shared with the v3 inline path via restoreDustFlagRows so the
      // two paths can never diverge (ids stripped, unique-outpoint de-dup).
      const dustFlagsAdded = await restoreDustFlagRows(dustFlags, restoreMode, {
        skipNotification: true,
      });

      // Restore blockchain transaction data (v2.2.0+, not encrypted): confirmed
      // transactions, their input/output participants, and per-address sync
      // state. Without this a restored vault would have to re-sync everything
      // from scratch. Transactions de-dup by txid; participants are only added
      // for transactions actually inserted and their recordId is rewritten
      // through the recordIdMap (or left undefined when the owning record is
      // absent). Shared with tests via the legacy-restore helpers.
      const txResult = await restoreLegacyTransactions(
        blockchainTransactions,
        transactionParticipants,
        restoreMode,
        recordIdMap,
      );
      const transactionsAdded = txResult.transactionsAdded;
      const participantsAdded = txResult.participantsAdded;
      const transactionsEnriched = txResult.transactionsEnriched;
      const participantsEnriched = txResult.participantsEnriched;

      // Address sync state: unique `address` index, de-duped against existing
      // (merge) and the incoming set; recordId remapped. Shared with tests via
      // the legacy-restore helpers.
      const addressSyncAdded = await restoreLegacyAddressSyncState(
        addressSyncState,
        restoreMode,
        recordIdMap,
      );

      console.log(`[Restore] transactions: ${transactionsAdded}, enriched: ${transactionsEnriched}, participants: ${participantsAdded}, participants enriched: ${participantsEnriched}, synced addresses: ${addressSyncAdded}, dust flags: ${dustFlagsAdded}`);

      setRestoreProgress(100);
      setRestoreMessage("Restore complete! Checking for missing transaction data...");

      let attachmentFilesMsg = "";
      if (attachmentFilesRestored > 0 && attachmentFilesErrors === 0) {
        attachmentFilesMsg = `, ${attachmentFilesRestored} attachment files`;
      } else if (attachmentFilesRestored > 0 && attachmentFilesErrors > 0) {
        attachmentFilesMsg = `, ${attachmentFilesRestored} attachment files (${attachmentFilesErrors} failed)`;
      } else if (attachmentFilesErrors > 0) {
        attachmentFilesMsg = ` (${attachmentFilesErrors} attachment files failed)`;
      }
      let additionalDataMsg = "";
      const legacyOrphanCount = legacyOrphanedFilesRouted;
      if (evidenceAdded > 0 || priceDataAdded > 0 || lineageDataAdded > 0 || snapshotsAdded > 0 || transactionsAdded > 0 || addressSyncAdded > 0 || dustFlagsAdded > 0) {
        const parts = [];
        if (evidenceAdded > 0) parts.push(`${evidenceAdded} evidence`);
        if (priceDataAdded > 0) parts.push(`${priceDataAdded} prices`);
        if (lineageDataAdded > 0) parts.push(`${lineageDataAdded} lineage`);
        if (snapshotsAdded > 0) parts.push(`${snapshotsAdded} snapshot${snapshotsAdded !== 1 ? "s" : ""}`);
        if (transactionsAdded > 0) parts.push(`${transactionsAdded} transactions`);
        if (addressSyncAdded > 0) parts.push(`${addressSyncAdded} synced addresses`);
        if (dustFlagsAdded > 0) parts.push(`${dustFlagsAdded} dust flag${dustFlagsAdded !== 1 ? "s" : ""}`);
        additionalDataMsg = `, ${parts.join(", ")}`;
      }

      const baseMessage = restoreMode === "merge"
        ? `Added ${recordsAdded} records (${recordsSkipped} skipped), ${tagsAdded} tags, ${categoriesAdded} categories, ${vocabularyAdded} vocabulary items, ${templatesAdded} templates${attachmentFilesMsg}${additionalDataMsg}.`
        : `Restored ${recordsAdded} records, ${tagsAdded} tags, ${categoriesAdded} categories, ${vocabularyAdded} vocabulary items, ${templatesAdded} templates${attachmentFilesMsg}${additionalDataMsg}.`;

      // --- Post-restore txid backfill ---
      let backfillSuffix = "";
      try {
        const { txids: orphanTxids } = await detectOrphanedTxRecords();
        if (orphanTxids.length > 0) {
          setRestoreMessage(`Rebuilding on-chain data for ${orphanTxids.length} transaction${orphanTxids.length !== 1 ? "s" : ""}…`);
          const nodeSettingsForBf = await getNodeSettings('default');
          if (!nodeSettingsForBf) {
            backfillSuffix = ` ${orphanTxids.length} transaction${orphanTxids.length !== 1 ? "s" : ""} need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;
          } else {
            try {
              const bfProvider = createProviderFromSettings(nodeSettingsForBf);
              await bfProvider.getBlockHeight(); // connectivity probe
              const bfResult = await runTxidBackfill(bfProvider, orphanTxids, {
                onProgress: (p) => {
                  const pct = p.orphansFound > 0
                    ? Math.round(p.processed / p.orphansFound * 100)
                    : 100;
                  setRestoreMessage(
                    `Rebuilding ${p.processed.toLocaleString()} of ${p.orphansFound.toLocaleString()} transactions…`
                  );
                  setRestoreProgress(pct);
                },
              });
              const bfParts: string[] = [];
              if (bfResult.rebuilt > 0) bfParts.push(`${bfResult.rebuilt} rebuilt`);
              if (bfResult.skipped > 0) {
                const skippedDetail = formatSkippedReasons(bfResult.skippedReasons);
                bfParts.push(skippedDetail || `${bfResult.skipped} skipped`);
              }
              if (bfResult.failed > 0) bfParts.push(`${bfResult.failed} failed`);
              if (bfResult.prevoutsResolved > 0) bfParts.push(`${bfResult.prevoutsResolved} input addresses resolved`);
              backfillSuffix = bfParts.length > 0
                ? ` Transaction data: ${bfParts.join("; ")}.`
                : "";
            } catch {
              backfillSuffix = ` ${orphanTxids.length} transaction${orphanTxids.length !== 1 ? "s" : ""} need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;
            }
          }
        }
      } catch {
        // backfill detection failure is non-fatal
      }

      const legacyOrphanSuffix = legacyOrphanCount > 0
        ? ` ${legacyOrphanCount} attachment file${legacyOrphanCount !== 1 ? "s" : ""} could not be re-linked (owning record absent) — find them in the "Needs Review" section of Settings to re-attach or delete them.`
        : "";
      const legacyOrphanLostSuffix = legacyOrphanedFilesLost > 0
        ? ` Warning: ${legacyOrphanedFilesLost} recovered attachment file${legacyOrphanedFilesLost !== 1 ? "s" : ""} could not be saved to Needs Review and ${legacyOrphanedFilesLost !== 1 ? "their" : "its"} contents were lost.`
        : "";
      toast({
        title: "Restore Successful",
        description: baseMessage + backfillSuffix + legacyOrphanSuffix + legacyOrphanLostSuffix,
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
                <div className="flex items-start space-x-3 p-3 rounded-lg border bg-background hover-elevate">
                  <RadioGroupItem value="merge" id="mode-merge" data-testid="radio-merge" />
                  <div className="space-y-1">
                    <Label htmlFor="mode-merge" className="font-medium cursor-pointer">
                      Merge with existing
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Add backup data to existing records, skipping duplicates
                    </p>
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
