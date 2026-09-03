import {
  DEFAULT_DESKTOP_LOCK_SETTINGS,
  DESKTOP_LOCK_TIMEOUT_OPTIONS,
  type DesktopLockSettings,
  type DesktopLockTimeoutSeconds,
} from './db-types';

export { DEFAULT_DESKTOP_LOCK_SETTINGS, DESKTOP_LOCK_TIMEOUT_OPTIONS };
export type { DesktopLockSettings, DesktopLockTimeoutSeconds };

/** Return a safe, UI-supported policy for an older or malformed settings row. */
export function normalizeDesktopLockSettings(value: unknown): DesktopLockSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_DESKTOP_LOCK_SETTINGS };
  }

  const candidate = value as Partial<DesktopLockSettings>;
  const idleTimeoutSeconds = DESKTOP_LOCK_TIMEOUT_OPTIONS.includes(
    candidate.idleTimeoutSeconds as DesktopLockTimeoutSeconds,
  )
    ? candidate.idleTimeoutSeconds as DesktopLockTimeoutSeconds
    : DEFAULT_DESKTOP_LOCK_SETTINGS.idleTimeoutSeconds;

  return {
    idleTimeoutSeconds,
    lockOnSuspend:
      typeof candidate.lockOnSuspend === 'boolean'
        ? candidate.lockOnSuspend
        : DEFAULT_DESKTOP_LOCK_SETTINGS.lockOnSuspend,
    lockOnResume:
      typeof candidate.lockOnResume === 'boolean'
        ? candidate.lockOnResume
        : DEFAULT_DESKTOP_LOCK_SETTINGS.lockOnResume,
    lockOnScreenLock:
      typeof candidate.lockOnScreenLock === 'boolean'
        ? candidate.lockOnScreenLock
        : DEFAULT_DESKTOP_LOCK_SETTINGS.lockOnScreenLock,
  };
}

/** Remove installation-specific security policy before settings enter a backup. */
export function stripDesktopLockSettingsFromBackupRows<T extends object>(
  rows: T[],
): T[] {
  return rows.map((row) => {
    const copy = { ...row } as T & { desktopLockSettings?: unknown };
    delete copy.desktopLockSettings;
    return copy;
  });
}