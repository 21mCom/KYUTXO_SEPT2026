import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordRows, syncRows, tableErrors, tables } = vi.hoisted(() => {
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
vi.mock("@/lib/data/privacy-history-crud", () => ({
  getPrivacyAuditHistory: vi.fn(async () => []),
}));
vi.mock("@/lib/data/privacy-audit-session-store", () => ({
  loadAuditSession: vi.fn(async () => undefined),
}));

import { getVaultHealthStatus, runVaultHealthCheck, type VaultHealthSnapshot } from "./vault-health";

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
});

describe("runVaultHealthCheck", () => {
  beforeEach(() => {
    recordRows.splice(0);
    syncRows.splice(0);
    tableErrors.clear();
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