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

export async function getAttachmentsByRecordIdOrIdentifier(
  recordId: number,
  identifier: string
): Promise<Attachment[]> {
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

export async function countAttachments(): Promise<number> {
  return db.attachments.count();
}
