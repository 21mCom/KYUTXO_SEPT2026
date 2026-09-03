import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  parseIdleLockTimeoutEnv,
  validateVaultLockSettings,
} = require("./vault-lock-settings.cjs") as {
  parseIdleLockTimeoutEnv: (value: string | undefined) => number;
  validateVaultLockSettings: (value: unknown) =>
    | { ok: true; settings: Record<string, unknown> }
    | { ok: false; error: string };
};

const SAFE_POLICY = {
  idleTimeoutSeconds: 300,
  lockOnSuspend: true,
  lockOnResume: true,
  lockOnScreenLock: true,
};

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