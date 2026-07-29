import { db, notifyDbChange, type DerivationTemplate } from '../database';

export type CreateDerivationTemplateData = Omit<DerivationTemplate, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt?: number;
  updatedAt?: number;
};

export interface DerivationTemplateWriteOptions {
  skipNotification?: boolean;
}

export async function addDerivationTemplate(
  data: CreateDerivationTemplateData,
  options?: DerivationTemplateWriteOptions
): Promise<number> {
  const now = Date.now();
  const template: DerivationTemplate = {
    ...data,
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
  };

  const id = await db.derivationTemplates.add(template);

  if (!options?.skipNotification) {
    notifyDbChange('derivationTemplates');
  }

  return id as number;
}

export async function deleteDerivationTemplate(
  id: number,
  options?: DerivationTemplateWriteOptions
): Promise<void> {
  await db.derivationTemplates.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('derivationTemplates');
  }
}

export async function clearDerivationTemplates(
  options?: DerivationTemplateWriteOptions
): Promise<void> {
  await db.derivationTemplates.clear();

  if (!options?.skipNotification) {
    notifyDbChange('derivationTemplates');
  }
}

export async function getAllDerivationTemplates(): Promise<DerivationTemplate[]> {
  return db.derivationTemplates.toArray();
}

export async function countDerivationTemplates(): Promise<number> {
  return db.derivationTemplates.count();
}
