// Read / clear / restore for the SMALL tables that ride inline inside the v3
// manifest (everything except the five streamed big tables and the records
// table). Behaviour deliberately MIRRORS the legacy restore so v3 introduces no
// regression for these tables:
//   - `settings` is not cleared and not wholesale restored (current app
//     settings survive), but a small allow-list of portable preferences (e.g.
//     `disableOrphanCheck`) plus the user's custom Privacy Audit entity-list
//     snapshot (`entityListSnapshot`) is merged from the backup on restore.
//   - `recordOrigins` is cleared but NOT re-added (legacy never restored it).
// Records and the four record-dependent big tables are handled by the streaming
// orchestrator (restore.ts), not here.
//
// Every guarded table is touched only through its CRUD module; the vocabulary
// tables (tags/categories/owners/walletNames/seedNames/walletSoftware) are not
// guarded and are read/cleared directly.

import { db } from "@/lib/database";
import type { Evidence } from "@/lib/database";
import {
  restoreTag,
  restoreCategory,
  restoreOwner,
  restoreWalletName,
  restoreSeedName,
  restoreWalletSoftware,
} from "@/lib/data/vocabulary-crud";
import { getAllRecordOrigins, clearRecordOrigins } from "@/lib/data/record-origins-crud";
import {
  getAllCustomFields,
  addCustomField,
  clearCustomFields,
} from "@/lib/data/custom-fields-crud";
import {
  getAllDerivationTemplates,
  addDerivationTemplate,
  clearDerivationTemplates,
} from "@/lib/data/derivation-templates-crud";
import {
  getAllEvidence,
  getAllEvidenceAttachments,
  bulkAddEvidence,
  addEvidenceAttachment,
  clearEvidence,
  clearEvidenceAttachments,
} from "@/lib/data/evidence-crud";
import { getAllPriceData, addPriceData, clearPriceData } from "@/lib/data/price-data-crud";
import { getAllSettings, getSettings, updateSettings } from "@/lib/data/settings-crud";
import {
  getAllNodeSettings,
  putNodeSettings,
  clearNodeSettings,
} from "@/lib/data/node-settings-crud";
import {
  bulkAddUtxoLineage,
  bulkAddCustodySegments,
  getAllUtxoLineage,
  getExistingSegmentIds,
} from "@/lib/data/lineage-crud";
import { lineageIdentity, type RestoreMode } from "./legacy-restore-misc";

/**
 * Restore the `nodeSettings` singleton rows from a backup. Shared by BOTH the
 * v3 streaming restore (`restoreInlineTables` below) and the legacy JSON restore
 * in SettingsPage so the two paths can never diverge. `nodeSettings` is a
 * singleton keyed by a stable id (default "default"); the id MUST be preserved
 * and the write MUST use `put` (not `add`) so restoring an existing/duplicate
 * backup overwrites in place instead of throwing a duplicate-key error.
 */
export async function restoreNodeSettingsRows(rows: any[]): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  for (const ns of rows) {
    const row = { ...ns, id: ns.id ?? "default" };
    await putNodeSettings(row, { skipNotification: true });
  }
}

// Single source of truth for the PORTABLE preferences allow-list. The `settings`
// table as a whole is intentionally NEITHER cleared NOR wholesale restored (see
// `clearInlineTables`) so device-local preferences (theme, column layout, etc.)
// survive a restore. The fields below, however, should follow the user across
// devices/backups, so they are merged into the existing `default` settings row
// on restore.
//
// Each descriptor knows how to (a) validate+extract its value from a backup's
// settings row (returning `undefined` when the backup has no usable value, so
// the field is left untouched) and (b) format that value for the human-readable
// pre-restore preview. Both `restoreSettingsPreferences` (which applies the
// changes) and `previewSettingsPreferences` (which describes them to the user)
// are driven by this one list, so the two can never drift apart.
interface PortablePreferenceDescriptor {
  key: string;
  label: string;
  // Returns the validated value to merge, or `undefined` to leave the current
  // (device-local) value untouched.
  extract: (source: any) => unknown | undefined;
  // Human-readable rendering of an extracted value for the preview UI.
  format: (value: unknown) => string;
}

const PORTABLE_PREFERENCES: PortablePreferenceDescriptor[] = [
  {
    key: "disableOrphanCheck",
    label: "Missing transaction reminder",
    extract: (s) =>
      typeof s.disableOrphanCheck === "boolean" ? s.disableOrphanCheck : undefined,
    // disableOrphanCheck=true means the reminder is OFF.
    format: (v) => (v ? "Off" : "On"),
  },
  {
    key: "cancelConfirmThreshold",
    label: "Lineage cancel-confirmation threshold",
    // Numeric prefs: only carry finite numbers so an older/malformed backup
    // (missing field, NaN, etc.) leaves the current value untouched.
    extract: (s) =>
      typeof s.cancelConfirmThreshold === "number" && Number.isFinite(s.cancelConfirmThreshold)
        ? s.cancelConfirmThreshold
        : undefined,
    format: (v) => (v === 0 ? "Always confirm" : `${v}%`),
  },
  {
    key: "privacyHistoryLimit",
    label: "Privacy Audit history limit",
    extract: (s) =>
      typeof s.privacyHistoryLimit === "number" && Number.isFinite(s.privacyHistoryLimit)
        ? s.privacyHistoryLimit
        : undefined,
    format: (v) => `${v} runs`,
  },
  {
    key: "fundTrailTxLimit",
    label: "Fund Trail transaction limit",
    extract: (s) =>
      typeof s.fundTrailTxLimit === "number" && Number.isFinite(s.fundTrailTxLimit)
        ? s.fundTrailTxLimit
        : undefined,
    format: (v) => `${(v as number).toLocaleString()} per hop`,
  },
  {
    key: "entityListSnapshot",
    label: "Custom Privacy Audit entity list",
    // The entity-list snapshot is user data (not a device-local preference), so
    // it must follow the user across devices/backups. Only carry it when the
    // backup has a well-formed snapshot with at least one entry; anything else
    // leaves the current value untouched (so older backups that predate the
    // feature, or backups taken after a "revert to bundled", do not clobber a
    // snapshot already present on this device).
    extract: (s) => {
      const snap = s.entityListSnapshot;
      return snap &&
        typeof snap === "object" &&
        Array.isArray(snap.entries) &&
        snap.entries.length > 0
        ? snap
        : undefined;
    },
    format: (v) => {
      const n = (v as { entries: unknown[] }).entries.length;
      return `${n} ${n === 1 ? "entry" : "entries"}`;
    },
  },
];

// Picks the settings row a restore would merge from: the `default` row if
// present, otherwise the first row. Returns null when there is nothing usable.
function pickSettingsSource(rows: any[]): any | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const source = rows.find((r) => r && r.id === "default") ?? rows[0];
  if (!source || typeof source !== "object") return null;
  return source;
}

// A per-field description of what a restore WOULD do to one portable
// preference: whether the backup carries a usable value (and the formatted
// value), or whether the current device value is left untouched.
export interface PortablePreferencePreview {
  key: string;
  label: string;
  fromBackup: boolean;
  backupValue: string | null;
}

/**
 * Describe — without changing anything — which portable preferences a backup's
 * `settings` rows would carry over on restore. Every allow-listed preference is
 * returned (so the UI can also show the ones left as device-local), each marked
 * `fromBackup: true` with a formatted `backupValue` when the backup has a usable
 * value, or `fromBackup: false` when the current device value would be kept.
 */
export function previewSettingsPreferences(rows: any[]): PortablePreferencePreview[] {
  const source = pickSettingsSource(rows);
  return PORTABLE_PREFERENCES.map((d) => {
    const value = source ? d.extract(source) : undefined;
    const fromBackup = value !== undefined;
    return {
      key: d.key,
      label: d.label,
      fromBackup,
      backupValue: fromBackup ? d.format(value) : null,
    };
  });
}

/**
 * Restore the round-trippable preferences from the backup's `settings` rows.
 *
 * The `settings` table as a whole is intentionally NEITHER cleared NOR wholesale
 * restored (see `clearInlineTables`) so device-local preferences (theme, column
 * layout, etc.) survive a restore. A small allow-list of *portable* preferences
 * (see `PORTABLE_PREFERENCES`) is merged into the existing `default` settings
 * row instead of replacing it.
 *
 * A field that is absent from (or malformed in) the backup is left untouched, so
 * restoring an older backup that predates a preference keeps that preference at
 * its current (default) value.
 */
export async function restoreSettingsPreferences(rows: any[]): Promise<void> {
  const source = pickSettingsSource(rows);
  if (!source) return;

  const updates: Record<string, unknown> = {};
  for (const d of PORTABLE_PREFERENCES) {
    const value = d.extract(source);
    if (value !== undefined) updates[d.key] = value;
  }
  if (Object.keys(updates).length === 0) return;

  const existing = await getSettings("default");
  if (!existing) return;
  await updateSettings("default", updates, { skipNotification: true });
}

export async function readInlineTables(): Promise<Record<string, unknown[]>> {
  const [tags, categories, owners, walletNames, seedNames, walletSoftware] =
    await Promise.all([
      db.tags.toArray(),
      db.categories.toArray(),
      db.owners.toArray(),
      db.walletNames.toArray(),
      db.seedNames.toArray(),
      db.walletSoftware.toArray(),
    ]);
  const [
    recordOrigins,
    customFields,
    derivationTemplates,
    evidence,
    evidenceAttachments,
    priceData,
    settings,
    nodeSettings,
  ] = await Promise.all([
    getAllRecordOrigins(),
    getAllCustomFields(),
    getAllDerivationTemplates(),
    getAllEvidence(),
    getAllEvidenceAttachments(),
    getAllPriceData(),
    getAllSettings(),
    getAllNodeSettings(),
  ]);

  return {
    tags,
    categories,
    owners,
    walletNames,
    seedNames,
    walletSoftware,
    recordOrigins,
    customFields,
    derivationTemplates,
    evidence,
    evidenceAttachments,
    priceData,
    settings,
    nodeSettings,
  };
}

export async function clearInlineTables(): Promise<void> {
  await db.tags.clear();
  await db.categories.clear();
  await db.owners.clear();
  await db.walletNames.clear();
  await db.seedNames.clear();
  await db.walletSoftware.clear();
  await clearRecordOrigins({ skipNotification: true });
  await clearCustomFields({ skipNotification: true });
  await clearDerivationTemplates({ skipNotification: true });
  await clearEvidence({ skipNotification: true });
  await clearEvidenceAttachments({ skipNotification: true });
  await clearPriceData({ skipNotification: true });
  await clearNodeSettings({ skipNotification: true });
  // NOTE: settings is intentionally not cleared (matches legacy restore).
  // utxoLineage and custodySegments are streamed tables now; the restore
  // orchestrator clears them, not this inline path.
}

export async function restoreInlineTables(
  data: Record<string, unknown>,
  restoreMode: RestoreMode = "replace",
): Promise<void> {
  const arr = (k: string): any[] => (Array.isArray(data[k]) ? (data[k] as any[]) : []);
  const now = Date.now();

  for (const tag of arr("tags")) {
    await restoreTag({
      name: tag.name || "",
      color: tag.color || "#888888",
      createdAt: tag.createdAt || now,
    });
  }
  for (const cat of arr("categories")) {
    await restoreCategory({ name: cat.name || "", createdAt: cat.createdAt || now });
  }
  for (const owner of arr("owners")) {
    await restoreOwner({ name: owner.name || "", createdAt: owner.createdAt || now });
  }
  for (const wn of arr("walletNames")) {
    await restoreWalletName({ name: wn.name || "", createdAt: wn.createdAt || now });
  }
  for (const sn of arr("seedNames")) {
    await restoreSeedName({ name: sn.name || "", createdAt: sn.createdAt || now });
  }
  for (const ws of arr("walletSoftware")) {
    await restoreWalletSoftware({ name: ws.name || "", createdAt: ws.createdAt || now });
  }

  for (const field of arr("customFields")) {
    const { id, ...d } = field;
    await addCustomField({ ...d, createdAt: d.createdAt || now }, { skipNotification: true });
  }

  for (const t of arr("derivationTemplates")) {
    const { id, ...d } = t;
    await addDerivationTemplate(
      {
        fingerprint: d.fingerprint || "unknown",
        scriptType: d.scriptType || "P2WPKH",
        derivationPath: d.derivationPath || "m/84'/0'/0'",
        xpub: d.xpub,
        gapLimit: d.gapLimit || 20,
        network: d.network || "mainnet",
        owner: d.owner,
        walletName: d.walletName,
        seedName: d.seedName,
        notes: d.notes,
        createdAt: d.createdAt || now,
        updatedAt: d.updatedAt || now,
      },
      { skipNotification: true },
    );
  }

  // Evidence rows are re-`add`ed and so receive fresh auto-increment ids. We map
  // each original id to its new id so evidenceAttachments (which reference
  // evidence by id) can be relinked below — otherwise restore would orphan every
  // attachment because the table's key generator is not reset by `clear()`.
  const evidenceSource = arr("evidence");
  const evidenceRows = evidenceSource.map((ev) => {
    const { id, ...d } = ev;
    return {
      title: d.title || "Restored Evidence",
      documentType: d.documentType || "other",
      originalDate: d.originalDate,
      notes: d.notes,
      tags: d.tags || [],
      partiesInvolved: d.partiesInvolved || [],
      source: d.source,
      importance: d.importance,
      createdAt: d.createdAt || now,
      updatedAt: d.updatedAt || now,
    };
  });
  const evidenceIdMap = new Map<number, number>();
  if (evidenceRows.length) {
    const newIds = await bulkAddEvidence(evidenceRows as Evidence[], {
      skipNotification: true,
    });
    evidenceSource.forEach((ev, i) => {
      if (typeof ev.id === "number" && typeof newIds[i] === "number") {
        evidenceIdMap.set(ev.id, newIds[i]);
      }
    });
  }

  for (const ea of arr("evidenceAttachments")) {
    const { id, ...d } = ea;
    const mappedEvidenceId =
      typeof d.evidenceId === "number"
        ? evidenceIdMap.get(d.evidenceId) ?? d.evidenceId
        : d.evidenceId;
    await addEvidenceAttachment(
      {
        evidenceId: mappedEvidenceId,
        filename: d.filename || "unknown",
        mimeType: d.mimeType || "application/octet-stream",
        size: d.size || 0,
        objectStoragePath: d.objectStoragePath || "",
        createdAt: d.createdAt || now,
      },
      { skipNotification: true },
    );
  }

  for (const pd of arr("priceData")) {
    const { id, ...d } = pd;
    await addPriceData(d, { skipNotification: true });
  }

  await restoreNodeSettingsRows(arr("nodeSettings"));
  await restoreSettingsPreferences(arr("settings"));

  // utxoLineage and custodySegments are streamed tables now, so NEW backups
  // carry them as NDJSON (handled by the restore orchestrator) and won't have
  // them inline. But OLDER v3 backups stored them inline — restore those here
  // when present so upgrading the format never silently drops lineage data.
  //
  // In replace mode the caller cleared these tables first, so rows are appended
  // as-is. In merge mode segments whose unique `segmentId` already exists (and
  // lineage edges already present) are skipped, so a merge over an
  // already-present segment does not violate the unique index and abort the
  // restore mid-way.
  let lineageRows = arr("utxoLineage").map((ul) => {
    const { id, ...d } = ul;
    return d;
  });
  let segmentRows = arr("custodySegments").map((cs) => {
    const { id, ...d } = cs;
    return d;
  });

  if (restoreMode === "merge") {
    if (lineageRows.length) {
      const existingLineageKeys = new Set<string>();
      for (const l of await getAllUtxoLineage()) existingLineageKeys.add(lineageIdentity(l));
      lineageRows = lineageRows.filter((d) => {
        const key = lineageIdentity(d);
        if (existingLineageKeys.has(key)) return false;
        existingLineageKeys.add(key);
        return true;
      });
    }
    if (segmentRows.length) {
      const existingSegmentIds = await getExistingSegmentIds();
      segmentRows = segmentRows.filter((d) => {
        const segmentId = d.segmentId;
        if (typeof segmentId === "string" && existingSegmentIds.has(segmentId)) return false;
        if (typeof segmentId === "string") existingSegmentIds.add(segmentId);
        return true;
      });
    }
  }

  if (lineageRows.length) {
    await bulkAddUtxoLineage(lineageRows as any[], { skipNotification: true });
  }
  if (segmentRows.length) {
    await bulkAddCustodySegments(segmentRows as any[], { skipNotification: true });
  }

  // NOTE: recordOrigins is intentionally NOT restored (matches legacy restore
  // behaviour). The `settings` table is not wholesale restored either, but a
  // small allow-list of portable preferences is merged via
  // restoreSettingsPreferences above.
}
