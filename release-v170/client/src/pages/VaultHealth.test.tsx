// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BACKUP_CAPACITY_SAFETY_MARGIN_BYTES, type VaultHealthSnapshot } from "@/lib/vault-health";

const { runHealthCheck } = vi.hoisted(() => ({ runHealthCheck: vi.fn() }));

vi.mock("@/lib/vault-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault-health")>();
  return { ...actual, runVaultHealthCheck: runHealthCheck };
});

import VaultHealth from "./VaultHealth";
import { VaultHealthCancelledError } from "@/lib/vault-health";

function snapshot(overrides: Partial<VaultHealthSnapshot> = {}): VaultHealthSnapshot {
  return {
    checkedAt: Date.UTC(2026, 7, 26),
    tableCounts: [{ name: "records", count: 4, error: false }],
    integrity: { totalRecords: 4, lockedUnreadable: 0, blankIdentifiers: 0, tableErrors: 0 },
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
    ownership: { unresolved: 0, under7Days: 0, sevenToThirtyDays: 0, over30Days: 0, unknownAge: 0, unavailable: false },
    sync: { addressRecords: 2, neverSynced: 0, stale: 0, syncStateRows: 2, latestSyncedAt: Date.now(), unavailable: false },
    backup: { recordCount: 4, attachmentCount: 1, tableCount: 1, canExport: true },
    privacy: { hasRun: true, interrupted: false, findings: 0, criticalOrHigh: 0, unavailable: false },
    ...overrides,
  };
}

describe("VaultHealth", () => {
  beforeEach(() => {
    runHealthCheck.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a clean vault, actionable category links, and refreshes with a new read-only check", async () => {
    runHealthCheck.mockResolvedValue(snapshot());
    const { getByTestId } = render(<VaultHealth />);

    await waitFor(() => expect(getByTestId("text-health-verdict").textContent).toContain("healthy"));
    expect(getByTestId("card-health-integrity-link").getAttribute("href")).toBe("/database-doctor");
    expect(getByTestId("card-health-conflicts-link").getAttribute("href")).toBe("/conflict-resolution");
    expect(getByTestId("card-health-ownership-link").getAttribute("href")).toBe("/resolve-ownership");
    expect(getByTestId("card-health-sync-link").getAttribute("href")).toBe("/transaction-sync");
    expect(getByTestId("card-health-backup-link").getAttribute("href")).toBe("/export");
    expect(getByTestId("card-health-privacy-link").getAttribute("href")).toBe("/privacy-audit");

    fireEvent.click(getByTestId("button-refresh-health"));
    await waitFor(() => expect(runHealthCheck).toHaveBeenCalledTimes(2));
  });

  it("shows failed and cancelled checks without claiming that a repair ran", async () => {
    runHealthCheck.mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    const { getByTestId, queryByTestId } = render(<VaultHealth />);
    await waitFor(() => expect(getByTestId("banner-health-error").textContent).toContain("IndexedDB unavailable"));
    expect(getByTestId("card-health-summary-failed").textContent).toContain("No repair was attempted");

    runHealthCheck.mockImplementationOnce(({ signal, onProgress }: any) => {
      onProgress?.({ phase: "Checking a large vault…", processed: 1000, total: 5000 });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new VaultHealthCancelledError()), { once: true });
      });
    });
    fireEvent.click(getByTestId("button-refresh-health"));
    await waitFor(() => expect(getByTestId("button-cancel-health-check")).toBeTruthy());
    expect(getByTestId("text-health-progress").textContent).toContain("1,000 of 5,000");
    fireEvent.click(getByTestId("button-cancel-health-check"));
    await waitFor(() => expect(getByTestId("card-health-summary-cancelled")).toBeTruthy());
    expect(queryByTestId("banner-health-error")).toBeNull();
  });

  it("surfaces warning and problem category states from a completed check", async () => {
    runHealthCheck.mockResolvedValue(
      snapshot({
        integrity: { totalRecords: 4, lockedUnreadable: 1, blankIdentifiers: 1, tableErrors: 0 },
        metadata: { ...snapshot().metadata, missingTier: 2 },
        conflicts: { records: 2, fields: 3 },
      }),
    );
    const { getByTestId } = render(<VaultHealth />);
    await waitFor(() => expect(getByTestId("text-health-verdict").textContent).toContain("has problems"));
    expect(getByTestId("card-health-integrity").textContent).toContain("Problem found");
    expect(getByTestId("card-health-metadata").textContent).toContain("Needs attention");
    expect(getByTestId("card-health-conflicts").textContent).toContain("2");
    expect(getByTestId("card-health-conflicts").textContent).toContain("affected records");
  });

  it("shows unresolved ownership aging without treating suggestions as decisions", async () => {
    runHealthCheck.mockResolvedValue(snapshot({
      ownership: { unresolved: 4, under7Days: 1, sevenToThirtyDays: 1, over30Days: 2, unknownAge: 0, unavailable: false },
    }));
    const { getByTestId } = render(<VaultHealth />);

    await waitFor(() => expect(getByTestId("card-health-ownership")).toBeTruthy());
    expect(getByTestId("card-health-ownership").textContent).toContain("Needs attention");
    expect(getByTestId("card-health-ownership").textContent).toContain("over 30 days");
    expect(getByTestId("card-health-ownership").textContent).toContain("Suggestions and legacy labels do not resolve");
  });

  it("shows free space and a headroom warning for a destination", async () => {
    const estimated = 512 * 1024 * 1024;
    runHealthCheck.mockResolvedValue(snapshot({
      backup: {
        ...snapshot().backup,
        scheduledEnabled: true,
        destinations: ["Removable backup"],
        destinationAvailable: [true],
        destinationFreeBytes: [estimated],
        destinationFreeSpaceHistory: [[
          { at: new Date("2026-09-01T00:00:00Z").getTime(), freeBytes: estimated + 256 * 1024 * 1024 },
          { at: new Date("2026-09-03T00:00:00Z").getTime(), freeBytes: estimated },
        ]],
        destinationCapacityWarning: [true],
        estimatedNextFullBackupBytes: estimated - 1,
        backupCapacityThresholdBytes: estimated + BACKUP_CAPACITY_SAFETY_MARGIN_BYTES,
        verifiedCopyCounts: [2],
        invalidCopyCounts: [0],
      },
    }));
    const { getByTestId } = render(<VaultHealth />);
    await waitFor(() => expect(getByTestId("text-health-verdict").textContent).toContain("needs attention"));
    expect(getByTestId("backup-free-space-0").textContent).toContain("Free:");
    expect(getByTestId("backup-free-space-trend-0").textContent).toContain("decreasing");
    expect(getByTestId("backup-free-space-trend-0").textContent).toContain("/day");
    expect(getByTestId("backup-capacity-warning-0").textContent).toContain("Low space");
    expect(getByTestId("backup-capacity-warning").textContent).toContain("safety margin");
  });

  it("keeps a saved free-space trend visible while a destination is unavailable", async () => {
    runHealthCheck.mockResolvedValue(snapshot({
      backup: {
        ...snapshot().backup,
        scheduledEnabled: true,
        destinations: ["Disconnected drive"],
        destinationAvailable: [false],
        destinationFreeSpaceHistory: [[
          { at: 1, freeBytes: 900 * 1024 * 1024 },
          { at: 2, freeBytes: 800 * 1024 * 1024 },
        ]],
        verifiedCopyCounts: [0],
        invalidCopyCounts: [0],
        destinationFailures: [{ at: 2, message: "Drive disconnected" }],
      },
    }));
    const { getByTestId } = render(<VaultHealth />);
    await waitFor(() => expect(getByTestId("backup-free-space-trend-0")).toBeTruthy());
    expect(getByTestId("backup-free-space-trend-0").textContent).toContain("decreasing");
    expect(getByTestId("card-health-backup").textContent).toContain("Drive disconnected");
  });
});