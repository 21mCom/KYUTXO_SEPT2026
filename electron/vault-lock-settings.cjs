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

function applyIdleLockTimeoutOverride(settings, rawValue) {
  if (rawValue === undefined || rawValue === '') return settings;
  return {
    ...settings,
    idleTimeoutSeconds: parseIdleLockTimeoutEnv(rawValue),
  };
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

function createVaultLockLifecycle({
  powerMonitor,
  lockRenderer,
  logError = () => {},
  pollMs = 5000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logPowerEvent = () => {},
}) {
  let policy = null;
  let idleLockTimer = null;
  let idleLockSent = false;
  let powerMonitorListeners = null;

  function clearIdleLockTimer() {
    if (idleLockTimer) {
      clearIntervalFn(idleLockTimer);
      idleLockTimer = null;
    }
  }

  function applyPolicy(nextPolicy) {
    policy = nextPolicy;
    clearIdleLockTimer();
    idleLockSent = false;

    if (
      policy.idleTimeoutSeconds <= 0 ||
      typeof powerMonitor.getSystemIdleTime !== 'function'
    ) {
      return;
    }

    idleLockTimer = setIntervalFn(() => {
      let idleSeconds;
      try {
        idleSeconds = powerMonitor.getSystemIdleTime();
      } catch (error) {
        logError(error);
        return;
      }

      const isIdle = idleSeconds >= policy.idleTimeoutSeconds;
      if (isIdle && !idleLockSent) {
        idleLockSent = true;
        lockRenderer('idle');
      } else if (!isIdle) {
        idleLockSent = false;
      }
    }, pollMs);
    idleLockTimer.unref?.();
  }

  function shouldLock(eventName) {
    const settingByEvent = {
      suspend: 'lockOnSuspend',
      resume: 'lockOnResume',
      'lock-screen': 'lockOnScreenLock',
    };
    const setting = settingByEvent[eventName];
    return setting ? policy?.[setting] === true : false;
  }

  function registerPowerMonitorListeners() {
    if (powerMonitorListeners || typeof powerMonitor?.on !== 'function') return;

    const events = ['suspend', 'resume', 'lock-screen'];
    powerMonitorListeners = new Map();
    for (const eventName of events) {
      const listener = () => {
        logPowerEvent(eventName);
        if (shouldLock(eventName)) lockRenderer(eventName);
      };
      powerMonitorListeners.set(eventName, listener);
      powerMonitor.on(eventName, listener);
    }
  }

  function shutdown() {
    clearIdleLockTimer();
    idleLockSent = false;
    policy = null;
    if (powerMonitorListeners && typeof powerMonitor?.removeListener === 'function') {
      for (const [eventName, listener] of powerMonitorListeners) {
        powerMonitor.removeListener(eventName, listener);
      }
    }
    powerMonitorListeners = null;
  }

  return {
    applyPolicy,
    registerPowerMonitorListeners,
    shouldLock,
    shutdown,
  };
}

module.exports = {
  DEFAULT_IDLE_LOCK_TIMEOUT_SECONDS,
  applyIdleLockTimeoutOverride,
  parseIdleLockTimeoutEnv,
  validateVaultLockSettings,
  createVaultLockLifecycle,
};