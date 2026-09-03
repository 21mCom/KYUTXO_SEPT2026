import {
  db,
  notifyDbChange,
  createDefaultSettings,
  type Settings,
} from '../database';
import {
  normalizeDesktopLockSettings,
  type DesktopLockSettings,
} from '../desktop-lock-settings';
import { getElectronAPISafe } from '../electron';

export interface SettingsWriteOptions {
  skipNotification?: boolean;
}

let desktopLockOperation: Promise<void> = Promise.resolve();

function enqueueDesktopLockOperation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = desktopLockOperation.then(operation, operation);
  desktopLockOperation = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
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

export async function mutateSettings(
  id: string,
  mutate: (current: Settings) => Partial<Settings> | undefined,
  options?: SettingsWriteOptions
): Promise<Settings | undefined> {
  let updated: Settings | undefined;
  await db.transaction('rw', db.settings, async () => {
    const current = await db.settings.get(id);
    if (!current) return;
    const changes = mutate(current);
    if (!changes) return;
    await db.settings.update(id, changes);
    updated = { ...current, ...changes };
  });

  if (updated && !options?.skipNotification) {
    notifyDbChange('settings');
  }
  return updated;
}
export async function clearSettings(
  options?: SettingsWriteOptions
): Promise<void> {
  await db.settings.clear();

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }
}

/**
 * Push the persisted desktop-only policy into Electron's main process.
 *
 * The main process remains the authority for lifecycle events; the renderer
 * only supplies this narrow, validated policy. Missing policies are left alone
 * so deployment environment defaults remain effective on first launch.
 */
export async function syncDesktopLockSettings(): Promise<void> {
  return enqueueDesktopLockOperation(async () => {
    const api = getElectronAPISafe();
    if (!api?.setVaultLockSettings) return;

    // Read inside the queue so a save that ran first can never be overwritten
    // by a startup sync carrying a stale pre-save snapshot.
    const stored = await getSettings('default');
    if (!stored?.desktopLockSettings) return;

    const normalized = normalizeDesktopLockSettings(stored.desktopLockSettings);
    const result = await api.setVaultLockSettings(normalized);
    if (!result.success) {
      throw new Error(result.error || 'The desktop vault lock policy was rejected');
    }
  });
}

/**
 * Apply and persist a desktop lock policy. Applying through the main process
 * first means an invalid value can never be committed as if it were active.
 */
export async function updateDesktopLockSettings(
  settings: DesktopLockSettings,
): Promise<void> {
  return enqueueDesktopLockOperation(async () => {
    const normalized = normalizeDesktopLockSettings(settings);
    const api = getElectronAPISafe();
    const stored = await ensureSettings('default');
    const previousSettings = stored.desktopLockSettings;

    await updateSettings('default', { desktopLockSettings: normalized });
    if (!api?.setVaultLockSettings) return;

    // Persist first so a quota/transaction failure cannot weaken the active
    // main-process policy. If Electron rejects the value, restore the prior row.
    try {
      const result = await api.setVaultLockSettings(normalized);
      if (!result.success) {
        throw new Error(result.error || 'The desktop vault lock policy was rejected');
      }
    } catch (error) {
      try {
        await updateSettings('default', { desktopLockSettings: previousSettings });
      } catch (rollbackError) {
        throw new Error(
          'The desktop vault lock policy was rejected and its saved setting could not be restored',
          { cause: rollbackError },
        );
      }
      throw error;
    }
  });
}
