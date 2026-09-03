import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordRows, syncRows, tableErrors, tables, backupHarness, mutateSettingsMock } = vi.hoisted(() => {
  const rows: any[] = [];
  const errors = new Set<string>();
  return {
    recordRows: rows,
    syncRows: [] as any[],
    tableErrors: errors,
    tables: ["records", "recordOrigins", "attachments", "addressSyncState", "privacyAuditHistory"].map((name) => ({
      name,
      count: vi.fn(async () => {
        if (errors.has(name)) throw new Error(`${name} unreadable`);
        return name === "records" ? rows.length : 0;
      }),
    })),
    backupHarness: {
      settings: undefined as any,
      api: null as any,
      attachmentBytes: 0,
    },
    mutateSettingsMock: vi.fn(async (_id: string, mutate: (settings: any) => any) => {
      const changes = mutate(backupHarness.settings);
      backupHarness.settings = { ...backupHarness.settings, ...changes };
      return backupHarness.settings;
    }),
  };
});

vi.mock("@/lib/database", () => ({ db: { tables } }));
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsAfterId: vi.fn(async (afterId: number) => (afterId === 0 ? recordRows : [])),
}));
vi.mock("@/lib/data/record-origins-crud", () => ({
  getRecordOriginsByRecordIds: vi.fn(async () => []),
}));
vi.mock("@/lib/data/address-sync-crud", () => ({
  getAddressSyncStateAfterId: vi.fn(async (afterId: number) => (afterId === 0 ? syncRows : [])),
}));
vi.mock("@/lib/data/attachments-crud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/attachments-crud")>()),
  sumAttachmentSizes: vi.fn(async () => backupHarness.attachmentBytes),
}));
vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: vi.fn(async () => backupHarness.settings),
  mutateSettings: mutateSettingsMock,
}));
vi.mock("@/lib/electron", () => ({
  getElectronAPISafe: vi.fn(() => backupHarness.api),
}));
vi.mock("@/lib/data/privacy-history-crud", () => ({
  getPrivacyAuditHistory: vi.fn(async () => []),
}));
vi.mock("@/lib/data/privacy-audit-session-store", () => ({
  loadAuditSession: vi.fn(async () => undefined),
}));

import {
  getBackupCapacityThreshold,
  getVaultHealthStatus,
  runVaultHealthCheck,
  BACKUP_CAPACITY_SAFETY_MARGIN_BYTES,
  type VaultHealthSnapshot,
} from "./vault-health";

function snapshot(overrides: Partial<VaultHealthSnapshot> = {}): VaultHealthSnapshot {
  return {
    checkedAt: 1,
    tableCounts: [],
    integrity: { totalRecords: 2, lockedUnreadable: 0, blankIdentifiers: 0, tableErrors: 0 },
    metadata: {
      missingTier: 0,
      invalidTier: 0,
      searchKeyDesynced: 0,
      staleTypeFields: 0,
      nonCanonicalIdentifiers: 0,
      canonicalIdentifierCollisions: 0,
      hiddenTagged: 0,
    },
    conflicts: { records: 0, fields: 0 },
    sync: { addressRecords: 0, neverSynced: 0, stale: 0, syncStateRows: 0, unavailable: false },
    backup: { recordCount: 2, attachmentCount: 0, tableCount: 1, canExport: true },
    privacy: { hasRun: true, interrupted: false, findings: 0, criticalOrHigh: 0, unavailable: false },
    ...overrides,
  };
}

describe("getVaultHealthStatus", () => {
  beforeEach(() => {
    recordRows.splice(0);
    syncRows.splice(0);
    tableErrors.clear();
    backupHarness.settings = undefined;
    backupHarness.api = null;
    backupHarness.attachmentBytes = 0;
    mutateSettingsMock.mockClear();
  });

  it("reports a clean vault as healthy", () => {
    expect(getVaultHealthStatus(snapshot())).toBe("healthy");
  });

  it("reports actionable stale metadata as a warning", () => {
    expect(
      getVaultHealthStatus(snapshot({ metadata: { ...snapshot().metadata, searchKeyDesynced: 3 } })),
    ).toBe("warning");
  });

  it("promotes unreadable records and high-severity privacy findings to problems", () => {
    expect(
      getVaultHealthStatus(snapshot({ integrity: { ...snapshot().integrity, lockedUnreadable: 1 } })),
    ).toBe("problem");
    expect(
      getVaultHealthStatus(snapshot({ privacy: { ...snapshot().privacy, criticalOrHigh: 1 } })),
    ).toBe("problem");
  });

  it("treats low scheduled-backup capacity as a warning", () => {
    expect(getVaultHealthStatus(snapshot({
      backup: {
        ...snapshot().backup,
        scheduledEnabled: true,
        overdue: false,
        destinationCapacityWarning: [true],
      },
    }))).toBe("warning");
  });
});

describe("backup capacity threshold", () => {
  it("adds fixed safety headroom to the full-backup estimate", () => {
    expect(getBackupCapacityThreshold(1234)).toBe(1234 + BACKUP_CAPACITY_SAFETY_MARGIN_BYTES);
    expect(getBackupCapacityThreshold(Number.NaN)).toBe(BACKUP_CAPACITY_SAFETY_MARGIN_BYTES);
  });
});

describe("runVaultHealthCheck", () => {
  beforeEach(() => {
    recordRows.splice(0);
    syncRows.splice(0);
    tableErrors.clear();
    backupHarness.settings = undefined;
    backupHarness.api = null;
    backupHarness.attachmentBytes = 0;
  });

  it("probes opaque destinations, warns early, and preserves missing-drive failures", async () => {
    const availableToken = "a".repeat(32);
    const missingToken = "b".repeat(32);
    const listScheduledBackups = vi.fn(async (token: string) => token === availableToken
      ? { success: true, files: [{ name: "backup.zip", sizeBytes: 1, modifiedAt: 1 }], invalidFiles: [] }
      : { success: false, error: "Backup destination is unavailable" });
    const getScheduledBackupDiskSpace = vi.fn(async (token: string) => token === availableToken
      ? { success: true, freeBytes: 50 * 1024 * 1024 }
      : { success: false, error: "Backup destination is unavailable" });
    backupHarness.attachmentBytes = 10 * 1024 * 1024;
    backupHarness.settings = {
      backupSchedule: {
        enabled: true,
        destinations: [
          { token: availableToken, label: "Available" },
          { token: missingToken, label: "Missing" },
        ],
        cadenceDays: 7,
        retentionCount: 5,
        compact: true,
        encrypted: true,
        promptBehavior: "ask",
        destinationStates: {
          [availableToken]: {
            freeSpaceHistory: [
              { at: 100, freeBytes: 75 * 1024 * 1024 },
            ],
          },
          [missingToken]: { lastFailureAt: 123, lastFailureMessage: "Drive disconnected" },
        },
      },
    };
    backupHarness.api = { listScheduledBackups, getScheduledBackupDiskSpace };

    const result = await runVaultHealthCheck();

    expect(listScheduledBackups.mock.calls.map(([token]) => token)).toEqual([availableToken, missingToken]);
    expect(getScheduledBackupDiskSpace.mock.calls.map(([token]) => token)).toEqual([availableToken, missingToken]);
    expect(result.backup.destinationAvailable).toEqual([true, false]);
    expect(result.backup.destinationFreeBytes).toEqual([50 * 1024 * 1024, undefined]);
    expect(result.backup.destinationCapacityWarning).toEqual([true, false]);
    expect(result.backup.destinationFreeSpaceHistory?.[0]).toEqual([
      { at: 100, freeBytes: 75 * 1024 * 1024 },
      { at: result.checkedAt, freeBytes: 50 * 1024 * 1024 },
    ]);
    expect(result.backup.destinationFreeSpaceHistory?.[1]).toBeUndefined();
    expect(result.backup.estimatedNextFullBackupBytes).toBe(10 * 1024 * 1024);
    expect(result.backup.backupCapacityThresholdBytes).toBe(
      10 * 1024 * 1024 + BACKUP_CAPACITY_SAFETY_MARGIN_BYTES,
    );
    expect(result.backup.destinationFailures[1]).toEqual({
      at: 123,
      message: "Drive disconnected",
    });
    expect(mutateSettingsMock).toHaveBeenCalledTimes(1);
    expect(backupHarness.settings.backupSchedule.destinationStates[missingToken]).toEqual({
      lastFailureAt: 123,
      lastFailureMessage: "Drive disconnected",
    });
  });

  it("attributes an address-only sync checkpoint to its matching record", async () => {
    recordRows.push({
      id: 1,
      type: "address",
      inputString: "bc1qhealthsynced",
      inputStringLower: "bc1qhealthsynced",
      addressImportance: "manual",
      tags: [],
      categories: [],
    });
    syncRows.push({
      id: 1,
      address: "bc1qhealthsynced",
      lastSyncedAt: Date.now(),
      lastSyncedHeight: 1,
      txCount: 0,
    });

    const result = await runVaultHealthCheck();

    expect(result.sync.addressRecords).toBe(1);
    expect(result.sync.neverSynced).toBe(0);
    expect(result.sync.stale).toBe(0);
  });

  it("keeps independent results when sync or privacy history is unreadable", async () => {
    recordRows.push({
      id: 1,
      type: "address",
      inputString: "bc1qhealthpartial",
      inputStringLower: "bc1qhealthpartial",
      addressImportance: "manual",
      tags: [],
      categories: [],
    });
    tableErrors.add("addressSyncState");
    tableErrors.add("privacyAuditHistory");

    const result = await runVaultHealthCheck();

    expect(result.integrity.totalRecords).toBe(1);
    expect(result.integrity.tableErrors).toBe(2);
    expect(result.sync.unavailable).toBe(true);
    expect(result.privacy.unavailable).toBe(true);
    expect(getVaultHealthStatus(result)).toBe("problem");
  });
});