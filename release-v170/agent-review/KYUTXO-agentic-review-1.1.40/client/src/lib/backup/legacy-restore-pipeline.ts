// The legacy whole-file JSON restore pipeline, extracted out of the
// RestoreBackupFlow component so the recovery-path logic is a testable,
// non-React module. Handles: reading backup.json out of the ZIP, decrypting
// (if encrypted), the destructive clear (replace mode), restoring every table
// through the shared legacy-restore helpers, writing attachment files from
// the ZIP (orphans routed to Needs Review), and building the success summary
// message. The calling component owns all UI state and toasts; it receives
// progress via callbacks and errors via thrown exceptions.
import JSZip from "jszip";
import { isElectron, getElectronAPI } from "@/lib/electron";
import { base64ToBuffer, deriveKey, decrypt, LEGACY_PBKDF2_ITERATIONS } from "@/lib/crypto";
import { rearmSearchVisibilityRepair } from "@/lib/vault";
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
import {
  restoreNodeSettingsRows,
  restoreSettingsPreferences,
} from "@/lib/backup/inline-tables";
import { clearAllRecords } from "@/lib/data/record-crud";
import { clearTransactions, clearParticipants } from "@/lib/data/transaction-crud";
import {
  clearUtxoLineage,
  clearCustodySegments,
  clearLineageSnapshots,
} from "@/lib/data/lineage-crud";
import { clearEvidence, clearEvidenceAttachments } from "@/lib/data/evidence-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import {
  clearRecordOrigins,
  bulkAddRecordOrigins,
  getRecordOriginsByRecordIds,
  type CreateRecordOriginData,
} from "@/lib/data/record-origins-crud";
import { clearCustomFields } from "@/lib/data/custom-fields-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import { clearPriceData } from "@/lib/data/price-data-crud";
import { clearNodeSettings } from "@/lib/data/node-settings-crud";
import { clearDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import { clearDustFlags, restoreDustFlagRows } from "@/lib/data/dust-flags-crud";
import { clearAuditSession } from "@/lib/data/privacy-audit-session-store";
import { db } from "@/lib/database";

export type LegacyRestoreMode = "replace" | "merge";

export interface LegacyRestoreCallbacks {
  /** Progress updates for the restore dialog (percent + phase message). */
  onProgress: (percent: number, message: string) => void;
  /**
   * Called the moment the destructive clear has run (replace mode) — the
   * point of no return. The component uses this to switch its cancel/error
   * handling to "vault was wiped" semantics.
   */
  onCleared: () => void;
}

export interface LegacyRestoreSummary {
  /** The success-toast body ("Restored N records, …" / "Added N records …"). */
  baseMessage: string;
  /** Orphaned attachment files routed to Needs Review (owning record absent). */
  orphanedFilesRouted: number;
  /** Orphaned files whose Needs Review write failed — contents lost. */
  orphanedFilesLost: number;
}

/**
 * Remap and re-insert recordOrigins rows from a legacy backup. Backup
 * `recordId` values are rewritten through the old→new record id map built by
 * restoreLegacyRecords; rows whose record was not restored are skipped. In
 * merge mode, rows already present in the live table (matched by the natural
 * key recordId + originType + source + createdAt — the same key the v3
 * streaming restore de-dupes by) are skipped. Returns the number of rows
 * inserted.
 */
async function restoreLegacyRecordOrigins(
  backupRecordOrigins: unknown,
  restoreMode: LegacyRestoreMode,
  recordIdMap: Map<number, number>,
): Promise<number> {
  if (!Array.isArray(backupRecordOrigins) || backupRecordOrigins.length === 0) {
    return 0;
  }

  const remapped: CreateRecordOriginData[] = [];
  for (const o of backupRecordOrigins) {
    if (!o || typeof o !== "object") continue;
    const { id: _id, ...d } = o as Record<string, unknown>;
    const oldRecordId = d.recordId;
    if (typeof oldRecordId !== "number") continue;
    const recordId = recordIdMap.get(oldRecordId);
    if (recordId === undefined) continue;
    remapped.push({ ...d, recordId } as CreateRecordOriginData);
  }
  if (remapped.length === 0) return 0;

  let toInsert = remapped;
  if (restoreMode === "merge") {
    const originKey = (o: {
      recordId: number;
      originType?: unknown;
      source?: unknown;
      createdAt?: unknown;
    }): string =>
      [o.recordId, o.originType ?? "", o.source ?? "", o.createdAt ?? ""].join("|");
    const affectedRecordIds = Array.from(new Set(remapped.map((o) => o.recordId)));
    const seen = new Set<string>();
    for (const live of await getRecordOriginsByRecordIds(affectedRecordIds)) {
      seen.add(originKey(live));
    }
    toInsert = [];
    for (const o of remapped) {
      const k = originKey(o);
      if (seen.has(k)) continue;
      seen.add(k);
      toInsert.push(o);
    }
  }
  if (toInsert.length === 0) return 0;
  await bulkAddRecordOrigins(toInsert, { skipNotification: true });
  return toInsert.length;
}

/**
 * Run the full legacy whole-file JSON restore. Throws on unreadable/invalid
 * backups and wrong passwords (with user-presentable messages); the caller
 * decides how to surface those. On success returns the summary for the toast.
 */
export async function runLegacyJsonRestore(
  file: File,
  password: string,
  restoreMode: LegacyRestoreMode,
  cb: LegacyRestoreCallbacks,
): Promise<LegacyRestoreSummary> {
  const zip = await JSZip.loadAsync(file);
  const backupFile = zip.file("backup.json");

  if (!backupFile) {
    throw new Error("Invalid backup file");
  }

  cb.onProgress(10, "Reading backup file...");
  const content = await backupFile.async("text");
  const backup = JSON.parse(content);

  let data = backup.data;

  // If backup is encrypted, decrypt it
  if (backup.encrypted) {
    cb.onProgress(20, "Decrypting backup...");

    if (!password) {
      throw new Error("Password required for encrypted backup");
    }

    // Properly decode the salt from base64. Legacy (pre-v3) backups record no
    // KDF parameters and were only ever written at the legacy iteration count.
    const salt = base64ToBuffer(backup.salt);
    const backupKey = await deriveKey(password, salt, LEGACY_PBKDF2_ITERATIONS);

    try {
      const decrypted = await decrypt(backup.data, backupKey);
      data = JSON.parse(decrypted);
    } catch {
      throw new Error("Invalid password or corrupted backup");
    }
  }

  cb.onProgress(30, "Processing data...");

  const {
    records,
    tags,
    categories,
    attachments,
    recordOrigins: backupRecordOrigins = [],
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
    cb.onProgress(40, "Clearing existing data...");

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
    // Drop any saved Privacy Audit / Adversary View session — it was
    // computed from the vault being replaced, so restoring it after this
    // restore would show results about data that no longer exists.
    // Best-effort: failure must not abort the restore.
    try {
      await clearAuditSession();
    } catch (err) {
      console.warn("Failed to clear saved privacy audit session:", err);
    }
    // Mark the vault as wiped so the caller's cancel/error handlers know to
    // reload rather than just close the dialog.
    cb.onCleared();
  }

  cb.onProgress(50, "Restoring records...");

  // Backup record id -> live record id. bulkCreateRecords assigns fresh
  // autoincrement ids (it does NOT preserve the backup's ids), and in merge
  // mode an incoming record may map to an already-present record. Every
  // dependent row (attachments, transaction participants, address sync
  // state) must rewrite its recordId through this map, or it would link to
  // the wrong record — or to none at all.
  const recordIdMap = new Map<number, number>();

  // Restore records (de-dup by inputString in merge mode; backup id -> live
  // id recorded in recordIdMap for dependent rows).
  const recordResult = await restoreLegacyRecords(records, restoreMode, recordIdMap);
  const recordsAdded = recordResult.recordsAdded;
  const recordsSkipped = recordResult.recordsSkipped;
  if (records && records.length > 0) {
    cb.onProgress(70, "Restoring records...");
  }

  // Restore recordOrigins (source history driving the Conflict Resolution
  // page). Mirrors restorePendingRecordOrigins in the v3 streaming restore:
  // each row's recordId references a BACKUP record id, so it is rewritten
  // through recordIdMap (rows whose owning record was not restored are
  // dropped). In merge mode rows are de-duped against the live table by the
  // same natural key (recordId + originType + source + createdAt) so merging
  // an overlapping backup never accumulates duplicate history. Legacy backups
  // without the table (default `[]`) restore cleanly with zero rows added.
  const recordOriginsAdded = await restoreLegacyRecordOrigins(
    backupRecordOrigins,
    restoreMode,
    recordIdMap,
  );
  void recordOriginsAdded;

  cb.onProgress(70, "Restoring tags and categories...");

  // Restore vocabulary (tags, categories, owners, wallet names, seed names,
  // wallet software). Merge mode skips entries whose name already exists;
  // replace mode adds every entry (cleared above).
  const vocabResult = await restoreLegacyVocabulary(
    { tags, categories, owners, walletNames, seedNames, walletSoftware },
    restoreMode,
  );
  const tagsAdded = vocabResult.tagsAdded;
  const categoriesAdded = vocabResult.categoriesAdded;
  const vocabularyAdded = vocabResult.vocabularyAdded;

  cb.onProgress(80, "Restoring attachments...");

  // Restore attachment metadata (de-dup by objectStoragePath in merge mode;
  // recordId remapped through recordIdMap, orphans tracked).
  const legacyAttResult: LegacyAttachmentsResult = await restoreLegacyAttachments(
    attachments,
    restoreMode,
    recordIdMap,
  );
  const legacyOrphanedRelPaths = legacyAttResult.orphanedRelPaths;

  // Restore attachment files from ZIP. Orphaned files (whose owning record
  // was absent) are routed to the Needs Review folder rather than the normal
  // attachment pool, so no hidden copy is left behind.
  cb.onProgress(85, "Restoring attachment files...");

  let attachmentFilesRestored = 0;
  let attachmentFilesErrors = 0;
  let legacyOrphanedFilesRouted = 0;
  let legacyOrphanedFilesLost = 0;
  const attachmentsFolder = zip.folder("attachments");
  if (attachmentsFolder) {
    const filePromises: Promise<void>[] = [];

    attachmentsFolder.forEach((relativePath, zipEntry) => {
      if (!zipEntry.dir) {
        filePromises.push(
          (async () => {
            try {
              const fileData = await zipEntry.async("arraybuffer");

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
                      throw new Error(
                        result.error ?? `Failed to write ${orphanFilename} to Needs Review folder`,
                      );
                    }
                    legacyOrphanedFilesRouted++;
                  } catch (err) {
                    console.error(
                      `Failed to route orphaned attachment file ${relativePath} to Needs Review:`,
                      err,
                    );
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
                formData.append("file", new Blob([fileData]));
                formData.append("relativePath", relativePath);

                const response = await fetch("/api/attachments/write", {
                  method: "POST",
                  body: formData,
                });

                if (!response.ok) {
                  const errorData = await response.json().catch(() => ({}));
                  console.error(
                    `Failed to restore attachment file ${relativePath}:`,
                    errorData.error || response.statusText,
                  );
                  attachmentFilesErrors++;
                  return;
                }
              }

              attachmentFilesRestored++;
            } catch (err) {
              console.error(`Failed to restore attachment file ${relativePath}:`, err);
              attachmentFilesErrors++;
            }
          })(),
        );
      }
    });

    await Promise.all(filePromises);
  }

  cb.onProgress(90, "Restoring custom fields...");

  // Restore custom fields (merge mode de-dups by `slug`; replace mode adds
  // every field).
  const customFieldsAdded = await restoreLegacyCustomFields(backupCustomFields, restoreMode);
  void customFieldsAdded;

  cb.onProgress(96, "Restoring derivation templates...");

  // Restore derivation templates (merge mode de-dups by
  // `fingerprint:scriptType`; replace mode adds every template).
  const templatesAdded = await restoreLegacyDerivationTemplates(derivationTemplates, restoreMode);

  cb.onProgress(97, "Restoring evidence and additional data...");

  // Restore evidence documents and their attachments. Evidence rows get
  // fresh auto-increment ids on restore (clear() does NOT reset IndexedDB
  // key generation), so the attachments' evidenceId must be remapped to the
  // new ids — otherwise restore orphans/mislinks every evidence file. In
  // merge mode the shared helper also skips evidence documents whose identity
  // already exists (and their attachments) so merging the same/overlapping
  // backup more than once doesn't accumulate duplicates; replace mode adds
  // every row (the table was cleared above).
  const evidenceResult = await restoreLegacyEvidence(evidence, evidenceAttachments, restoreMode);
  const evidenceAdded = evidenceResult.evidenceAdded;

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
  // the unique index and aborts the restore.
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
  // absent).
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
  // (merge) and the incoming set; recordId remapped.
  const addressSyncAdded = await restoreLegacyAddressSyncState(
    addressSyncState,
    restoreMode,
    recordIdMap,
  );

  console.log(
    `[Restore] transactions: ${transactionsAdded}, enriched: ${transactionsEnriched}, participants: ${participantsAdded}, participants enriched: ${participantsEnriched}, synced addresses: ${addressSyncAdded}, dust flags: ${dustFlagsAdded}`,
  );

  // Merge-mode restores can add many records/transactions the saved Privacy
  // Audit / Adversary View session never analysed, silently leaving stale,
  // incomplete results (e.g. "no findings" while merged-in data would flag).
  // Replace mode already drops the session during the destructive clear above;
  // do the same after a successful merge so saved results always describe the
  // current vault. Best-effort: the session lives in a separate scratch
  // IndexedDB database and its failure must never fail a completed restore.
  if (restoreMode === "merge") {
    try {
      await clearAuditSession();
    } catch (err) {
      console.warn("Failed to clear saved privacy audit session:", err);
    }
  }

  cb.onProgress(100, "Restore complete! Checking for missing transaction data...");

  let attachmentFilesMsg = "";
  if (attachmentFilesRestored > 0 && attachmentFilesErrors === 0) {
    attachmentFilesMsg = `, ${attachmentFilesRestored} attachment files`;
  } else if (attachmentFilesRestored > 0 && attachmentFilesErrors > 0) {
    attachmentFilesMsg = `, ${attachmentFilesRestored} attachment files (${attachmentFilesErrors} failed)`;
  } else if (attachmentFilesErrors > 0) {
    attachmentFilesMsg = ` (${attachmentFilesErrors} attachment files failed)`;
  }
  let additionalDataMsg = "";
  if (
    evidenceAdded > 0 ||
    priceDataAdded > 0 ||
    lineageDataAdded > 0 ||
    snapshotsAdded > 0 ||
    transactionsAdded > 0 ||
    addressSyncAdded > 0 ||
    dustFlagsAdded > 0
  ) {
    const parts = [];
    if (evidenceAdded > 0) parts.push(`${evidenceAdded} evidence`);
    if (priceDataAdded > 0) parts.push(`${priceDataAdded} prices`);
    if (lineageDataAdded > 0) parts.push(`${lineageDataAdded} lineage`);
    if (snapshotsAdded > 0)
      parts.push(`${snapshotsAdded} snapshot${snapshotsAdded !== 1 ? "s" : ""}`);
    if (transactionsAdded > 0) parts.push(`${transactionsAdded} transactions`);
    if (addressSyncAdded > 0) parts.push(`${addressSyncAdded} synced addresses`);
    if (dustFlagsAdded > 0)
      parts.push(`${dustFlagsAdded} dust flag${dustFlagsAdded !== 1 ? "s" : ""}`);
    additionalDataMsg = `, ${parts.join(", ")}`;
  }

  const baseMessage =
    restoreMode === "merge"
      ? `Added ${recordsAdded} records (${recordsSkipped} skipped), ${tagsAdded} tags, ${categoriesAdded} categories, ${vocabularyAdded} vocabulary items, ${templatesAdded} templates${attachmentFilesMsg}${additionalDataMsg}.`
      : `Restored ${recordsAdded} records, ${tagsAdded} tags, ${categoriesAdded} categories, ${vocabularyAdded} vocabulary items, ${templatesAdded} templates${attachmentFilesMsg}${additionalDataMsg}.`;

  // Re-arm the once-per-vault startup search-visibility repair: legacy backups
  // predate the tier vocabulary and the inputStringLower search key, so a
  // legacy restore is the most likely path to reintroduce rows those repairs
  // fix. Best-effort — must never turn a successful restore into a failure.
  try {
    await rearmSearchVisibilityRepair();
  } catch {}

  return {
    baseMessage,
    orphanedFilesRouted: legacyOrphanedFilesRouted,
    orphanedFilesLost: legacyOrphanedFilesLost,
  };
}
