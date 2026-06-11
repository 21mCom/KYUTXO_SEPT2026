import { db, notifyDbChange, type CustomField } from '../database';

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

  const id = await db.customFields.add(field);

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
  await db.customFields.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('customFields');
  }
}

export async function deleteCustomField(
  id: number,
  options?: CustomFieldWriteOptions
): Promise<void> {
  await db.customFields.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('customFields');
  }
}

export async function clearCustomFields(
  options?: CustomFieldWriteOptions
): Promise<void> {
  await db.customFields.clear();

  if (!options?.skipNotification) {
    notifyDbChange('customFields');
  }
}

export async function getCustomField(id: number): Promise<CustomField | undefined> {
  return db.customFields.get(id);
}

export async function getCustomFieldBySlug(slug: string): Promise<CustomField | undefined> {
  return db.customFields.where('slug').equals(slug).first();
}

export async function getAllCustomFields(): Promise<CustomField[]> {
  return db.customFields.toArray();
}
