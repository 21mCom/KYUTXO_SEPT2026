// Read / clear / restore for the SMALL tables that ride inline inside the v3
// manifest (everything except the five streamed big tables and the records
// table). Behaviour deliberately MIRRORS the legacy restore so v3 introduces no
// regression for these tables:
//   - `settings` is not cleared and not wholesale restored (current app
//     settings survive), but a small allow-list of portable preferences (e.g.
//     `disableOrphanCheck`) plus the user's custom Privacy Audit entity-list
//     snapshot (`entityListSnapshot`) is merged from the backup on restore.
//   - `recordOrigins` is cleared here but re-added by the ORCHESTRATOR
//     (restore.ts): its rows reference records by id, so they can only be
//     remapped once the records stream has built the old→new id map. This
//     module just hands the raw rows back via `pendingRecordOrigins`.
// Records and the four record-dependent big tables are handled by the streaming
// orchestrator (restore.ts), not here.
//
// Every guarded table is touched only through its CRUD module; the vocabulary
// tables (tags/categories/owners/walletNames/seedNames/walletSoftware) are not
// guarded and are read/cleared directly.

import { db } from "@/lib/database";
import {
  getTags,
  getCategories,
  getOwners,
  getWalletNames,
  getSeedNames,
  getWalletSoftware,
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
  deleteCustomField,
} from "@/lib/data/custom-fields-crud";
import {
  getAllDerivationTemplates,
  addDerivationTemplate,
  clearDerivationTemplates,
  deleteDerivationTemplate,
} from "@/lib/data/derivation-templates-crud";
import {
  getAllEvidence,
  getAllEvidenceAttachments,
  restoreEvidenceRows,
  clearEvidence,
  clearEvidenceAttachments,
  deleteEvidence,
  deleteEvidenceAttachment,
} from "@/lib/data/evidence-crud";
import {
  getAllPriceData,
  restorePriceDataRows,
  clearPriceData,
  bulkDeletePriceData,
} from "@/lib/data/price-data-crud";
import { getAllSettings, getSettings, updateSettings } from "@/lib/data/settings-crud";
import {
  getAllDustFlags,
  clearDustFlags,
  restoreDustFlagRows,
  unmarkDustOutpoints,
} from "@/lib/data/dust-flags-crud";
import {
  getAllSavedPsbts,
  clearSavedPsbts,
  restoreSavedPsbtRows,
  deleteSavedPsbt,
} from "@/lib/data/saved-psbts-crud";
import {
  getAllAdversaryScenarios,
  clearAdversaryScenarios,
  restoreAdversaryScenarioRows,
  deleteAdversaryScenario,
} from "@/lib/data/adversary-scenarios-crud";
import {
  getAllNodeSettings,
  putNodeSettings,
  clearNodeSettings,
} from "@/lib/data/node-settings-crud";
import {
  bulkAddUtxoLineage,
  bulkAddCustodySegments,
  bulkAddLineageSnapshots,
  getAllUtxoLineage,
  getExistingSegmentIds,
  getExistingSnapshotIds,
} from "@/lib/data/lineage-crud";
import { lineageIdentity, type RestoreMode } from "./legacy-restore-misc";
import { derivationTemplateIdentity } from "./merge-keys";
import { FUND_TRAIL_LAYOUT_OPTIONS } from "@/components/fund-trail/view-data";
import {
  formatQuantumTagLevels,
  sanitizeQuantumTagLevels,
  type QuantumRiskLevel,
} from "@/lib/quantum-risk";

// Recognized Fund Trail layout values + their human-readable labels, derived
// from the single source of truth so this allow-list never drifts from the UI.
const FUND_TRAIL_LAYOUT_VALUES = new Set<string>(
  FUND_TRAIL_LAYOUT_OPTIONS.map((o) => o.value),
);
const FUND_TRAIL_LAYOUT_LABELS: Record<string, string> = Object.fromEntries(
  FUND_TRAIL_LAYOUT_OPTIONS.map((o) => [o.value, o.label]),
);

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
    key: "fundTrailLayout",
    label: "Fund Trail layout",
    // Only carry a recognized layout value; anything else (missing field on an
    // older backup, or an unknown string) leaves the current value untouched.
    extract: (s) =>
      typeof s.fundTrailLayout === "string" &&
      FUND_TRAIL_LAYOUT_VALUES.has(s.fundTrailLayout)
        ? s.fundTrailLayout
        : undefined,
    format: (v) =>
      FUND_TRAIL_LAYOUT_LABELS[v as string] ?? String(v),
  },
  {
    key: "intermediaryAddressCap",
    label: "Fund Trail export intermediary-address cap",
    extract: (s) =>
      typeof s.intermediaryAddressCap === "number" && Number.isFinite(s.intermediaryAddressCap)
        ? s.intermediaryAddressCap
        : undefined,
    format: (v) => `${(v as number).toLocaleString()} addresses`,
  },
  {
    key: "sourceOfFundsTxLimit",
    label: "Source of Funds report cap",
    extract: (s) =>
      typeof s.sourceOfFundsTxLimit === "number" && Number.isFinite(s.sourceOfFundsTxLimit)
        ? s.sourceOfFundsTxLimit
        : undefined,
    format: (v) => `${(v as number).toLocaleString()} transactions`,
  },
  {
    key: "quantumTagLevels",
    label: "Quantum Scanner tagged risk levels",
    // Only carry a recognized selection: an array whose entries are all known
    // risk levels (type-checked extract via sanitizeQuantumTagLevels). An empty
    // array is valid — it round-trips the deliberate "analysis only, tag
    // nothing" choice. Anything else (missing field on an older backup, or
    // malformed entries) leaves the current value untouched.
    extract: (s) => sanitizeQuantumTagLevels(s.quantumTagLevels),
    format: (v) => formatQuantumTagLevels(v as QuantumRiskLevel[]),
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
    dustFlags,
    savedPsbts,
    adversaryScenarios,
  ] = await Promise.all([
    getAllRecordOrigins(),
    getAllCustomFields(),
    getAllDerivationTemplates(),
    getAllEvidence(),
    getAllEvidenceAttachments(),
    getAllPriceData(),
    getAllSettings(),
    getAllNodeSettings(),
    getAllDustFlags(),
    getAllSavedPsbts(),
    getAllAdversaryScenarios(),
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
    dustFlags,
    savedPsbts,
    adversaryScenarios,
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
  await clearDustFlags({ skipNotification: true });
  await clearSavedPsbts({ skipNotification: true });
  await clearAdversaryScenarios({ skipNotification: true });
  // NOTE: settings is intentionally not cleared (matches legacy restore).
  // utxoLineage, custodySegments and lineageSnapshots are streamed tables now;
  // the restore orchestrator clears them, not this inline path.
}

// Ids of DATA rows an inline restore inserted into the lineage compatibility
// tables (older v3 backups carried utxoLineage / custodySegments /
// lineageSnapshots inline instead of streamed). Returned so the merge-cancel
// undo pass in restore.ts can remove them along with the streamed-table rows —
// otherwise cancelling a merge of an OLD backup would leave these behind.
export interface InlineRestoreResult {
  insertedUtxoLineageIds: number[];
  insertedCustodySegmentIds: number[];
  insertedLineageSnapshotIds: number[];
  // Merge mode only: removes every inline METADATA row this restore inserted
  // (vocabulary names, custom fields, derivation templates, evidence documents
  // and their attachment rows, price rows, dust flags, saved PSBTs), returning
  // the number of rows removed. Wired into the merge-cancel undo pass in
  // restore.ts so a cancelled merge leaves NO trace, not even tiny metadata.
  // Absent in replace mode (a replace clears the vault first; there is no
  // pre-restore state to return to).
  //
  // NOT covered: portable settings preferences and nodeSettings — those paths
  // MERGE INTO existing singleton rows rather than inserting new ones, and the
  // UI's pre-restore snapshot (undoInlinePrefs) already restores them.
  undoInlineMetadata?: () => Promise<number>;
  // Raw `recordOrigins` rows from the backup, NOT inserted here: their
  // `recordId` foreign keys reference the backup's record ids, and the
  // old→new id map only exists once the records NDJSON stream has been
  // processed by the orchestrator (which runs AFTER this inline restore).
  // restore.ts remaps and inserts them at the end of the stream. Older
  // backups without the key simply yield an empty array.
  pendingRecordOrigins: any[];
}

export async function restoreInlineTables(
  data: Record<string, unknown>,
  restoreMode: RestoreMode = "replace",
): Promise<InlineRestoreResult> {
  const arr = (k: string): any[] => (Array.isArray(data[k]) ? (data[k] as any[]) : []);
  const now = Date.now();

  // Vocabulary tables de-dupe by `name` in merge mode (the raw restore*
  // helpers are blind Dexie adds with no uniqueness constraint, so without
  // this every re-merge would visibly duplicate tags/owners/etc). The seen-set
  // also collapses duplicates within the incoming backup itself. Replace mode
  // is unchanged: the orchestrator cleared these tables first, so every backup
  // row is added verbatim.
  const isMergeMode = restoreMode === "merge";

  // Merge mode only: track every inline METADATA row this restore inserts, by
  // fresh primary key (or, for dust flags, the unique outpoint natural key),
  // so `undoInlineMetadata` on the returned result can remove exactly those
  // rows if the merge is later cancelled. Pre-existing rows and rows skipped
  // by the natural-key de-dup are never touched by the undo.
  const meta = isMergeMode
    ? {
        tagIds: [] as number[],
        categoryIds: [] as number[],
        ownerIds: [] as number[],
        walletNameIds: [] as number[],
        seedNameIds: [] as number[],
        walletSoftwareIds: [] as number[],
        customFieldIds: [] as number[],
        derivationTemplateIds: [] as number[],
        evidenceIds: [] as number[],
        evidenceAttachmentIds: [] as number[],
        priceDataIds: [] as number[],
        dustFlagOutpoints: [] as string[],
        savedPsbtIds: [] as number[],
        adversaryScenarioIds: [] as number[],
      }
    : null;

  const vocabSeen = async (
    existing: () => Promise<Array<{ name: string }>>,
  ): Promise<Set<string>> => {
    const seen = new Set<string>();
    if (isMergeMode) for (const v of await existing()) seen.add(v.name);
    return seen;
  };
  const vocabSkip = (seen: Set<string>, name: string): boolean => {
    if (!isMergeMode) return false;
    if (!name || seen.has(name)) return true;
    seen.add(name);
    return false;
  };

  const seenTags = await vocabSeen(getTags);
  for (const tag of arr("tags")) {
    const name = tag.name || "";
    if (vocabSkip(seenTags, name)) continue;
    const newTagId = await restoreTag({
      name,
      color: tag.color || "#888888",
      createdAt: tag.createdAt || now,
    });
    meta?.tagIds.push(newTagId);
  }
  const seenCategories = await vocabSeen(getCategories);
  for (const cat of arr("categories")) {
    const name = cat.name || "";
    if (vocabSkip(seenCategories, name)) continue;
    const newCategoryId = await restoreCategory({ name, createdAt: cat.createdAt || now });
    meta?.categoryIds.push(newCategoryId);
  }
  const seenOwners = await vocabSeen(getOwners);
  for (const owner of arr("owners")) {
    const name = owner.name || "";
    if (vocabSkip(seenOwners, name)) continue;
    const newOwnerId = await restoreOwner({ name, createdAt: owner.createdAt || now });
    meta?.ownerIds.push(newOwnerId);
  }
  const seenWalletNames = await vocabSeen(getWalletNames);
  for (const wn of arr("walletNames")) {
    const name = wn.name || "";
    if (vocabSkip(seenWalletNames, name)) continue;
    const newWalletNameId = await restoreWalletName({ name, createdAt: wn.createdAt || now });
    meta?.walletNameIds.push(newWalletNameId);
  }
  const seenSeedNames = await vocabSeen(getSeedNames);
  for (const sn of arr("seedNames")) {
    const name = sn.name || "";
    if (vocabSkip(seenSeedNames, name)) continue;
    const newSeedNameId = await restoreSeedName({ name, createdAt: sn.createdAt || now });
    meta?.seedNameIds.push(newSeedNameId);
  }
  const seenWalletSoftware = await vocabSeen(getWalletSoftware);
  for (const ws of arr("walletSoftware")) {
    const name = ws.name || "";
    if (vocabSkip(seenWalletSoftware, name)) continue;
    const newWalletSoftwareId = await restoreWalletSoftware({ name, createdAt: ws.createdAt || now });
    meta?.walletSoftwareIds.push(newWalletSoftwareId);
  }

  // Merge mode: custom fields de-dupe by their unique `slug` (auto-derived
  // from name), so re-merging the same backup never duplicates a field
  // definition. Incoming duplicates within the backup itself are skipped too.
  const existingFieldSlugs = new Set<string>();
  if (restoreMode === "merge") {
    for (const f of await getAllCustomFields()) existingFieldSlugs.add(f.slug);
  }
  for (const field of arr("customFields")) {
    const { id, ...d } = field;
    if (restoreMode === "merge") {
      const slug = typeof d.slug === "string" ? d.slug : "";
      if (slug && existingFieldSlugs.has(slug)) continue;
      if (slug) existingFieldSlugs.add(slug);
    }
    const newFieldId = await addCustomField(
      { ...d, createdAt: d.createdAt || now },
      { skipNotification: true },
    );
    meta?.customFieldIds.push(newFieldId);
  }

  // Merge mode: derivation templates have no unique index, so de-dupe by their
  // natural identity (derivationTemplateIdentity, shared with the read-only
  // merge analysis) — covering both existing rows and duplicates within the
  // incoming backup.
  const templateIdentity = derivationTemplateIdentity;
  const existingTemplateKeys = new Set<string>();
  if (restoreMode === "merge") {
    for (const t of await getAllDerivationTemplates()) {
      existingTemplateKeys.add(templateIdentity(t));
    }
  }
  for (const t of arr("derivationTemplates")) {
    const { id, ...d } = t;
    if (restoreMode === "merge") {
      const key = templateIdentity(d);
      if (existingTemplateKeys.has(key)) continue;
      existingTemplateKeys.add(key);
    }
    const newTemplateId = await addDerivationTemplate(
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
    meta?.derivationTemplateIds.push(newTemplateId);
  }

  // Evidence rows are re-`add`ed and so receive fresh auto-increment ids; the
  // shared helper maps each original id to its new id so evidenceAttachments
  // (which reference evidence by id) are relinked — otherwise restore would
  // orphan every attachment because the table's key generator is not reset by
  // `clear()`. In merge mode the helper also skips evidence documents whose
  // identity already exists (and their attachments), so merging the same backup
  // twice doesn't accumulate duplicate documents. Routed through the shared
  // restoreEvidenceRows helper so the v3 and legacy paths can never diverge.
  const evidenceResult = await restoreEvidenceRows(
    arr("evidence"),
    arr("evidenceAttachments"),
    restoreMode,
  );
  if (meta) {
    meta.evidenceIds.push(...evidenceResult.insertedEvidenceIds);
    meta.evidenceAttachmentIds.push(...evidenceResult.insertedEvidenceAttachmentIds);
  }

  // Routed through the shared restorePriceDataRows helper so the v3 and legacy
  // paths can never diverge in how price rows are de-duplicated. In replace
  // mode the orchestrator cleared the vault first, so every row is added; in
  // merge mode the helper skips rows whose natural key already exists.
  await restorePriceDataRows(
    arr("priceData"),
    restoreMode,
    meta ? { insertedIds: meta.priceDataIds } : undefined,
  );

  await restoreNodeSettingsRows(arr("nodeSettings"));
  await restoreSettingsPreferences(arr("settings"));

  // dustFlags (user-flagged dust outputs, Dexie v35) ride inline. Older backups
  // that predate the table simply have no `dustFlags` key, so `arr` returns []
  // and they restore cleanly. In replace mode the table was cleared above; in
  // merge mode rows whose unique `outpoint` already exists are skipped so the
  // unique index can't abort the restore mid-way.
  await restoreDustFlagRows(
    arr("dustFlags"),
    restoreMode,
    { skipNotification: true },
    meta ? { insertedOutpoints: meta.dustFlagOutpoints } : undefined,
  );

  // savedPsbts (unsigned PSBTs from the watch-only builder, Dexie v37) ride
  // inline like dustFlags. Older backups have no `savedPsbts` key and restore
  // cleanly. In merge mode rows whose PSBT bytes already exist are skipped.
  // Inputs reference txids (stable), but notarization data outputs reference
  // evidence/attachment ids — those CHANGE on restore, so they are remapped
  // through the maps produced by restoreEvidenceRows above; references whose
  // target is not in the backup are dropped rather than left dangling.
  await restoreSavedPsbtRows(
    arr("savedPsbts"),
    restoreMode,
    { skipNotification: true },
    meta ? { insertedIds: meta.savedPsbtIds } : undefined,
    {
      evidenceIdMap: evidenceResult.evidenceIdMap,
      evidenceAttachmentIdMap: evidenceResult.evidenceAttachmentIdMap,
    },
  );

  // adversaryScenarios (Privacy Audit "what if they knew?" counterparty
  // scenarios, Dexie v39) ride inline like savedPsbts. Older backups have no
  // `adversaryScenarios` key and restore cleanly. Rows carry no foreign keys
  // (addresses/txids are stable strings), so no id remap is needed; in merge
  // mode rows whose (name, counterparty) identity already exists are skipped.
  await restoreAdversaryScenarioRows(
    arr("adversaryScenarios"),
    restoreMode,
    { skipNotification: true },
    meta ? { insertedIds: meta.adversaryScenarioIds } : undefined,
  );

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

  const result: InlineRestoreResult = {
    insertedUtxoLineageIds: [],
    insertedCustodySegmentIds: [],
    insertedLineageSnapshotIds: [],
    pendingRecordOrigins: arr("recordOrigins"),
  };

  if (lineageRows.length) {
    result.insertedUtxoLineageIds = await bulkAddUtxoLineage(lineageRows as any[], {
      skipNotification: true,
    });
  }
  if (segmentRows.length) {
    result.insertedCustodySegmentIds = await bulkAddCustodySegments(segmentRows as any[], {
      skipNotification: true,
    });
  }

  // lineageSnapshots (selective-disclosure proof artifacts) are a streamed table
  // now, so NEW backups carry them as NDJSON (handled by the restore
  // orchestrator) and won't have them inline. This inline branch mirrors the
  // custodySegments handling above so a backup that DOES carry snapshots inline
  // is never silently dropped. In replace mode the caller cleared the table
  // first, so rows are appended as-is. In merge mode snapshots whose unique
  // `snapshotId` already exists are skipped, so a merge over an already-present
  // snapshot does not violate the unique index and abort the restore mid-way.
  let snapshotRows = arr("lineageSnapshots").map((sn) => {
    const { id, ...d } = sn;
    return d;
  });

  if (restoreMode === "merge" && snapshotRows.length) {
    const existingSnapshotIds = await getExistingSnapshotIds();
    snapshotRows = snapshotRows.filter((d) => {
      const snapshotId = d.snapshotId;
      if (typeof snapshotId === "string" && existingSnapshotIds.has(snapshotId)) return false;
      if (typeof snapshotId === "string") existingSnapshotIds.add(snapshotId);
      return true;
    });
  }

  if (snapshotRows.length) {
    result.insertedLineageSnapshotIds = await bulkAddLineageSnapshots(snapshotRows as any[], {
      skipNotification: true,
    });
  }

  // recordOrigins ride inline in the backup but are handed back RAW via
  // `pendingRecordOrigins` (see InlineRestoreResult): their recordId foreign
  // keys reference backup record ids, so restore.ts remaps and inserts them
  // once the records stream has built the old→new id map. The `settings`
  // table is not wholesale restored either, but a small allow-list of
  // portable preferences is merged via restoreSettingsPreferences above.

  if (meta) {
    // Merge mode: expose an undo that removes exactly the metadata rows THIS
    // restore inserted (tracked above). Deletion order: evidence attachments
    // before their evidence documents (deleteEvidence also sweeps attachments
    // by evidenceId, so the explicit pass is belt-and-braces for attachments
    // whose evidenceId did not remap to a merged document); everything else is
    // independent. Vocabulary tables are unguarded (see file header) and are
    // deleted directly, mirroring how they are cleared/added here.
    result.undoInlineMetadata = async () => {
      for (const id of meta.evidenceAttachmentIds) {
        await deleteEvidenceAttachment(id, { skipNotification: true });
      }
      for (const id of meta.evidenceIds) {
        await deleteEvidence(id, { skipNotification: true });
      }
      for (const id of meta.customFieldIds) {
        await deleteCustomField(id, { skipNotification: true });
      }
      for (const id of meta.derivationTemplateIds) {
        await deleteDerivationTemplate(id, { skipNotification: true });
      }
      await bulkDeletePriceData(meta.priceDataIds, { skipNotification: true });
      if (meta.dustFlagOutpoints.length > 0) {
        await unmarkDustOutpoints(meta.dustFlagOutpoints);
      }
      for (const id of meta.savedPsbtIds) {
        await deleteSavedPsbt(id);
      }
      for (const id of meta.adversaryScenarioIds) {
        await deleteAdversaryScenario(id, { skipNotification: true });
      }
      await db.tags.bulkDelete(meta.tagIds);
      await db.categories.bulkDelete(meta.categoryIds);
      await db.owners.bulkDelete(meta.ownerIds);
      await db.walletNames.bulkDelete(meta.walletNameIds);
      await db.seedNames.bulkDelete(meta.seedNameIds);
      await db.walletSoftware.bulkDelete(meta.walletSoftwareIds);
      return (
        meta.tagIds.length +
        meta.categoryIds.length +
        meta.ownerIds.length +
        meta.walletNameIds.length +
        meta.seedNameIds.length +
        meta.walletSoftwareIds.length +
        meta.customFieldIds.length +
        meta.derivationTemplateIds.length +
        meta.evidenceIds.length +
        meta.evidenceAttachmentIds.length +
        meta.priceDataIds.length +
        meta.dustFlagOutpoints.length +
        meta.savedPsbtIds.length +
        meta.adversaryScenarioIds.length
      );
    };
  }

  return result;
}
