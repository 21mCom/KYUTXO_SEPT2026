import { db, notifyDbChange, type Attachment } from '../database';

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

  const id = await db.attachments.add(attachment);

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

  const ids = await db.transaction('rw', db.attachments, async () => {
    return await db.attachments.bulkAdd(rows, { allKeys: true });
  });

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
  await db.attachments.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

export async function deleteAttachment(
  id: number,
  options?: AttachmentWriteOptions
): Promise<void> {
  await db.attachments.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

export async function deleteAttachmentsByRecordId(
  recordId: number,
  options?: AttachmentWriteOptions
): Promise<void> {
  await db.attachments.where('recordId').equals(recordId).delete();

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

export async function clearAttachments(
  options?: AttachmentWriteOptions
): Promise<void> {
  await db.attachments.clear();

  if (!options?.skipNotification) {
    notifyDbChange('attachments');
  }
}

export async function getAttachment(id: number): Promise<Attachment | undefined> {
  return db.attachments.get(id);
}

export async function getAttachmentsByRecordId(recordId: number): Promise<Attachment[]> {
  return db.attachments.where('recordId').equals(recordId).toArray();
}

// Count how many attachment files belong to the given records. Used to warn the
// user how many files a bulk record deletion will affect.
export async function countAttachmentsByRecordIds(recordIds: number[]): Promise<number> {
  if (recordIds.length === 0) return 0;
  return db.attachments.where('recordId').anyOf(recordIds).count();
}

export async function getAttachmentsByRecordIdOrIdentifier(
  recordId: number,
  identifier: string
): Promise<Attachment[]> {
  // Blank identifiers must not match rows that legitimately stored "" (or be
  // wasted work) — only branch on identifier when one is provided.
  if (!identifier) {
    return db.attachments.where('recordId').equals(recordId).toArray();
  }
  return db.attachments
    .where('recordId')
    .equals(recordId)
    .or('identifier')
    .equals(identifier)
    .toArray();
}

export async function getAllAttachments(): Promise<Attachment[]> {
  return db.attachments.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// attachment-metadata table is never materialised at once.
export async function getAttachmentsAfterId(
  afterId: number,
  limit: number
): Promise<Attachment[]> {
  return db.attachments.where('id').above(afterId).limit(limit).toArray();
}

export async function countAttachments(): Promise<number> {
  return db.attachments.count();
}

// Sum the byte sizes of every attachment file (from each row's `size`). Used by
// the backup export to record the exact total attachment bytes in the manifest,
// so the restore pre-flight can estimate required disk space precisely instead
// of falling back to the (compression-inflated) backup file size. Iterates with
// a cursor so the whole table is never materialised at once.
export async function sumAttachmentSizes(): Promise<number> {
  let total = 0;
  await db.attachments.each((a) => {
    if (typeof a.size === 'number' && Number.isFinite(a.size) && a.size > 0) {
      total += a.size;
    }
  });
  return total;
}
