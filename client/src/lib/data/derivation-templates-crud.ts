import { notifyDbChange, type DerivationTemplate } from '../database';
import { getVaultRepository } from '../repository';
import { listVaultRows } from './repository-helpers';

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

  const id = await getVaultRepository().add('derivationTemplates', template);

  if (!options?.skipNotification) {
    notifyDbChange('derivationTemplates');
  }

  return id as number;
}

export async function deleteDerivationTemplate(
  id: number,
  options?: DerivationTemplateWriteOptions
): Promise<void> {
  await getVaultRepository().delete('derivationTemplates', id);

  if (!options?.skipNotification) {
    notifyDbChange('derivationTemplates');
  }
}

export async function clearDerivationTemplates(
  options?: DerivationTemplateWriteOptions
): Promise<void> {
  await getVaultRepository().clear('derivationTemplates');

  if (!options?.skipNotification) {
    notifyDbChange('derivationTemplates');
  }
}

export async function getAllDerivationTemplates(): Promise<DerivationTemplate[]> {
  return listVaultRows('derivationTemplates');
}

export async function countDerivationTemplates(): Promise<number> {
  return getVaultRepository().count('derivationTemplates');
}
