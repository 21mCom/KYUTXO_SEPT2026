'use strict';

const DEFAULT_IDLE_LOCK_TIMEOUT_SECONDS = 300;
const SUPPORTED_IDLE_LOCK_TIMEOUT_SECONDS = new Set([0, 60, 300, 900, 1800, 3600]);

function parseIdleLockTimeoutEnv(rawValue) {
  if (rawValue === undefined || rawValue === '') return DEFAULT_IDLE_LOCK_TIMEOUT_SECONDS;
  const parsed = Number(rawValue);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > 24 * 60 * 60
  ) {
    return DEFAULT_IDLE_LOCK_TIMEOUT_SECONDS;
  }
  return parsed;
}

function validateVaultLockSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    return { ok: false, error: 'Vault lock settings must be an object' };
  }

  const { idleTimeoutSeconds, lockOnSuspend, lockOnResume, lockOnScreenLock } = rawSettings;
  if (!SUPPORTED_IDLE_LOCK_TIMEOUT_SECONDS.has(idleTimeoutSeconds)) {
    return { ok: false, error: 'Idle timeout is not a supported choice' };
  }
  if (
    typeof lockOnSuspend !== 'boolean' ||
    typeof lockOnResume !== 'boolean' ||
    typeof lockOnScreenLock !== 'boolean'
  ) {
    return { ok: false, error: 'Lifecycle lock settings must be boolean values' };
  }

  return {
    ok: true,
    settings: {
      idleTimeoutSeconds,
      lockOnSuspend,
      lockOnResume,
      lockOnScreenLock,
    },
  };
}

module.exports = {
  DEFAULT_IDLE_LOCK_TIMEOUT_SECONDS,
  parseIdleLockTimeoutEnv,
  validateVaultLockSettings,
};