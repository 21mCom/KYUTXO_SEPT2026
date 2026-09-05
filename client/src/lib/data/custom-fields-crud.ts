import { notifyDbChange, type CustomField } from '../database';
import { getVaultRepository } from '../repository';

const PAGE_SIZE = 500;

async function listCustomFields(): Promise<CustomField[]> {
  const repository = getVaultRepository();
  const rows: CustomField[] = [];
  let cursor: string | number | undefined;
  do {
    const page = await repository.list('customFields', { cursor, limit: PAGE_SIZE });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

export type CreateCustomFieldData = Omit<CustomField, 'id' | 'createdAt'> & {
  createdAt?: number;
};

export interface CustomFieldWriteOptions {
  skipNotification?: boolean;
}

export async function addCustomField(
  data: CreateCustomFieldData,
  options?: CustomFieldWriteOptions
): Promise<number> {
  const field: CustomField = {
    ...data,
    createdAt: data.createdAt ?? Date.now(),
  };

  const id = await getVaultRepository().add('customFields', field);

  if (!options?.skipNotification) {
    notifyDbChange('customFields');
  }

  return id as number;
}

export async function updateCustomField(
  id: number,
  changes: Partial<CustomField>,
  options?: CustomFieldWriteOptions
): Promise<void> {
  await getVaultRepository().update('customFields', id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('customFields');
  }
}

export async function deleteCustomField(
  id: number,
  options?: CustomFieldWriteOptions
): Promise<void> {
  await getVaultRepository().delete('customFields', id);

  if (!options?.skipNotification) {
    notifyDbChange('customFields');
  }
}

export async function clearCustomFields(
  options?: CustomFieldWriteOptions
): Promise<void> {
  await getVaultRepository().clear('customFields');

  if (!options?.skipNotification) {
    notifyDbChange('customFields');
  }
}

export async function getCustomField(id: number): Promise<CustomField | undefined> {
  return getVaultRepository().get('customFields', id);
}

export async function getCustomFieldBySlug(slug: string): Promise<CustomField | undefined> {
  // `slug` lookup is a bounded keyset scan on the shared repository contract.
  // The protected worker should provide a `customFields.bySlug` native query
  // before vaults with very large custom-field sets are supported.
  return (await listCustomFields()).find((field) => field.slug === slug);
}

export async function getAllCustomFields(): Promise<CustomField[]> {
  return listCustomFields();
}
