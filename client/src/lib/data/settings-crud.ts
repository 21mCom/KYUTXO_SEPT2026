import { db, notifyDbChange, type Settings } from '../database';

export interface SettingsWriteOptions {
  skipNotification?: boolean;
}

export async function getSettings(id: string = 'default'): Promise<Settings | undefined> {
  return db.settings.get(id);
}

export async function getAllSettings(): Promise<Settings[]> {
  return db.settings.toArray();
}

export async function addSettings(
  data: Settings,
  options?: SettingsWriteOptions
): Promise<string> {
  const id = await db.settings.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }

  return id as string;
}

export async function putSettings(
  data: Settings,
  options?: SettingsWriteOptions
): Promise<void> {
  await db.settings.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }
}

export async function updateSettings(
  id: string,
  changes: Partial<Settings>,
  options?: SettingsWriteOptions
): Promise<void> {
  await db.settings.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }
}
