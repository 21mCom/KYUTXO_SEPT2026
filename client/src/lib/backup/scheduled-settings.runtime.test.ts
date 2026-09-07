// @vitest-environment jsdom
//
// Regression coverage for concurrent device-local backup status updates.
// Every operation below uses the real settings CRUD/Dexie database. The
// capacity probe is deliberately held open while the scheduled runner records
// one verified destination and one failed destination, then a restore drill
// and a policy edit are applied. A read-then-write implementation would lose
// one or more of those fields; mutateSettings keeps each update atomic.

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "@/lib/database";
import {
  clearSettings,
  getSettings,
  putSettings,
  mutateSettings,
} from "@/lib/data/settings-crud";
import {
  BACKUP_FREE_SPACE_HISTORY_LIMIT,
  cancelActiveScheduledBackup,
  DEFAULT_BACKUP_SCHEDULE,
  mergeBackupSchedulePolicy,
  normalizeBackupSchedule,
  runDueScheduledBackup,
} from "./scheduled";
import { runVaultHealthCheck } from "@/lib/vault-health";
import type { BackupScheduleSettings } from "@/lib/db-types";

const backupApi = vi.hoisted(() => ({
  listScheduledBackups: vi.fn(),
  getScheduledBackupDiskSpace: vi.fn(),
  scheduledBackupOpen: vi.fn(),
  scheduledBackupWrite: vi.fn(),
  scheduledBackupClose: vi.fn(),
  scheduledBackupRead: vi.fn(),
  scheduledBackupValidate: vi.fn(),
  scheduledBackupPromote: vi.fn(),
  scheduledBackupAbort: vi.fn(),
  listAllAttachments: vi.fn(),
  closeAttachmentListing: vi.fn(),
  getAttachmentsSize: vi.fn(),
  readAttachment: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  getElectronAPISafe: () => backupApi,
}));

const DESTINATION_A = "a".repeat(32);
const DESTINATION_B = "b".repeat(32);
const CAPACITY_READING_AT = Date.UTC(2026, 8, 3, 10, 0);
const SCHEDULED_RUN_AT = Date.UTC(2026, 8, 3, 11, 0);
const RESTORE_DRILL_AT = Date.UTC(2026, 8, 3, 12, 0);

function destinationStates() {
  return {
    [DESTINATION_A]: {
      freeSpaceHistory: Array.from(
        { length: BACKUP_FREE_SPACE_HISTORY_LIMIT + 4 },
        (_, index) => ({ at: index + 1, freeBytes: 100 + index }),
      ),
      lastFailureAt: 100,
      lastFailureMessage: "Previous capacity warning",
    },
    [DESTINATION_B]: {
      freeSpaceHistory: [{ at: 1, freeBytes: 20 }],
    },
  };
}

function initialSchedule(): BackupScheduleSettings {
  return {
    ...DEFAULT_BACKUP_SCHEDULE,
    enabled: true,
    destinations: [
      { token: DESTINATION_A, label: "Primary drive" },
      { token: DESTINATION_B, label: "Secondary drive" },
    ],
    promptBehavior: "automatic",
    encrypted: false,
    destinationStates: destinationStates(),
  };
}

beforeEach(async () => {
  await clearSettings({ skipNotification: true });
  await putSettings(
    {
      ...createDefaultSettings("default"),
      backupSchedule: initialSchedule(),
    },
    { skipNotification: true },
  );

  backupApi.listScheduledBackups.mockReset().mockResolvedValue({
    success: true,
    files: [],
    invalidFiles: [],
  });
  backupApi.getScheduledBackupDiskSpace.mockReset().mockResolvedValue({
    success: true,
    freeBytes: 10 * 1024 * 1024 * 1024,
  });
  backupApi.scheduledBackupOpen.mockReset().mockImplementation(async (token: string) =>
    token === DESTINATION_A
      ? { success: true, id: "primary-partial-backup" }
      : { success: false, error: "Secondary drive was removed" },
  );
  backupApi.scheduledBackupWrite.mockReset().mockResolvedValue({ success: true });
  backupApi.scheduledBackupClose.mockReset().mockResolvedValue({
    success: true,
    checksum: "primary-checksum",
  });
  backupApi.scheduledBackupRead.mockReset();
  backupApi.scheduledBackupValidate.mockReset().mockResolvedValue({ success: true });
  backupApi.scheduledBackupPromote.mockReset().mockResolvedValue({
    success: true,
    sizeBytes: 1234,
    checksum: "primary-checksum",
  });
  backupApi.scheduledBackupAbort.mockReset().mockResolvedValue({ success: true });
  backupApi.listAllAttachments.mockReset().mockResolvedValue({
    success: true,
    files: [],
    totalBytes: 0,
  });
  backupApi.closeAttachmentListing.mockReset().mockResolvedValue({ success: true });
  backupApi.getAttachmentsSize.mockReset().mockResolvedValue({
    success: true,
    totalBytes: 0,
    fileCount: 0,
  });
  backupApi.readAttachment.mockReset().mockResolvedValue({
    success: true,
    data: new ArrayBuffer(0),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearSettings({ skipNotification: true });
});

describe("backup schedule status persistence", () => {
  it("aborts a removed destination while export chunks are still being written and continues", async () => {
      const archiveChunks = new Map<string, Uint8Array[]>();
      backupApi.scheduledBackupOpen.mockImplementation(async (token: string) => ({
        success: true,
        id: token === DESTINATION_A ? "primary-partial-backup" : "secondary-partial-backup",
      }));
      backupApi.scheduledBackupWrite.mockImplementation(async (id: string, data: ArrayBuffer) => {
        const chunks = archiveChunks.get(id) ?? [];
        chunks.push(new Uint8Array(data.slice(0)));
        archiveChunks.set(id, chunks);
        return { success: true };
      });
      backupApi.scheduledBackupRead.mockImplementation(async (id: string, offset: number) => {
        const archive = concatChunks(archiveChunks.get(id) ?? []);
        const chunk = archive.subarray(offset);
        return {
          success: true,
          data: chunk.slice().buffer,
          eof: true,
        };
      });

      let releaseFirstWrite!: () => void;
      const firstWriteHeld = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      let firstWriteStarted!: () => void;
      const firstWriteEntered = new Promise<void>((resolve) => {
        firstWriteStarted = resolve;
      });
      let primaryWrites = 0;
      backupApi.scheduledBackupWrite.mockImplementation(async (id: string, data: ArrayBuffer) => {
        if (id === "primary-partial-backup" && primaryWrites++ === 0) {
          firstWriteStarted();
          await firstWriteHeld;
        }
        const chunks = archiveChunks.get(id) ?? [];
        chunks.push(new Uint8Array(data.slice(0)));
        archiveChunks.set(id, chunks);
        return { success: true };
      });

      const scheduledRun = runDueScheduledBackup({ now: SCHEDULED_RUN_AT });
      await firstWriteEntered;

      const current = await getSettings("default");
      const edited = {
        ...normalizeBackupSchedule(current?.backupSchedule),
        destinations: [{ token: DESTINATION_B, label: "Secondary drive" }],
        destinationStates: undefined,
      };
      await mutateSettings("default", (latest) => ({
        backupSchedule: mergeBackupSchedulePolicy(latest.backupSchedule, edited),
      }));
      cancelActiveScheduledBackup(DESTINATION_A);

      await vi.waitFor(() =>
        expect(backupApi.scheduledBackupAbort).toHaveBeenCalledWith("primary-partial-backup"),
      );
      releaseFirstWrite();
      const result = await scheduledRun;
      const saved = normalizeBackupSchedule((await getSettings("default"))?.backupSchedule);

      expect(result).toEqual({
        verified: 1,
        skipped: false,
        failures: [],
      });
      expect(backupApi.scheduledBackupAbort).toHaveBeenCalledWith("primary-partial-backup");
      expect(backupApi.scheduledBackupPromote).not.toHaveBeenCalledWith(
        "primary-partial-backup",
        expect.any(String),
        true,
      );
      expect(backupApi.scheduledBackupPromote).toHaveBeenCalledWith(
        "secondary-partial-backup",
        expect.any(String),
        true,
      );
      expect(saved.destinations).toEqual([
        { token: DESTINATION_B, label: "Secondary drive" },
      ]);
      expect(saved.destinationStates?.[DESTINATION_A]).toBeUndefined();
      expect(saved.destinationStates?.[DESTINATION_B]?.freeSpaceHistory).toEqual([{ at: 1, freeBytes: 20 }]);
      expect(saved.destinationStates?.[DESTINATION_B]?.lastVerifiedAt).toBe(SCHEDULED_RUN_AT);
    });

  it("retains interleaved capacity, success, failure, and drill updates", async () => {
    let releaseCapacity!: () => void;
    const capacityHeld = new Promise<void>((resolve) => {
      releaseCapacity = resolve;
    });
    let capacityProbeStarted!: () => void;
    const capacityProbeEntered = new Promise<void>((resolve) => {
      capacityProbeStarted = resolve;
    });
    let capacityCalls = 0;
    const archiveChunks: Uint8Array[] = [];

    vi.spyOn(Date, "now").mockReturnValue(CAPACITY_READING_AT);
    backupApi.getScheduledBackupDiskSpace.mockImplementation(async () => {
      capacityCalls++;
      if (capacityCalls === 1) {
        capacityProbeStarted();
        await capacityHeld;
      }
      return {
        success: true,
        freeBytes: 10 * 1024 * 1024 * 1024,
      };
    });
    backupApi.scheduledBackupWrite.mockImplementation(async (_id: string, data: ArrayBuffer) => {
      archiveChunks.push(new Uint8Array(data.slice(0)));
      return { success: true };
    });
    backupApi.scheduledBackupRead.mockImplementation(async (_id: string, offset: number) => {
      const archive = concatChunks(archiveChunks);
      const chunk = archive.subarray(offset);
      return {
        success: true,
        data: chunk.slice().buffer,
        eof: true,
      };
    });

    const healthCheck = runVaultHealthCheck();
    await capacityProbeEntered;

    // Start the real scheduled path while the health check still has its
    // first capacity read in flight. The runner creates a real v3 archive from
    // the empty test vault; the resulting bytes are served back for its real
    // verification step.
    const scheduledRun = runDueScheduledBackup({ now: SCHEDULED_RUN_AT });
    await vi.waitFor(() => expect(backupApi.scheduledBackupOpen).toHaveBeenCalledWith(
      DESTINATION_A,
      expect.any(String),
    ));

    const restoreDrill = mutateSettings("default", (current) => ({
      backupSchedule: {
        ...normalizeBackupSchedule(current.backupSchedule),
        lastRestoreDrillAt: RESTORE_DRILL_AT,
      },
    }));

    releaseCapacity();
    const [healthResult, scheduledResult] = await Promise.all([healthCheck, scheduledRun]);
    await restoreDrill;

    expect(scheduledResult).toEqual({
      verified: 1,
      skipped: false,
      failures: ["Secondary drive: Secondary drive was removed"],
    });
    expect(healthResult.backup.destinationFreeSpaceHistory?.[0]).toHaveLength(
      BACKUP_FREE_SPACE_HISTORY_LIMIT,
    );

    // Saving the policy after the interleaved status updates must retain the
    // destination history/status for A while removing B's stale state.
    const current = await getSettings("default");
    const edited = {
      ...normalizeBackupSchedule(current?.backupSchedule),
      destinations: [{ token: DESTINATION_A, label: "Primary drive renamed" }],
      cadenceDays: 14 as const,
      destinationStates: undefined,
    };
    await mutateSettings("default", (latest) => ({
      backupSchedule: mergeBackupSchedulePolicy(latest.backupSchedule, edited),
    }));

    const saved = normalizeBackupSchedule((await getSettings("default"))?.backupSchedule);
    const primaryState = saved.destinationStates?.[DESTINATION_A];
    expect(saved.destinations).toEqual([
      { token: DESTINATION_A, label: "Primary drive renamed" },
    ]);
    expect(saved.cadenceDays).toBe(14);
    expect(saved.lastVerifiedAt).toBe(SCHEDULED_RUN_AT);
    expect(saved.lastVerifiedDestination).toBe("Primary drive");
    expect(saved.lastVerifiedSizeBytes).toBe(1234);
    expect(saved.lastVerifiedChecksum).toBe("primary-checksum");
    expect(saved.lastRestoreDrillAt).toBe(RESTORE_DRILL_AT);
    expect(saved.lastFailureAt).toBe(SCHEDULED_RUN_AT);
    expect(saved.lastFailureMessage).toBe("Secondary drive was removed");
    expect(primaryState?.freeSpaceHistory).toHaveLength(BACKUP_FREE_SPACE_HISTORY_LIMIT);
    expect(primaryState?.freeSpaceHistory?.at(-1)).toEqual({
      at: CAPACITY_READING_AT,
      freeBytes: 10 * 1024 * 1024 * 1024,
    });
    expect(primaryState?.lastVerifiedAt).toBe(SCHEDULED_RUN_AT);
    expect(primaryState?.lastFailureAt).toBeUndefined();
    expect(saved.destinationStates?.[DESTINATION_B]).toBeUndefined();
  });
});

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}