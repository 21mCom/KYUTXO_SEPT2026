import { notifyDbChange, type Evidence, type EvidenceAttachment } from '../database';
import { getVaultRepository } from '../repository';
import { listVaultRows, queryVaultRows } from './repository-helpers';

export type CreateEvidenceData = Omit<Evidence, 'id' | 'createdAt' | 'updatedAt'>;
export type CreateEvidenceAttachmentData = Omit<EvidenceAttachment, 'id' | 'createdAt'> & {
  createdAt?: number;
};

export interface EvidenceWriteOptions {
  skipNotification?: boolean;
}

export async function addEvidence(
  data: CreateEvidenceData,
  options?: EvidenceWriteOptions
): Promise<number> {
  const now = Date.now();
  const evidence: Evidence = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  const id = await getVaultRepository().add('evidence', evidence);

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }

  return id as number;
}

export async function bulkAddEvidence(
  records: Evidence[],
  options?: EvidenceWriteOptions
): Promise<number[]> {
  if (records.length === 0) return [];

  const ids = await getVaultRepository().bulkPut('evidence', records);

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }

  return ids as number[];
}

export async function putEvidence(
  data: Evidence,
  options?: EvidenceWriteOptions
): Promise<void> {
  await getVaultRepository().put('evidence', data);

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }
}

export async function updateEvidence(
  id: number,
  changes: Partial<Evidence>,
  options?: EvidenceWriteOptions
): Promise<void> {
  const existing = await getVaultRepository().get('evidence', id);
  if (!existing) throw new Error('Evidence not found');

  const updated: Evidence = {
    ...existing,
    ...changes,
    id,
    updatedAt: Date.now(),
  };

  await getVaultRepository().put('evidence', updated);

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }
}

export async function deleteEvidence(
  id: number,
  options?: EvidenceWriteOptions
): Promise<void> {
  const attachments = await getEvidenceAttachmentsByEvidenceId(id);

  for (const attachment of attachments) {
    if (attachment.id) {
      await getVaultRepository().delete('evidenceAttachments', attachment.id);
    }
  }

  await getVaultRepository().delete('evidence', id);

  if (!options?.skipNotification) {
    notifyDbChange(['evidence', 'evidenceAttachments']);
  }
}

export async function clearEvidence(
  options?: EvidenceWriteOptions
): Promise<void> {
  await getVaultRepository().clear('evidence');

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }
}

export async function addEvidenceAttachment(
  data: CreateEvidenceAttachmentData,
  options?: EvidenceWriteOptions
): Promise<number> {
  const attachment: EvidenceAttachment = {
    ...data,
    createdAt: data.createdAt ?? Date.now(),
  };

  const id = await getVaultRepository().add('evidenceAttachments', attachment);

  if (!options?.skipNotification) {
    notifyDbChange('evidenceAttachments');
  }

  return id as number;
}

export async function updateEvidenceAttachment(
  id: number,
  changes: Partial<EvidenceAttachment>,
  options?: EvidenceWriteOptions
): Promise<void> {
  await getVaultRepository().update('evidenceAttachments', id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('evidenceAttachments');
  }
}

export async function deleteEvidenceAttachment(
  id: number,
  options?: EvidenceWriteOptions
): Promise<void> {
  await getVaultRepository().delete('evidenceAttachments', id);

  if (!options?.skipNotification) {
    notifyDbChange('evidenceAttachments');
  }
}

export async function clearEvidenceAttachments(
  options?: EvidenceWriteOptions
): Promise<void> {
  await getVaultRepository().clear('evidenceAttachments');

  if (!options?.skipNotification) {
    notifyDbChange('evidenceAttachments');
  }
}

export async function clearAllEvidenceData(
  options?: EvidenceWriteOptions
): Promise<void> {
  // Native multi-collection transaction support is not yet available. Do not
  // pretend this pair is atomic in packaged builds.
  await getVaultRepository().clear('evidence');
  await getVaultRepository().clear('evidenceAttachments');

  if (!options?.skipNotification) {
    notifyDbChange(['evidence', 'evidenceAttachments']);
  }
}

// =============================================================================
// READ HELPERS
// =============================================================================

export async function getAllEvidence(): Promise<Evidence[]> {
  return listVaultRows('evidence');
}

export async function getAllEvidenceAttachments(): Promise<EvidenceAttachment[]> {
  return listVaultRows('evidenceAttachments');
}

export async function getEvidenceAttachmentsByEvidenceId(
  evidenceId: number
): Promise<EvidenceAttachment[]> {
  return queryVaultRows<EvidenceAttachment>('evidenceAttachments', 'evidenceAttachments.byEvidenceId', evidenceId, 1000);
}

export async function countEvidenceAttachmentsByEvidenceId(
  evidenceId: number
): Promise<number> {
  return (await getEvidenceAttachmentsByEvidenceId(evidenceId)).length;
}

export async function countEvidenceAttachments(): Promise<number> {
  return getVaultRepository().count('evidenceAttachments');
}

// =============================================================================
// RESTORE (shared by the legacy and v3 inline backup paths)
// =============================================================================

export type EvidenceRestoreMode = 'merge' | 'replace';

// Stable identity for an evidence document. The evidence table has no unique
// index, so merge mode uses this to skip rows that already exist rather than
// appending a duplicate document. The NUL separator can never appear in any
// component, so distinct documents can never collide on the same key. Matches
// on title + documentType + originalDate (the user-meaningful identity of a
// document, surfaced in the Evidence/Vault UI).
export function evidenceIdentity(row: {
  title?: unknown;
  documentType?: unknown;
  originalDate?: unknown;
}): string {
  return `${row.title}\u0000${row.documentType}\u0000${row.originalDate}`;
}

/**
 * Restore evidence documents and their attachments. SINGLE source of truth
 * shared by BOTH the legacy (pre-v3) restore path and the v3 inline path so they
 * can never diverge.
 *
 * The backup `id` is always stripped — evidence rows receive FRESH autoincrement
 * ids on restore (clear() does NOT reset IndexedDB key generation), so each
 * backup evidence id is mapped to its new live id and the attachments'
 * `evidenceId` is remapped through that map. Without this, restoring an old
 * backup would orphan/mislink every evidence file.
 *
 * In MERGE mode, an evidence row whose identity (title + documentType +
 * originalDate) already exists is skipped: the table has no unique index, so
 * without this guard merging the same/overlapping backup more than once silently
 * accumulates redundant evidence documents. The skip-set is seeded from the rows
 * already in the table AND extended as rows are added, so an internally
 * duplicated backup can't re-add the same document within one merge either. Any
 * attachment whose `evidenceId` points at a skipped evidence row is skipped too,
 * so no orphaned attachment rows are appended.
 *
 * In REPLACE mode every row is added (the caller cleared the tables first),
 * which preserves the original append-only behaviour exactly.
 *
 * Returns the number of evidence rows and attachment rows actually written,
 * plus the fresh ids of exactly those rows so a cancelled merge can undo them.
 */
export async function restoreEvidenceRows(
  evidence: any[] | undefined,
  evidenceAttachments: any[] | undefined,
  restoreMode: EvidenceRestoreMode = 'replace'
): Promise<{
  evidenceAdded: number;
  evidenceAttachmentsAdded: number;
  insertedEvidenceIds: number[];
  insertedEvidenceAttachmentIds: number[];
  /**
   * Backup id -> live id for every evidence row this restore accounts for
   * (added rows map to their fresh id; merge-skipped duplicates map to the
   * already-present live row with the same identity). Other tables that
   * reference evidence ids (e.g. saved-PSBT notarization outputs) MUST remap
   * through this — clear() does not reset key generation, so restored ids
   * differ from the backup's.
   */
  evidenceIdMap: Map<number, number>;
  /** Backup attachment id -> live attachment id (same contract as above). */
  evidenceAttachmentIdMap: Map<number, number>;
}> {
  const now = Date.now();
  const evidenceIdMap = new Map<number, number>();
  const evidenceAttachmentIdMap = new Map<number, number>();
  // Backup evidence ids that were skipped as duplicates in merge mode, so their
  // attachments can be skipped too (no orphaned attachment rows).
  const skippedEvidenceIds = new Set<number>();

  const evidenceSource = Array.isArray(evidence) ? evidence : [];

  // In merge mode, seed the de-dup set with the identities already in the vault,
  // keeping the live rows so a skipped backup row can still be mapped onto the
  // existing document it duplicates (for reference remapping).
  const seen = new Set<string>();
  const existingByIdentity = new Map<string, Evidence>();
  if (restoreMode === 'merge') {
    for (const ev of await getAllEvidence()) {
      seen.add(evidenceIdentity(ev));
      existingByIdentity.set(evidenceIdentity(ev), ev);
    }
  }

  // Build the list of rows to add (after merge de-dup), keeping the source rows
  // parallel so the new ids can be mapped back to backup ids for attachments.
  const toAddSource: any[] = [];
  const toAddRows: Evidence[] = [];
  for (const ev of evidenceSource) {
    if (restoreMode === 'merge') {
      const key = evidenceIdentity(ev);
      if (seen.has(key)) {
        if (typeof ev.id === 'number') {
          skippedEvidenceIds.add(ev.id);
          const existing = existingByIdentity.get(key);
          if (existing?.id !== undefined) evidenceIdMap.set(ev.id, existing.id);
        }
        continue;
      }
      seen.add(key);
    }
    const { id, ...d } = ev;
    toAddSource.push(ev);
    toAddRows.push({
      title: d.title || 'Restored Evidence',
      documentType: d.documentType || 'other',
      originalDate: d.originalDate,
      notes: d.notes,
      tags: d.tags || [],
      partiesInvolved: d.partiesInvolved || [],
      source: d.source,
      importance: d.importance,
      createdAt: d.createdAt || now,
      updatedAt: d.updatedAt || now,
    } as Evidence);
  }

  let evidenceAdded = 0;
  const insertedEvidenceIds: number[] = [];
  if (toAddRows.length > 0) {
    const newIds = await bulkAddEvidence(toAddRows, { skipNotification: true });
    insertedEvidenceIds.push(...newIds);
    toAddSource.forEach((ev, i) => {
      if (typeof ev.id === 'number' && typeof newIds[i] === 'number') {
        evidenceIdMap.set(ev.id, newIds[i]);
      }
    });
    evidenceAdded = newIds.length;
  }

  let evidenceAttachmentsAdded = 0;
  const insertedEvidenceAttachmentIds: number[] = [];
  const attachmentSource = Array.isArray(evidenceAttachments) ? evidenceAttachments : [];
  // Cache of live attachments per (already-existing) evidence id, used to map
  // skipped backup attachments onto their live counterparts by filename.
  const liveAttachmentsByEvidence = new Map<number, EvidenceAttachment[]>();
  for (const ea of attachmentSource) {
    const { id, ...d } = ea;
    // Skip attachments belonging to an evidence row that was de-duped away, so
    // no orphaned attachment is appended for a document we didn't add. The
    // backup attachment id is still mapped onto the live attachment with the
    // same filename under the duplicate document, so references pointing at it
    // (e.g. saved-PSBT notarization outputs) can be remapped.
    if (typeof d.evidenceId === 'number' && skippedEvidenceIds.has(d.evidenceId)) {
      const liveEvidenceId = evidenceIdMap.get(d.evidenceId);
      if (liveEvidenceId !== undefined && typeof id === 'number') {
        let liveAtts = liveAttachmentsByEvidence.get(liveEvidenceId);
        if (!liveAtts) {
          liveAtts = await getEvidenceAttachmentsByEvidenceId(liveEvidenceId);
          liveAttachmentsByEvidence.set(liveEvidenceId, liveAtts);
        }
        const match = liveAtts.find((a) => a.filename === (d.filename || 'unknown'));
        if (match?.id !== undefined) evidenceAttachmentIdMap.set(id, match.id);
      }
      continue;
    }
    const mappedEvidenceId =
      typeof d.evidenceId === 'number'
        ? evidenceIdMap.get(d.evidenceId) ?? d.evidenceId
        : d.evidenceId;
    const newAttachmentId = await addEvidenceAttachment(
      {
        evidenceId: mappedEvidenceId,
        filename: d.filename || 'unknown',
        mimeType: d.mimeType || 'application/octet-stream',
        size: d.size || 0,
        objectStoragePath: d.objectStoragePath || '',
        createdAt: d.createdAt || now,
      },
      { skipNotification: true }
    );
    insertedEvidenceAttachmentIds.push(newAttachmentId);
    if (typeof id === 'number') evidenceAttachmentIdMap.set(id, newAttachmentId);
    evidenceAttachmentsAdded++;
  }

  return {
    evidenceAdded,
    evidenceAttachmentsAdded,
    insertedEvidenceIds,
    insertedEvidenceAttachmentIds,
    evidenceIdMap,
    evidenceAttachmentIdMap,
  };
}
