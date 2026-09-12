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
import { getVaultRepository } from '../repository';

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
  const repository = getVaultRepository();
  return repository.kind === 'protected'
    ? repository.get('settings', id)
    : db.settings.get(id);
}

// Return the settings row, creating a canonical default row first if it is
// missing. Use this in mutators so a settings change never silently no-ops just
// because the 'default' row hasn't been initialized (e.g. mid-restore). `put` is
// idempotent, so a concurrent creator simply overwrites with the same defaults.
export async function ensureSettings(
  id: string = 'default',
  options?: SettingsWriteOptions
): Promise<Settings> {
  const existing = await getSettings(id);
  if (existing) return existing;

  const created = createDefaultSettings(id);
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.put('settings', created);
  else await db.settings.put(created);

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }

  return created;
}

export async function getAllSettings(): Promise<Settings[]> {
  const repository = getVaultRepository();
  if (repository.kind !== 'protected') return db.settings.toArray();
  const rows: Settings[] = [];
  let cursor: string | number | undefined;
  do {
    const page = await repository.list('settings', { cursor, limit: 1000 });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

export async function addSettings(
  data: Settings,
  options?: SettingsWriteOptions
): Promise<string> {
  const repository = getVaultRepository();
  const id = repository.kind === 'protected'
    ? await repository.add('settings', data)
    : await db.settings.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }

  return id as string;
}

export async function putSettings(
  data: Settings,
  options?: SettingsWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.put('settings', data);
  else await db.settings.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('settings');
  }
}

export async function updateSettings(
  id: string,
  changes: Partial<Settings>,
  options?: SettingsWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.update('settings', id, changes);
  else await db.settings.update(id, changes);

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
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    const current = await repository.get('settings', id);
    if (current) {
      const changes = mutate(current);
      if (changes) {
        await repository.put('settings', { ...current, ...changes }, id);
        updated = { ...current, ...changes };
      }
    }
  } else await db.transaction('rw', db.settings, async () => {
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
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.clear('settings');
  else await db.settings.clear();

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
