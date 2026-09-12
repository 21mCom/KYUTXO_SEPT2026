import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  parseIdleLockTimeoutEnv,
  validateVaultLockSettings,
  createVaultLockLifecycle,
} = require("./vault-lock-settings.cjs") as {
  parseIdleLockTimeoutEnv: (value: string | undefined) => number;
  validateVaultLockSettings: (value: unknown) =>
    | { ok: true; settings: Record<string, unknown> }
    | { ok: false; error: string };
  createVaultLockLifecycle: (options: {
    powerMonitor: EventEmitter & { getSystemIdleTime?: () => number };
    lockRenderer: (reason: string) => void;
    logError?: (error: unknown) => void;
    logPowerEvent?: (eventName: string) => void;
    pollMs?: number;
    setIntervalFn?: (callback: () => void, delay: number) => unknown;
    clearIntervalFn?: (timer: unknown) => void;
  }) => {
    applyPolicy: (settings: typeof SAFE_POLICY) => void;
    registerPowerMonitorListeners: () => void;
    shouldLock: (eventName: string) => boolean;
    shutdown: () => void;
  };
};

const SAFE_POLICY = {
  idleTimeoutSeconds: 300,
  lockOnSuspend: true,
  lockOnResume: true,
  lockOnScreenLock: true,
};

function makeLifecycleHarness() {
  const powerMonitor = new EventEmitter() as EventEmitter & {
    getSystemIdleTime: () => number;
  };
  let idleSeconds = 0;
  powerMonitor.getSystemIdleTime = () => idleSeconds;

  const timers: Array<{ callback: () => void; unref: ReturnType<typeof vi.fn> }> = [];
  const clearedTimers: unknown[] = [];
  const setIntervalFn = vi.fn((callback: () => void) => {
    const timer = { callback, unref: vi.fn() };
    timers.push(timer);
    return timer;
  });
  const clearIntervalFn = vi.fn((timer: unknown) => {
    clearedTimers.push(timer);
  });
  const lockRenderer = vi.fn();
  const lifecycle = createVaultLockLifecycle({
    powerMonitor,
    lockRenderer,
    setIntervalFn,
    clearIntervalFn,
    pollMs: 25,
  });

  return {
    powerMonitor,
    lifecycle,
    timers,
    clearedTimers,
    setIntervalFn,
    clearIntervalFn,
    lockRenderer,
    setIdleSeconds(value: number) {
      idleSeconds = value;
    },
  };
}

describe("desktop vault lock policy validation", () => {
  it("accepts a supported complete policy and strips unrelated input", () => {
    expect(validateVaultLockSettings({ ...SAFE_POLICY, unrelated: "ignored" })).toEqual({
      ok: true,
      settings: SAFE_POLICY,
    });
    expect(validateVaultLockSettings({ ...SAFE_POLICY, idleTimeoutSeconds: 0 }).ok).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { ...SAFE_POLICY, idleTimeoutSeconds: -1 },
    { ...SAFE_POLICY, idleTimeoutSeconds: 1.5 },
    { ...SAFE_POLICY, idleTimeoutSeconds: 12 },
    { ...SAFE_POLICY, idleTimeoutSeconds: 86401 },
    { ...SAFE_POLICY, lockOnSuspend: "yes" },
    { ...SAFE_POLICY, lockOnResume: 1 },
    { ...SAFE_POLICY, lockOnScreenLock: null },
  ])("rejects malformed input %#", (input) => {
    expect(validateVaultLockSettings(input).ok).toBe(false);
  });

  it("uses the secure idle default for malformed environment input", () => {
    expect(parseIdleLockTimeoutEnv(undefined)).toBe(300);
    expect(parseIdleLockTimeoutEnv("")).toBe(300);
    expect(parseIdleLockTimeoutEnv("nope")).toBe(300);
    expect(parseIdleLockTimeoutEnv("-1")).toBe(300);
    expect(parseIdleLockTimeoutEnv("1.5")).toBe(300);
    expect(parseIdleLockTimeoutEnv("86401")).toBe(300);
    expect(parseIdleLockTimeoutEnv("0")).toBe(0);
    expect(parseIdleLockTimeoutEnv("120")).toBe(120);
  });

});

describe("desktop vault lock lifecycle", () => {
  it("replaces the idle interval when the policy changes", () => {
    const harness = makeLifecycleHarness();

    harness.lifecycle.applyPolicy(SAFE_POLICY);
    const firstTimer = harness.timers[0];
    harness.lifecycle.applyPolicy({ ...SAFE_POLICY, idleTimeoutSeconds: 60 });

    expect(harness.clearIntervalFn).toHaveBeenCalledWith(firstTimer);
    expect(harness.timers).toHaveLength(2);
    expect(harness.timers[1].unref).toHaveBeenCalledOnce();

    harness.lifecycle.applyPolicy({ ...SAFE_POLICY, idleTimeoutSeconds: 0 });
    expect(harness.clearIntervalFn).toHaveBeenLastCalledWith(harness.timers[1]);
    expect(harness.setIntervalFn).toHaveBeenCalledTimes(2);
  });

  it("does not create a zero-timeout interval, unrefs active timers, and shuts down cleanly", () => {
    const harness = makeLifecycleHarness();

    harness.lifecycle.applyPolicy({ ...SAFE_POLICY, idleTimeoutSeconds: 0 });
    expect(harness.setIntervalFn).not.toHaveBeenCalled();

    harness.lifecycle.applyPolicy(SAFE_POLICY);
    expect(harness.timers[0].unref).toHaveBeenCalledOnce();
    harness.lifecycle.shutdown();

    expect(harness.clearIntervalFn).toHaveBeenCalledWith(harness.timers[0]);
    expect(harness.lifecycle.shouldLock("suspend")).toBe(false);
  });

  it("locks once per idle episode and locks again after activity resumes", () => {
    const harness = makeLifecycleHarness();
    harness.lifecycle.applyPolicy(SAFE_POLICY);

    harness.setIdleSeconds(300);
    harness.timers[0].callback();
    harness.timers[0].callback();
    expect(harness.lockRenderer).toHaveBeenCalledTimes(1);
    expect(harness.lockRenderer).toHaveBeenCalledWith("idle");

    harness.setIdleSeconds(0);
    harness.timers[0].callback();
    harness.setIdleSeconds(300);
    harness.timers[0].callback();
    expect(harness.lockRenderer).toHaveBeenCalledTimes(2);
  });

  it("applies the current policy to suspend, resume, and screen-lock events", () => {
    const harness = makeLifecycleHarness();
    harness.lifecycle.registerPowerMonitorListeners();
    harness.lifecycle.applyPolicy({
      ...SAFE_POLICY,
      lockOnSuspend: false,
      lockOnResume: true,
      lockOnScreenLock: false,
    });

    harness.powerMonitor.emit("suspend");
    harness.powerMonitor.emit("resume");
    harness.powerMonitor.emit("lock-screen");
    expect(harness.lockRenderer.mock.calls).toEqual([["resume"]]);

    harness.lifecycle.applyPolicy({
      ...SAFE_POLICY,
      lockOnSuspend: false,
      lockOnResume: false,
      lockOnScreenLock: true,
    });
    harness.powerMonitor.emit("suspend");
    harness.powerMonitor.emit("resume");
    harness.powerMonitor.emit("lock-screen");
    expect(harness.lockRenderer.mock.calls).toEqual([["resume"], ["lock-screen"]]);

    harness.lifecycle.shutdown();
    harness.powerMonitor.emit("lock-screen");
    expect(harness.lockRenderer.mock.calls).toHaveLength(2);
  });
});