// Shared helpers for the LEGACY (pre-v3) backup restore path's LOWER-RISK
// inline branches: vocabulary (tags/categories/owners/walletNames/seedNames/
// walletSoftware), custom fields, derivation templates, and evidence (+ evidence
// attachments). These used to live inline inside SettingsPage's ~1000-line
// `handleRestore` with no automated coverage, so a regression in their
// merge-vs-replace de-duplication or id handling could silently break a restore.
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
//     attachment is added. The legacy path does NOT remap evidence ids, so
//     evidence attachments keep their backup `evidenceId` as-is. (Relinking
//     attachments to the freshly-assigned evidence ids — the fix for old backups
//     orphaning evidence attachments — is tracked separately; this helper
//     preserves the existing legacy behaviour so it can be characterised.)
// Every guarded table (evidence, evidenceAttachments) is touched only through
// its CRUD module; the vocabulary tables are not guarded and are read/written
// through the vocabulary CRUD module too.

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
 * id) and does NOT remap evidence ids — evidence attachments keep their backup
 * `evidenceId` verbatim. (The id-remap that prevents old backups from orphaning
 * evidence attachments is tracked as a separate fix; this helper preserves the
 * existing legacy behaviour so it can be characterised and tested.)
 */
export async function restoreLegacyEvidence(
  evidence: any[] | undefined,
  evidenceAttachments: any[] | undefined,
): Promise<{ evidenceAdded: number; evidenceAttachmentsAdded: number }> {
  let evidenceAdded = 0;
  let evidenceAttachmentsAdded = 0;
  const now = Date.now();

  if (evidence && evidence.length > 0) {
    const evidenceRows = evidence.map((ev) => {
      const { id, ...evData } = ev;
      return {
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
    });
    await bulkAddEvidence(evidenceRows as Evidence[], { skipNotification: true });
    evidenceAdded = evidenceRows.length;
  }

  if (evidenceAttachments && evidenceAttachments.length > 0) {
    for (const ea of evidenceAttachments) {
      const { id, ...eaData } = ea;
      await addEvidenceAttachment(
        {
          evidenceId: eaData.evidenceId,
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
