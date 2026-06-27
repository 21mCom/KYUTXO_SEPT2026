// Shared helpers for the LEGACY (pre-v3) backup restore path's append-only
// inline branches: vocabulary (tags/categories/owners/walletNames/seedNames/
// walletSoftware), custom fields, derivation templates, evidence (+ evidence
// attachments), price data, and UTXO lineage + custody segments. These used to
// live inline inside SettingsPage's ~1000-line `handleRestore` with no automated
// coverage, so a regression in their merge-vs-replace de-duplication or id
// handling could silently break a restore.
//
// This module mirrors `./legacy-restore` (the high-risk, id-remapping tables):
// it extracts the inline logic VERBATIM — same de-dup keys, same field defaults,
// same id handling — so the real restore path can be unit-tested over the live
// `@/lib/database` schema via fake-indexeddb. Behaviour MUST stay identical to
// the original inline code:
//   - vocabulary: merge mode skips entries whose (case-sensitive) name already
//     exists; replace mode adds every entry. Tags/categories are counted
//     separately from the other four ("vocabulary items").
//   - custom fields: merge mode skips entries whose `slug` already exists;
//     replace mode adds every entry.
//   - derivation templates: merge mode de-dups by `fingerprint:scriptType`;
//     replace mode adds every entry.
//   - evidence: no de-dup in either mode — every evidence row and every evidence
//     attachment is added. Evidence rows receive fresh autoincrement ids on
//     restore, so each backup evidence id is mapped to its new live id and the
//     attachments' `evidenceId` is remapped through that map; without this an old
//     backup would orphan/mislink every evidence file (mirrors the v3 path).
//   - price data: no id/FK remapping in either mode — every row is added with a
//     fresh autoincrement id (the backup id is stripped). In `merge` mode a row
//     whose `[date+currency+asset]` already exists is skipped (the index is NOT
//     unique, so without this guard merging an overlapping backup silently
//     doubles up the daily price rows); `replace` mode adds every row (the
//     caller cleared the table first). Shared with the v3 inline path via the
//     `restorePriceDataRows` helper so the two paths can never diverge.
//   - utxo lineage + custody segments: no de-dup and no id/FK remapping in
//     either mode — every row is added with a fresh autoincrement id. Custody
//     segments carry a UNIQUE `segmentId` index, so a backup with two rows
//     sharing a segmentId (or a merge over an existing one) would throw; the
//     legacy path never guarded this and relies on `replace` having cleared
//     first. Only utxoLineage is counted for the user ("lineage").
// Every guarded table (evidence, evidenceAttachments, utxoLineage,
// custodySegments) is touched only through its CRUD module; the vocabulary and
// priceData tables are not guarded and are read/written through their CRUD
// module too.

import type { Evidence } from "@/lib/database";
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
import {
  addCustomField,
  getCustomFieldBySlug,
} from "@/lib/data/custom-fields-crud";
import {
  addDerivationTemplate,
  getAllDerivationTemplates,
  type CreateDerivationTemplateData,
} from "@/lib/data/derivation-templates-crud";
import {
  bulkAddEvidence,
  addEvidenceAttachment,
} from "@/lib/data/evidence-crud";
import { restorePriceDataRows } from "@/lib/data/price-data-crud";
import {
  addUtxoLineage,
  addCustodySegment,
  getAllUtxoLineage,
  getExistingSegmentIds,
  type CreateUtxoLineageData,
  type CreateCustodySegmentData,
} from "@/lib/data/lineage-crud";

export type RestoreMode = "merge" | "replace";

/**
 * Restore the vocabulary tables (tags, categories, owners, wallet names, seed
 * names, wallet software). In merge mode an entry is skipped when its name is
 * already present (case-sensitive, matching the legacy inline `Set.has` check);
 * in replace mode every entry is added (the caller clears these tables first).
 *
 * Tags and categories are counted separately from the remaining four (reported
 * to the user as "vocabulary items"), mirroring the original handleRestore
 * statistics.
 */
export async function restoreLegacyVocabulary(
  data: {
    tags?: any[];
    categories?: any[];
    owners?: any[];
    walletNames?: any[];
    seedNames?: any[];
    walletSoftware?: any[];
  },
  restoreMode: RestoreMode,
): Promise<{ tagsAdded: number; categoriesAdded: number; vocabularyAdded: number }> {
  const now = Date.now();
  let tagsAdded = 0;
  let categoriesAdded = 0;
  let vocabularyAdded = 0;

  // For merge mode, gather the names already present so duplicates are skipped.
  let existingTagNames = new Set<string>();
  let existingCategoryNames = new Set<string>();
  let existingOwnerNames = new Set<string>();
  let existingWalletNameNames = new Set<string>();
  let existingSeedNameNames = new Set<string>();
  let existingWalletSoftwareNames = new Set<string>();

  if (restoreMode === "merge") {
    for (const t of await getTags()) existingTagNames.add(t.name);
    for (const c of await getCategories()) existingCategoryNames.add(c.name);
    for (const o of await getOwners()) existingOwnerNames.add(o.name);
    for (const wn of await getWalletNames()) existingWalletNameNames.add(wn.name);
    for (const sn of await getSeedNames()) existingSeedNameNames.add(sn.name);
    for (const ws of await getWalletSoftware()) existingWalletSoftwareNames.add(ws.name);
  }

  for (const tag of data.tags ?? []) {
    const { id, ...tagData } = tag;
    const tagName = tagData.name || "";
    if (restoreMode === "merge" && existingTagNames.has(tagName)) continue;
    await restoreTag({
      name: tagName,
      color: tagData.color || "#888888",
      createdAt: tagData.createdAt || now,
    });
    tagsAdded++;
  }

  for (const category of data.categories ?? []) {
    const { id, ...catData } = category;
    const catName = catData.name || "";
    if (restoreMode === "merge" && existingCategoryNames.has(catName)) continue;
    await restoreCategory({ name: catName, createdAt: catData.createdAt || now });
    categoriesAdded++;
  }

  for (const owner of data.owners ?? []) {
    const { id, ...ownerData } = owner;
    const ownerName = ownerData.name || "";
    if (restoreMode === "merge" && existingOwnerNames.has(ownerName)) continue;
    await restoreOwner({ name: ownerName, createdAt: ownerData.createdAt || now });
    vocabularyAdded++;
  }

  for (const wn of data.walletNames ?? []) {
    const { id, ...wnData } = wn;
    const wnName = wnData.name || "";
    if (restoreMode === "merge" && existingWalletNameNames.has(wnName)) continue;
    await restoreWalletName({ name: wnName, createdAt: wnData.createdAt || now });
    vocabularyAdded++;
  }

  for (const sn of data.seedNames ?? []) {
    const { id, ...snData } = sn;
    const snName = snData.name || "";
    if (restoreMode === "merge" && existingSeedNameNames.has(snName)) continue;
    await restoreSeedName({ name: snName, createdAt: snData.createdAt || now });
    vocabularyAdded++;
  }

  for (const ws of data.walletSoftware ?? []) {
    const { id, ...wsData } = ws;
    const wsName = wsData.name || "";
    if (restoreMode === "merge" && existingWalletSoftwareNames.has(wsName)) continue;
    await restoreWalletSoftware({ name: wsName, createdAt: wsData.createdAt || now });
    vocabularyAdded++;
  }

  return { tagsAdded, categoriesAdded, vocabularyAdded };
}

/**
 * Restore custom field definitions. In merge mode a field is skipped when a
 * field with the same `slug` already exists (the slug is the stable identity);
 * in replace mode every field is added (the caller clears the table first).
 * Fresh autoincrement ids are assigned (the backup id is stripped).
 */
export async function restoreLegacyCustomFields(
  customFields: any[] | undefined,
  restoreMode: RestoreMode,
): Promise<number> {
  let customFieldsAdded = 0;
  if (!customFields || customFields.length === 0) return customFieldsAdded;

  for (const field of customFields) {
    const { id, ...fieldData } = field;
    if (restoreMode === "merge") {
      const existing = await getCustomFieldBySlug(fieldData.slug);
      if (existing) continue;
    }
    await addCustomField(
      { ...fieldData, createdAt: fieldData.createdAt || Date.now() },
      { skipNotification: true },
    );
    customFieldsAdded++;
  }

  return customFieldsAdded;
}

/**
 * Restore derivation templates. In merge mode a template is skipped when one
 * with the same `fingerprint:scriptType` already exists; in replace mode every
 * template is added (the caller clears the table first). Fresh autoincrement ids
 * are assigned (the backup id is stripped) and missing fields fall back to the
 * same defaults the inline restore used.
 */
export async function restoreLegacyDerivationTemplates(
  derivationTemplates: any[] | undefined,
  restoreMode: RestoreMode,
): Promise<number> {
  let templatesAdded = 0;
  if (!derivationTemplates || derivationTemplates.length === 0) return templatesAdded;

  let existingTemplateKeys = new Set<string>();
  if (restoreMode === "merge") {
    const existing = await getAllDerivationTemplates();
    for (const t of existing) {
      existingTemplateKeys.add(`${t.fingerprint}:${t.scriptType}`);
    }
  }

  for (const template of derivationTemplates) {
    const { id, ...templateData } = template;
    const templateKey = `${templateData.fingerprint}:${templateData.scriptType}`;
    if (restoreMode === "merge" && existingTemplateKeys.has(templateKey)) continue;

    const newTemplate: CreateDerivationTemplateData = {
      fingerprint: templateData.fingerprint || "unknown",
      scriptType: templateData.scriptType || "P2WPKH",
      derivationPath: templateData.derivationPath || "m/84'/0'/0'",
      xpub: templateData.xpub,
      gapLimit: templateData.gapLimit || 20,
      network: templateData.network || "mainnet",
      owner: templateData.owner,
      walletName: templateData.walletName,
      seedName: templateData.seedName,
      notes: templateData.notes,
      createdAt: templateData.createdAt || Date.now(),
      updatedAt: templateData.updatedAt || Date.now(),
    };

    await addDerivationTemplate(newTemplate, { skipNotification: true });
    templatesAdded++;
  }

  return templatesAdded;
}

/**
 * Restore evidence documents and their attachments. The legacy path does NOT
 * de-dup evidence in either mode (every row is added with a fresh autoincrement
 * id). Evidence rows receive FRESH ids on restore (clear() does NOT reset
 * IndexedDB key generation), so each backup evidence id is mapped to its new
 * live id and the attachments' `evidenceId` is remapped through that map —
 * otherwise restoring an old backup would orphan/mislink every evidence file by
 * leaving the attachment pointed at a stale backup id (mirrors the v3 restore
 * path in `inline-tables.ts`).
 */
export async function restoreLegacyEvidence(
  evidence: any[] | undefined,
  evidenceAttachments: any[] | undefined,
): Promise<{ evidenceAdded: number; evidenceAttachmentsAdded: number }> {
  let evidenceAdded = 0;
  let evidenceAttachmentsAdded = 0;
  const now = Date.now();
  const evidenceIdMap = new Map<number, number>();

  if (evidence && evidence.length > 0) {
    for (const ev of evidence) {
      const { id, ...evData } = ev;
      const newEvidence = {
        title: evData.title || "Restored Evidence",
        documentType: evData.documentType || "other",
        originalDate: evData.originalDate,
        notes: evData.notes,
        tags: evData.tags || [],
        partiesInvolved: evData.partiesInvolved || [],
        source: evData.source,
        importance: evData.importance,
        createdAt: evData.createdAt || now,
        updatedAt: evData.updatedAt || now,
      };
      const [newId] = await bulkAddEvidence([newEvidence as Evidence], {
        skipNotification: true,
      });
      if (typeof id === "number" && typeof newId === "number") {
        evidenceIdMap.set(id, newId);
      }
      evidenceAdded++;
    }
  }

  if (evidenceAttachments && evidenceAttachments.length > 0) {
    for (const ea of evidenceAttachments) {
      const { id, ...eaData } = ea;
      const mappedEvidenceId =
        typeof eaData.evidenceId === "number"
          ? evidenceIdMap.get(eaData.evidenceId) ?? eaData.evidenceId
          : eaData.evidenceId;
      await addEvidenceAttachment(
        {
          evidenceId: mappedEvidenceId,
          filename: eaData.filename || "unknown",
          mimeType: eaData.mimeType || "application/octet-stream",
          size: eaData.size || 0,
          objectStoragePath: eaData.objectStoragePath || "",
          createdAt: eaData.createdAt || now,
        },
        { skipNotification: true },
      );
      evidenceAttachmentsAdded++;
    }
  }

  return { evidenceAdded, evidenceAttachmentsAdded };
}

/**
 * Restore daily price data rows. Delegates to the shared `restorePriceDataRows`
 * so the legacy path and the v3 inline path can never diverge. The backup id is
 * always stripped (fresh autoincrement id). In `merge` mode a row whose
 * `[date+currency+asset]` already exists is skipped (the index is NOT unique, so
 * without this guard merging a backup that overlaps the current vault's dates
 * silently doubles up the daily price rows); in `replace` mode every row is
 * added (the caller clears the table first), matching the original append-only
 * behaviour. Returns the number added (the "prices" count surfaced to the user).
 */
export async function restoreLegacyPriceData(
  priceData: any[] | undefined,
  restoreMode: RestoreMode = "replace",
): Promise<number> {
  return restorePriceDataRows(priceData, restoreMode);
}

// Stable identity for a UTXO lineage edge (the spent input → created output it
// records). utxoLineage has no unique index, so merge mode uses this to skip
// rows that already exist rather than appending a duplicate edge.
export function lineageIdentity(row: {
  spentTxid?: unknown;
  spentVout?: unknown;
  createdTxid?: unknown;
  createdVout?: unknown;
}): string {
  return `${row.spentTxid}:${row.spentVout}->${row.createdTxid}:${row.createdVout}`;
}

/**
 * Restore UTXO lineage rows and custody segments. In BOTH modes the backup id is
 * stripped (every row gets a fresh autoincrement id) and no id/FK is remapped.
 *
 * Custody segments carry a UNIQUE `segmentId` index. In `replace` mode the
 * caller has cleared the tables first, so rows are appended as-is — two backup
 * rows sharing a segmentId still throw (replace behaviour is unchanged). In
 * `merge` mode a segment is skipped when its `segmentId` is already present in
 * the vault, so a merge-restore over an already-present segment no longer
 * violates the unique index and aborts the whole restore mid-way. utxoLineage
 * has no unique index, but in merge mode rows whose `lineageIdentity` already
 * exists are likewise skipped so a merge does not pile up duplicate edges.
 *
 * Only `utxoLineage` rows are counted for the user (the "lineage" count);
 * custody segments are restored but not separately reported, matching the
 * original inline statistics. Counts reflect rows actually written (skipped
 * duplicates are not counted).
 */
export async function restoreLegacyLineage(
  utxoLineage: any[] | undefined,
  custodySegments: any[] | undefined,
  restoreMode: RestoreMode = "replace",
): Promise<{ lineageAdded: number; segmentsAdded: number }> {
  let lineageAdded = 0;
  let segmentsAdded = 0;

  // In merge mode, gather the identities already present so duplicates are
  // skipped instead of duplicated (lineage) or throwing (custody segments).
  const existingLineageKeys = new Set<string>();
  let existingSegmentIds = new Set<string>();
  if (restoreMode === "merge") {
    for (const l of await getAllUtxoLineage()) existingLineageKeys.add(lineageIdentity(l));
    existingSegmentIds = await getExistingSegmentIds();
  }

  if (utxoLineage && utxoLineage.length > 0) {
    for (const ul of utxoLineage) {
      const { id, ...ulData } = ul;
      if (restoreMode === "merge") {
        const key = lineageIdentity(ulData);
        if (existingLineageKeys.has(key)) continue;
        existingLineageKeys.add(key);
      }
      await addUtxoLineage(ulData as CreateUtxoLineageData, { skipNotification: true });
      lineageAdded++;
    }
  }

  if (custodySegments && custodySegments.length > 0) {
    for (const cs of custodySegments) {
      const { id, ...csData } = cs;
      if (restoreMode === "merge") {
        const segmentId = csData.segmentId;
        if (typeof segmentId === "string" && existingSegmentIds.has(segmentId)) continue;
        if (typeof segmentId === "string") existingSegmentIds.add(segmentId);
      }
      await addCustodySegment(csData as CreateCustodySegmentData, { skipNotification: true });
      segmentsAdded++;
    }
  }

  return { lineageAdded, segmentsAdded };
}
