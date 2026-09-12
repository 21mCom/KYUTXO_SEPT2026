// @vitest-environment jsdom
//
// Regression guard for the LEGACY (pre-v3) backup restore path's handling of
// the nodeSettings singleton. SettingsPage's legacy JSON restore used to keep
// its OWN copy of the nodeSettings restore loop, separate from the v3 streaming
// path, and that copy was exercised by no automated test — so a regression
// there (stripping the id, or using `add` instead of `put`) would go unnoticed.
//
// Both paths now share `restoreNodeSettingsRows` from `./inline-tables`. These
// tests drive that shared helper over the REAL `@/lib/database` schema through
// fake-indexeddb and assert the two invariants the legacy path depended on:
//   1. the singleton id ("default") is preserved and every field survives, and
//   2. `put` (not `add`) semantics are used, so restoring the same backup twice
//      overwrites in place instead of duplicating or throwing a key error.
// It also covers the empty/undefined input cases the legacy path guarded for.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { type NodeSettings } from "@/lib/database";
import { restoreNodeSettingsRows } from "./inline-tables";
import {
  getNodeSettings,
  getAllNodeSettings,
  putNodeSettings,
  clearNodeSettings,
} from "@/lib/data/node-settings-crud";

// A fully-populated nodeSettings row: every optional and required field set to a
// non-default value so a dropped/coerced field is caught.
const FULL_NODE_SETTINGS: NodeSettings = {
  id: "default",
  providerType: "custom-electrs",
  customUrl: "http://192.168.1.100:3002",
  useTor: true,
  torProxyUrl: "socks5h://127.0.0.1:9050",
  requestTimeout: 60000,
  network: "testnet",
  allowLocalNetwork: true,
  trustedLocalHosts: ["192.168.4.118", "myhost.local"],
  useElectrum: true,
  electrumHost: "192.168.4.118",
  electrumPort: 50001,
  electrumSSL: true,
  electrumServerType: "fulcrum",
  lastConnectedAt: 1_750_000_000_000,
  lastConnectionStatus: "Connected",
};

describe("legacy restore path: nodeSettings handling", () => {
  beforeEach(async () => {
    await clearNodeSettings({ skipNotification: true });
  });

  it("preserves the id and every field of a configured nodeSettings row", async () => {
    // The legacy path destructures `nodeSettings: backupNodeSettings = []` from
    // the parsed backup.json and feeds it straight to the shared helper.
    await restoreNodeSettingsRows([FULL_NODE_SETTINGS]);

    const all = await getAllNodeSettings();
    expect(all).toHaveLength(1);

    const restored = await getNodeSettings("default");
    expect(restored).toBeDefined();
    expect(restored!.id).toBe("default");
    // Deep equality catches a dropped/coerced field in either direction.
    expect(restored).toEqual(FULL_NODE_SETTINGS);
  });

  it("defaults a missing id to \"default\" (older backups omitted it)", async () => {
    const { id: _omit, ...withoutId } = FULL_NODE_SETTINGS;
    await restoreNodeSettingsRows([withoutId as NodeSettings]);

    const all = await getAllNodeSettings();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("default");
    expect(await getNodeSettings("default")).toEqual(FULL_NODE_SETTINGS);
  });

  it("uses put (not add): restoring twice overwrites in place, no duplicate or error", async () => {
    // Seed an existing row so the second restore has something to overwrite —
    // `add` would throw a duplicate-key error here, `put` overwrites cleanly.
    await putNodeSettings(
      { ...FULL_NODE_SETTINGS, lastConnectionStatus: "stale" },
      { skipNotification: true },
    );

    await restoreNodeSettingsRows([FULL_NODE_SETTINGS]);
    await expect(restoreNodeSettingsRows([FULL_NODE_SETTINGS])).resolves.toBeUndefined();

    expect(await getAllNodeSettings()).toHaveLength(1);
    expect(await getNodeSettings("default")).toEqual(FULL_NODE_SETTINGS);
  });

  it("no-ops on an empty or undefined nodeSettings array (legacy default)", async () => {
    await expect(restoreNodeSettingsRows([])).resolves.toBeUndefined();
    await expect(
      restoreNodeSettingsRows(undefined as unknown as NodeSettings[]),
    ).resolves.toBeUndefined();
    expect(await getAllNodeSettings()).toHaveLength(0);
  });
});
