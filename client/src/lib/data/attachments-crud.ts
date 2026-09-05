import { notifyDbChange, type Attachment } from '../database';
import { getVaultRepository } from '../repository';
import { listVaultRows, queryVaultRows } from './repository-helpers';

export type CreateAttachmentData = Omit<Attachment, 'id' | 'createdAt'> & {
  createdAt?: number;
};

export interface AttachmentWriteOptions {
  skipNotification?: boolean;
}

export async function addAttachment(
  data: CreateAttachmentData,
  options?: AttachmentWriteOptions
): Promise<number> {
  const attachment: Attachment = {
    ...data,
    createdAt: data.createdAt ?? Date.now(),
  };

  const id = await getVaultRepository().add('attachments', attachment);

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }

  return id as number;
}

// Batched attachment insert. Used by the large-scale vault generator so it can
// create many attachment rows through the CRUD layer (no direct table writes)
// without holding the whole dataset in memory.
export async function bulkAddAttachments(
  attachments: CreateAttachmentData[],
  options?: AttachmentWriteOptions
): Promise<number[]> {
  if (attachments.length === 0) return [];

  const now = Date.now();
  const rows: Attachment[] = attachments.map((a) => ({
    ...a,
    createdAt: a.createdAt ?? now,
  }));

  const ids = await getVaultRepository().bulkPut('attachments', rows);

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }

  return ids as number[];
}

export async function updateAttachment(
  id: number,
  changes: Partial<Attachment>,
  options?: AttachmentWriteOptions
): Promise<void> {
  await getVaultRepository().update('attachments', id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

export async function deleteAttachment(
  id: number,
  options?: AttachmentWriteOptions
): Promise<void> {
  await getVaultRepository().delete('attachments', id);

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

// Bulk delete by primary key. Used by the merge-cancel undo pass in the v3
// restore to remove exactly the attachment rows that merge inserted.
export async function bulkDeleteAttachments(
  ids: number[],
  options?: AttachmentWriteOptions
): Promise<void> {
  if (ids.length === 0) return;

  await getVaultRepository().bulkDelete('attachments', ids);

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

export async function deleteAttachmentsByRecordId(
  recordId: number,
  options?: AttachmentWriteOptions
): Promise<void> {
  const ids = (await getAttachmentsByRecordId(recordId)).flatMap((row) => row.id === undefined ? [] : [row.id]);
  await getVaultRepository().bulkDelete('attachments', ids);

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

export async function clearAttachments(
  options?: AttachmentWriteOptions
): Promise<void> {
  await getVaultRepository().clear('attachments');

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

export async function getAttachment(id: number): Promise<Attachment | undefined> {
  return getVaultRepository().get('attachments', id);
}

export async function getAttachmentsByRecordId(recordId: number): Promise<Attachment[]> {
  return queryVaultRows<Attachment>('attachments', 'attachments.byRecordId', recordId, 1000);
}

// Count how many attachment files belong to the given records. Used to warn the
// user how many files a bulk record deletion will affect.
export async function countAttachmentsByRecordIds(recordIds: number[]): Promise<number> {
  if (recordIds.length === 0) return 0;
  const rows = await Promise.all(recordIds.map((id) => getAttachmentsByRecordId(id)));
  return rows.reduce((count, attachments) => count + attachments.length, 0);
}

export async function getAttachmentsByRecordIdOrIdentifier(
  recordId: number,
  identifier: string
): Promise<Attachment[]> {
  // Blank identifiers must not match rows that legitimately stored "" (or be
  // wasted work) — only branch on identifier when one is provided.
  if (!identifier) {
    return getAttachmentsByRecordId(recordId);
  }
  const [byRecord, byIdentifier] = await Promise.all([
    getAttachmentsByRecordId(recordId),
    queryVaultRows<Attachment>('attachments', 'attachments.byIdentifier', identifier, 1000),
  ]);
  const seen = new Set<number>();
  return [...byRecord, ...byIdentifier].filter((row) => row.id === undefined || !seen.has(row.id) && (seen.add(row.id), true));
}

export async function getAllAttachments(): Promise<Attachment[]> {
  return listVaultRows('attachments');
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// attachment-metadata table is never materialised at once.
export async function getAttachmentsAfterId(
  afterId: number,
  limit: number
): Promise<Attachment[]> {
  return (await getVaultRepository().list('attachments', { cursor: afterId, limit })).rows;
}

export async function countAttachments(): Promise<number> {
  return getVaultRepository().count('attachments');
}

// Sum the byte sizes of every attachment file (from each row's `size`). Used by
// the backup export to record the exact total attachment bytes in the manifest,
// so the restore pre-flight can estimate required disk space precisely instead
// of falling back to the (compression-inflated) backup file size. Iterates with
// a cursor so the whole table is never materialised at once.
export async function sumAttachmentSizes(): Promise<number> {
  let total = 0;
  for (const a of await listVaultRows('attachments')) {
    if (typeof a.size === 'number' && Number.isFinite(a.size) && a.size > 0) {
      total += a.size;
    }
  }
  return total;
}
