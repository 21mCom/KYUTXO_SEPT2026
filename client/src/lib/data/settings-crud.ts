import { db, notifyDbChange, createDefaultSettings, type Settings } from '../database';

export interface SettingsWriteOptions {
  skipNotification?: boolean;
}

export async function getSettings(id: string = 'default'): Promise<Settings | undefined> {
  return db.settings.get(id);
}

// Return the settings row, creating a canonical default row first if it is
// missing. Use this in mutators so a settings change never silently no-ops just
// because the 'default' row hasn't been initialized (e.g. mid-restore). `put` is
// idempotent, so a concurrent creator simply overwrites with the same defaults.
export async function ensureSettings(
  id: string = 'default',
  options?: SettingsWriteOptions
): Promise<Settings> {
  const existing = await db.settings.get(id);
  if (existing) return existing;

  const created = createDefaultSettings(id);
  await db.settings.put(created);

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }

  return created;
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

export async function clearSettings(
  options?: SettingsWriteOptions
): Promise<void> {
  await db.settings.clear();

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }
}
