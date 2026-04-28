import { db, notifyDbChange, type Evidence, type EvidenceAttachment } from '../database';

export type CreateEvidenceData = Omit<Evidence, 'id' | 'createdAt' | 'updatedAt'>;
export type CreateEvidenceAttachmentData = Omit<EvidenceAttachment, 'id' | 'createdAt'>;

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

  const id = await db.evidence.add(evidence);

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }

  return id as number;
}

export async function bulkAddEvidence(
  records: Evidence[],
  options?: EvidenceWriteOptions
): Promise<void> {
  if (records.length === 0) return;

  await db.evidence.bulkAdd(records);

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }
}

export async function putEvidence(
  data: Evidence,
  options?: EvidenceWriteOptions
): Promise<void> {
  await db.evidence.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }
}

export async function updateEvidence(
  id: number,
  changes: Partial<Evidence>,
  options?: EvidenceWriteOptions
): Promise<void> {
  const existing = await db.evidence.get(id);
  if (!existing) throw new Error('Evidence not found');

  const updated: Evidence = {
    ...existing,
    ...changes,
    id,
    updatedAt: Date.now(),
  };

  await db.evidence.put(updated);

  if (!options?.skipNotification) {
    notifyDbChange('evidence');
  }
}

export async function deleteEvidence(
  id: number,
  options?: EvidenceWriteOptions
): Promise<void> {
  const attachments = await db.evidenceAttachments.where('evidenceId').equals(id).toArray();

  for (const attachment of attachments) {
    if (attachment.id) {
      await db.evidenceAttachments.delete(attachment.id);
    }
  }

  await db.evidence.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange(['evidence', 'evidenceAttachments']);
  }
}

export async function clearEvidence(
  options?: EvidenceWriteOptions
): Promise<void> {
  await db.evidence.clear();

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
    createdAt: Date.now(),
  };

  const id = await db.evidenceAttachments.add(attachment);

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
  await db.evidenceAttachments.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('evidenceAttachments');
  }
}

export async function deleteEvidenceAttachment(
  id: number,
  options?: EvidenceWriteOptions
): Promise<void> {
  await db.evidenceAttachments.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('evidenceAttachments');
  }
}

export async function clearEvidenceAttachments(
  options?: EvidenceWriteOptions
): Promise<void> {
  await db.evidenceAttachments.clear();

  if (!options?.skipNotification) {
    notifyDbChange('evidenceAttachments');
  }
}

export async function clearAllEvidenceData(
  options?: EvidenceWriteOptions
): Promise<void> {
  await db.evidence.clear();
  await db.evidenceAttachments.clear();

  if (!options?.skipNotification) {
    notifyDbChange(['evidence', 'evidenceAttachments']);
  }
}
