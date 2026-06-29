// Unit tests for `previewSettingsPreferences`, the pure helper that powers the
// pre-restore "which portable preferences will this backup carry over?" review.
// It must stay in lock-step with `restoreSettingsPreferences` (both driven by
// the same allow-list), so these assertions mirror the validation rules the
// restore path applies: only finite numbers, well-formed non-empty entity-list
// snapshots, and booleans are taken from the backup; anything else is reported
// as "kept (this device)".

import { describe, it, expect } from "vitest";

import { previewSettingsPreferences } from "./inline-tables";

const KEYS = [
  "disableOrphanCheck",
  "cancelConfirmThreshold",
  "privacyHistoryLimit",
  "fundTrailTxLimit",
  "fundTrailLayout",
  "intermediaryAddressCap",
  "sourceOfFundsTxLimit",
  "entityListSnapshot",
] as const;

function byKey(rows: any[]) {
  const preview = previewSettingsPreferences(rows);
  return Object.fromEntries(preview.map((p) => [p.key, p]));
}

describe("previewSettingsPreferences", () => {
  it("always returns every allow-listed preference, even with no rows", () => {
    const preview = previewSettingsPreferences([]);
    expect(preview.map((p) => p.key).sort()).toEqual([...KEYS].sort());
    for (const p of preview) {
      expect(p.fromBackup).toBe(false);
      expect(p.backupValue).toBeNull();
    }
  });

  it("marks each valid field as coming from the backup with a formatted value", () => {
    const map = byKey([
      {
        id: "default",
        disableOrphanCheck: true,
        cancelConfirmThreshold: 90,
        privacyHistoryLimit: 100,
        fundTrailTxLimit: 5000,
        entityListSnapshot: { entries: [{ address: "a" }, { address: "b" }] },
      },
    ]);
    expect(map.disableOrphanCheck).toMatchObject({ fromBackup: true, backupValue: "Off" });
    expect(map.cancelConfirmThreshold).toMatchObject({ fromBackup: true, backupValue: "90%" });
    expect(map.privacyHistoryLimit).toMatchObject({ fromBackup: true, backupValue: "100 runs" });
    expect(map.fundTrailTxLimit).toMatchObject({ fromBackup: true, backupValue: "5,000 per hop" });
    expect(map.entityListSnapshot).toMatchObject({ fromBackup: true, backupValue: "2 entries" });
  });

  it("formats the boolean reminder, the 'always confirm' threshold, and a single entry", () => {
    const map = byKey([
      {
        id: "default",
        disableOrphanCheck: false,
        cancelConfirmThreshold: 0,
        entityListSnapshot: { entries: [{ address: "a" }] },
      },
    ]);
    expect(map.disableOrphanCheck.backupValue).toBe("On");
    expect(map.cancelConfirmThreshold.backupValue).toBe("Always confirm");
    expect(map.entityListSnapshot.backupValue).toBe("1 entry");
  });

  it("treats missing, NaN, and empty/malformed values as kept-on-device", () => {
    const map = byKey([
      {
        id: "default",
        // disableOrphanCheck absent entirely
        cancelConfirmThreshold: Number.NaN,
        privacyHistoryLimit: "30", // wrong type
        entityListSnapshot: { entries: [] }, // empty snapshot
      },
    ]);
    for (const key of KEYS) {
      expect(map[key].fromBackup).toBe(false);
      expect(map[key].backupValue).toBeNull();
    }
  });

  it("prefers the `default` settings row over others", () => {
    const map = byKey([
      { id: "other", privacyHistoryLimit: 5 },
      { id: "default", privacyHistoryLimit: 45 },
    ]);
    expect(map.privacyHistoryLimit).toMatchObject({ fromBackup: true, backupValue: "45 runs" });
  });
});
