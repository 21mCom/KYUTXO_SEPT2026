// @vitest-environment jsdom
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setVaultLockSettings = vi.hoisted(() => vi.fn());

vi.mock("../electron", () => ({
  getElectronAPISafe: () => ({ setVaultLockSettings }),
}));

import { db } from "../database";
import {
  clearSettings,
  getSettings,
  putSettings,
  clearSettings,
  syncDesktopLockSettings,
  updateDesktopLockSettings,
} from "./settings-crud";
import type { DesktopLockSettings } from "../desktop-lock-settings";

const POLICY_A: DesktopLockSettings = {
  idleTimeoutSeconds: 300,
  lockOnSuspend: true,
  lockOnResume: true,
  lockOnScreenLock: true,
};

const POLICY_B: DesktopLockSettings = {
  idleTimeoutSeconds: 900,
  lockOnSuspend: false,
  lockOnResume: true,
  lockOnScreenLock: false,
};

beforeEach(async () => {
  setVaultLockSettings.mockReset();
  setVaultLockSettings.mockResolvedValue({ success: true });
  await clearSettings();
  await putSettings({ id: "default", desktopLockSettings: POLICY_A });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop lock settings persistence", () => {
  it("serializes startup synchronization and saves", async () => {
    let releaseSync!: () => void;
    setVaultLockSettings
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          releaseSync = () => resolve({ success: true });
        }),
      )
      .mockResolvedValue({ success: true });

    const syncing = syncDesktopLockSettings();
    await vi.waitFor(() => expect(setVaultLockSettings).toHaveBeenCalledTimes(1));

    const saving = updateDesktopLockSettings(POLICY_B);
    await Promise.resolve();
    expect(setVaultLockSettings).toHaveBeenCalledTimes(1);
    expect((await getSettings("default"))?.desktopLockSettings).toEqual(POLICY_A);

    releaseSync();
    await Promise.all([syncing, saving]);

    expect(setVaultLockSettings.mock.calls).toEqual([[POLICY_A], [POLICY_B]]);
    expect((await getSettings("default"))?.desktopLockSettings).toEqual(POLICY_B);
  });

  it("restores the previous stored policy when Electron rejects a save", async () => {
    setVaultLockSettings.mockResolvedValueOnce({
      success: false,
      error: "rejected",
    });

    await expect(updateDesktopLockSettings(POLICY_B)).rejects.toThrow("rejected");
    expect((await getSettings("default"))?.desktopLockSettings).toEqual(POLICY_A);
  });

  it("does not change Electron when persistence fails", async () => {
    vi.spyOn(db.settings, "update").mockRejectedValueOnce(new Error("disk full"));

    await expect(updateDesktopLockSettings(POLICY_B)).rejects.toThrow("disk full");
    expect(setVaultLockSettings).not.toHaveBeenCalled();
    expect((await getSettings("default"))?.desktopLockSettings).toEqual(POLICY_A);
  });
});
