// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { VaultHealthSnapshot } from "@/lib/vault-health";

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
});