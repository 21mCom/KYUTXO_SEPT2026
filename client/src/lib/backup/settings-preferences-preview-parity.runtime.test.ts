// @vitest-environment jsdom
//
// Parity guard tying `previewSettingsPreferences` to `restoreSettingsPreferences`.
//
// Both helpers are driven by the same PORTABLE_PREFERENCES allow-list, but
// nothing structurally forces the *preview* (what we tell the user a restore
// will carry over) to agree with the *restore* (what actually lands in the
// settings row). If the two ever drift — a descriptor's extract/validation
// changes on one path but not the other — the user would see a preview that
// lies about the outcome.
//
// These tests build inline `settings` rows, capture the preview, run the real
// `restoreSettingsPreferences` against the REAL `@/lib/database` schema over
// fake-indexeddb, and assert the post-restore settings match the preview field
// for field: every pref flagged `fromBackup` ended up applied (with a value
// matching its formatted preview), and every "kept (this device)" pref was left
// exactly as the device had it.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  previewSettingsPreferences,
  restoreSettingsPreferences,
} from "./inline-tables";
import {
  getSettings,
  putSettings,
  clearSettings,
} from "@/lib/data/settings-crud";

const BASE_SETTINGS = {
  id: "default",
  fieldVisibility: {
    seedName: true,
    walletSoftware: true,
    privateKeyStatus: false,
    owner: true,
    walletName: true,
    source: true,
  },
  tableColumns: {},
  customFieldColumns: {},
  theme: "light",
  defaultView: "table",
  // Device-local starting values for the portable prefs. Chosen to differ from
  // the backup values below so "applied" vs "kept" is unambiguous.
  disableOrphanCheck: false,
  cancelConfirmThreshold: 75,
  privacyHistoryLimit: 30,
  fundTrailTxLimit: 2000,
  fundTrailLayout: "classic",
  // No entity-list snapshot on this device to start.
} as any;

// Re-derive the device value a "kept" preference should retain. Mirrors the
// formatting the preview uses so kept prefs can be compared against the device
// state the same way fromBackup prefs are compared against the backup.
function formatDeviceValue(key: string, settings: any): string | null {
  switch (key) {
    case "disableOrphanCheck":
      return settings.disableOrphanCheck ? "Off" : "On";
    case "cancelConfirmThreshold":
      return settings.cancelConfirmThreshold === 0
        ? "Always confirm"
        : `${settings.cancelConfirmThreshold}%`;
    case "privacyHistoryLimit":
      return `${settings.privacyHistoryLimit} runs`;
    case "fundTrailTxLimit":
      return `${settings.fundTrailTxLimit.toLocaleString()} per hop`;
    case "fundTrailLayout": {
      const labels: Record<string, string> = {
        classic: "Classic columns",
        horizontal: "Horizontal hop timeline",
        vertical: "Vertical timeline scroll",
        breakout: "Full-screen breakout",
        sankey: "Sankey flow",
      };
      return labels[settings.fundTrailLayout] ?? String(settings.fundTrailLayout);
    }
    case "intermediaryAddressCap":
      return `${settings.intermediaryAddressCap.toLocaleString()} addresses`;
    case "sourceOfFundsTxLimit":
      return `${settings.sourceOfFundsTxLimit.toLocaleString()} transactions`;
    case "entityListSnapshot": {
      const snap = settings.entityListSnapshot;
      if (!snap || !Array.isArray(snap.entries)) return null;
      const n = snap.entries.length;
      return `${n} ${n === 1 ? "entry" : "entries"}`;
    }
    case "quantumTagLevels": {
      const levels = settings.quantumTagLevels;
      if (!Array.isArray(levels)) return null;
      if (levels.length === 0) return "None (analysis only)";
      const labels: Record<string, string> = {
        critical: "Critical",
        high: "High",
        medium: "Medium",
        variable: "Variable",
        low: "Low",
      };
      return levels.map((l: string) => labels[l] ?? String(l)).join(" + ");
    }
    case "savedInboxViews": {
      const views = settings.savedInboxViews;
      if (!Array.isArray(views)) return null;
      return `${views.length} ${views.length === 1 ? "view" : "views"}`;
    }
    default:
      return null;
  }
}

describe("settings-preferences preview/restore parity", () => {
  beforeEach(async () => {
    await clearSettings({ skipNotification: true });
  });

  it("applies every fromBackup pref and keeps every device-local one, matching the preview", async () => {
    await putSettings({ ...BASE_SETTINGS }, { skipNotification: true });
    const deviceBefore = await getSettings("default");

    // Backup row carries a MIX: valid boolean + valid numeric (incl. the
    // special 0 "Always confirm") + valid snapshot, but a wrong-typed
    // privacyHistoryLimit that must be rejected and left on-device.
    const backupRow = {
      id: "default",
      disableOrphanCheck: true,
      cancelConfirmThreshold: 0,
      privacyHistoryLimit: "100", // wrong type -> kept on device
      entityListSnapshot: { entries: [{ address: "a" }, { address: "b" }] },
    };

    const preview = previewSettingsPreferences([backupRow]);
    // Sanity: the mix produced both fromBackup and kept entries.
    expect(preview.some((p) => p.fromBackup)).toBe(true);
    expect(preview.some((p) => !p.fromBackup)).toBe(true);

    await restoreSettingsPreferences([backupRow]);
    const after = await getSettings("default");

    for (const p of preview) {
      if (p.fromBackup) {
        // The applied value must render exactly as the preview promised.
        expect(formatDeviceValue(p.key, after)).toBe(p.backupValue);
      } else {
        // Kept prefs: the device value is untouched and the preview reported
        // no backup value.
        expect(p.backupValue).toBeNull();
        expect((after as any)[p.key]).toEqual((deviceBefore as any)[p.key]);
      }
    }

    // Concrete spot-checks so a broken formatter can't make the loop vacuous.
    expect(after?.disableOrphanCheck).toBe(true);
    expect(after?.cancelConfirmThreshold).toBe(0);
    expect(after?.privacyHistoryLimit).toBe(30); // unchanged device value
    expect((after as any)?.entityListSnapshot?.entries).toHaveLength(2);
  });

  it("keeps every pref when the backup carries no usable values (all kept)", async () => {
    await putSettings({ ...BASE_SETTINGS }, { skipNotification: true });
    const deviceBefore = await getSettings("default");

    // Older/malformed backup: missing boolean, NaN number, wrong-typed number,
    // empty snapshot — nothing is usable.
    const backupRow = {
      id: "default",
      cancelConfirmThreshold: Number.NaN,
      privacyHistoryLimit: "30",
      entityListSnapshot: { entries: [] },
    };

    const preview = previewSettingsPreferences([backupRow]);
    expect(preview.every((p) => !p.fromBackup)).toBe(true);
    expect(preview.every((p) => p.backupValue === null)).toBe(true);

    await restoreSettingsPreferences([backupRow]);
    const after = await getSettings("default");

    for (const p of preview) {
      expect((after as any)[p.key]).toEqual((deviceBefore as any)[p.key]);
    }
  });

  it("applies every pref when the backup carries usable values for all of them", async () => {
    await putSettings({ ...BASE_SETTINGS }, { skipNotification: true });

    const backupRow = {
      id: "default",
      disableOrphanCheck: true,
      cancelConfirmThreshold: 90,
      privacyHistoryLimit: 100,
      fundTrailTxLimit: 5000,
      fundTrailLayout: "sankey",
      intermediaryAddressCap: 25,
      sourceOfFundsTxLimit: 5000,
      quantumTagLevels: ["critical", "medium"],
      entityListSnapshot: { entries: [{ address: "a" }] },
      savedInboxViews: [{
        id: "view-1",
        name: "Recent incoming",
        tab: "new",
        search: "",
        filters: { dateMode: "range", dateStart: "2026-01-01T00:00:00.000Z", amountMode: "any" },
        createdAt: 1,
      }],
    };

    const preview = previewSettingsPreferences([backupRow]);
    expect(preview.every((p) => p.fromBackup)).toBe(true);

    await restoreSettingsPreferences([backupRow]);
    const after = await getSettings("default");

    for (const p of preview) {
      expect(formatDeviceValue(p.key, after)).toBe(p.backupValue);
    }

    expect(after?.disableOrphanCheck).toBe(true);
    expect(after?.cancelConfirmThreshold).toBe(90);
    expect(after?.privacyHistoryLimit).toBe(100);
    expect((after as any)?.fundTrailTxLimit).toBe(5000);
    expect((after as any)?.entityListSnapshot?.entries).toHaveLength(1);
    expect(after?.savedInboxViews).toHaveLength(1);
  });
});
