// Read / clear / restore for the SMALL tables that ride inline inside the v3
// manifest (everything except the five streamed big tables and the records
// table). Behaviour deliberately MIRRORS the legacy restore so v3 introduces no
// regression for these tables:
//   - `settings` is not cleared and not wholesale restored (current app
//     settings survive), but a small allow-list of portable preferences (e.g.
//     `disableOrphanCheck`) is merged from the backup on restore.
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
} from "@/lib/data/lineage-crud";

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

/**
 * Restore the round-trippable preferences from the backup's `settings` rows.
 *
 * The `settings` table as a whole is intentionally NEITHER cleared NOR wholesale
 * restored (see `clearInlineTables`) so device-local preferences (theme, column
 * layout, etc.) survive a restore. A small allow-list of *portable* preferences,
 * however, should follow the user across devices/backups. We merge those into
 * the existing `default` settings row instead of replacing it.
 *
 * A field that is absent from the backup is left untouched, so restoring an
 * older backup that predates a preference keeps that preference at its current
 * (default) value.
 */
export async function restoreSettingsPreferences(rows: any[]): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const source = rows.find((r) => r && r.id === "default") ?? rows[0];
  if (!source || typeof source !== "object") return;

  const updates: Record<string, unknown> = {};
  if (typeof source.disableOrphanCheck === "boolean") {
    updates.disableOrphanCheck = source.disableOrphanCheck;
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
  const lineageRows = arr("utxoLineage").map((ul) => {
    const { id, ...d } = ul;
    return d;
  });
  if (lineageRows.length) {
    await bulkAddUtxoLineage(lineageRows as any[], { skipNotification: true });
  }

  const segmentRows = arr("custodySegments").map((cs) => {
    const { id, ...d } = cs;
    return d;
  });
  if (segmentRows.length) {
    await bulkAddCustodySegments(segmentRows as any[], { skipNotification: true });
  }

  // NOTE: recordOrigins is intentionally NOT restored (matches legacy restore
  // behaviour). The `settings` table is not wholesale restored either, but a
  // small allow-list of portable preferences is merged via
  // restoreSettingsPreferences above.
}
