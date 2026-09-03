import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_LOCK_SETTINGS,
  normalizeDesktopLockSettings,
  stripDesktopLockSettingsFromBackupRows,
} from "./desktop-lock-settings";

describe("normalizeDesktopLockSettings", () => {
  it("keeps every supported user choice", () => {
    expect(normalizeDesktopLockSettings({
      idleTimeoutSeconds: 1800,
      lockOnSuspend: false,
      lockOnResume: true,
      lockOnScreenLock: false,
    })).toEqual({
      idleTimeoutSeconds: 1800,
      lockOnSuspend: false,
      lockOnResume: true,
      lockOnScreenLock: false,
    });
  });

  it("fails safe for missing or malformed values", () => {
    expect(normalizeDesktopLockSettings(null)).toEqual(DEFAULT_DESKTOP_LOCK_SETTINGS);
    expect(normalizeDesktopLockSettings({
      idleTimeoutSeconds: 12,
      lockOnSuspend: "no",
      lockOnResume: false,
    })).toEqual({
      idleTimeoutSeconds: 300,
      lockOnSuspend: true,
      lockOnResume: false,
      lockOnScreenLock: true,
    });
  });

  it("strips the device-only policy from backup settings rows", () => {
    expect(stripDesktopLockSettingsFromBackupRows([
      {
        id: "default",
        theme: "dark",
        desktopLockSettings: {
          idleTimeoutSeconds: 0,
          lockOnSuspend: false,
          lockOnResume: false,
          lockOnScreenLock: false,
        },
      },
    ])).toEqual([{ id: "default", theme: "dark" }]);
  });
});