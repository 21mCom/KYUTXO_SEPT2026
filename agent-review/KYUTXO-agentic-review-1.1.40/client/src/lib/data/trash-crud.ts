import { db, notifyDbChange, type Attachment, type TrashedAttachment } from '../database';

export interface TrashWriteOptions {
  skipNotification?: boolean;
}

// Archive attachment metadata before its database row is deleted. The file bytes
// themselves are intentionally LEFT ON DISK by the caller — this module only
// copies metadata so a deleted attachment stays recoverable (download or
// permanent purge from Settings). Binary-safe: no file is ever read, moved, or
// transformed here, so the original extension/filename/mimeType are preserved.
export async function archiveAttachments(
  attachments: Attachment[],
  source: TrashedAttachment['source'],
  options?: TrashWriteOptions,
): Promise<void> {
  if (attachments.length === 0) return;

  const deletedAt = Date.now();
  const rows: TrashedAttachment[] = attachments.map((a) => ({
    recordId: a.recordId,
    identifier: (a as Attachment & { identifier?: string }).identifier,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    objectStoragePath: a.objectStoragePath,
    deletedAt,
    source,
  }));

  await db.trashedAttachments.bulkAdd(rows);

  if (!options?.skipNotification) {
    notifyDbChange('trashedAttachments');
  }
}

export async function getTrashedAttachments(): Promise<TrashedAttachment[]> {
  return db.trashedAttachments.orderBy('deletedAt').reverse().toArray();
}

export async function getTrashedAttachment(id: number): Promise<TrashedAttachment | undefined> {
  return db.trashedAttachments.get(id);
}

export async function deleteTrashedAttachment(
  id: number,
  options?: TrashWriteOptions,
): Promise<void> {
  await db.trashedAttachments.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('trashedAttachments');
  }
}

export async function clearTrashedAttachments(options?: TrashWriteOptions): Promise<void> {
  await db.trashedAttachments.clear();

  if (!options?.skipNotification) {
    notifyDbChange('trashedAttachments');
  }
}

export async function countTrashedAttachments(): Promise<number> {
  return db.trashedAttachments.count();
}
