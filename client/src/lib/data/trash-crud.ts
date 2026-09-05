import { notifyDbChange, type Attachment, type TrashedAttachment } from '../database';
import { getVaultRepository } from '../repository';
import { listVaultRows } from './repository-helpers';

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

  await getVaultRepository().bulkPut('trashedAttachments', rows);

  if (!options?.skipNotification) {
    notifyDbChange('trashedAttachments');
  }
}

export async function getTrashedAttachments(): Promise<TrashedAttachment[]> {
  return (await listVaultRows('trashedAttachments')).sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function getTrashedAttachment(id: number): Promise<TrashedAttachment | undefined> {
  return getVaultRepository().get('trashedAttachments', id);
}

export async function deleteTrashedAttachment(
  id: number,
  options?: TrashWriteOptions,
): Promise<void> {
  await getVaultRepository().delete('trashedAttachments', id);

  if (!options?.skipNotification) {
    notifyDbChange('trashedAttachments');
  }
}

export async function clearTrashedAttachments(options?: TrashWriteOptions): Promise<void> {
  await getVaultRepository().clear('trashedAttachments');

  if (!options?.skipNotification) {
    notifyDbChange('trashedAttachments');
  }
}

export async function countTrashedAttachments(): Promise<number> {
  return getVaultRepository().count('trashedAttachments');
}
