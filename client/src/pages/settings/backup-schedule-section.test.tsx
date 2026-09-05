// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackupScheduleSettings } from "@/lib/db-types";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  mutateSettings: vi.fn(),
  cancelActiveScheduledBackup: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  getElectronAPISafe: () => undefined,
  isElectron: () => true,
}));

vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: mocks.getSettings,
  mutateSettings: mocks.mutateSettings,
}));

vi.mock("@/lib/backup/scheduled", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backup/scheduled")>();
  return {
    ...actual,
    cancelActiveScheduledBackup: mocks.cancelActiveScheduledBackup,
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast, dismiss: vi.fn(), toasts: [] }),
}));

const { BackupScheduleSection } = await import("./backup-schedule-section");

const DESTINATION = {
  token: "a".repeat(32),
  label: "Primary drive",
  path: "/backups/primary",
};
const RETAINED_DESTINATION = {
  token: "b".repeat(32),
  label: "Secondary drive",
  path: "/backups/secondary",
};

const configuredSchedule: BackupScheduleSettings = {
  enabled: true,
  cadenceDays: 7,
  retentionCount: 5,
  promptBehavior: "automatic",
  compact: false,
  encrypted: false,
  destinations: [DESTINATION, RETAINED_DESTINATION],
};

beforeEach(() => {
  mocks.getSettings.mockReset().mockResolvedValue({
    id: "default",
    backupSchedule: configuredSchedule,
  });
  mocks.mutateSettings.mockReset();
  mocks.cancelActiveScheduledBackup.mockReset();
  mocks.toast.mockReset();
});

afterEach(() => {
  cleanup();
});

async function renderConfiguredSchedule() {
  render(<BackupScheduleSection />);
  await screen.findByText(DESTINATION.path);
}

describe("backup destination cancellation", () => {
  it("does not cancel an active backup for an unsaved removal, then cancels exactly once after persistence succeeds", async () => {
    let finishSave!: (value: { backupSchedule: BackupScheduleSettings }) => void;
    const saveHeld = new Promise<{ backupSchedule: BackupScheduleSettings }>((resolve) => {
      finishSave = resolve;
    });

    mocks.mutateSettings.mockImplementation(async (_id, updater) => {
      const update = updater({ backupSchedule: configuredSchedule });
      const backupSchedule = update.backupSchedule as BackupScheduleSettings;
      return saveHeld.then(() => ({ backupSchedule }));
    });

    await renderConfiguredSchedule();
    fireEvent.click(screen.getByRole("button", { name: `Remove ${DESTINATION.label}` }));

    expect(screen.queryByText(DESTINATION.path)).toBeNull();
    expect(mocks.cancelActiveScheduledBackup).not.toHaveBeenCalled();
    expect(mocks.mutateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("button-save-backup-schedule"));

    await waitFor(() => expect(mocks.mutateSettings).toHaveBeenCalledTimes(1));
    expect(mocks.cancelActiveScheduledBackup).not.toHaveBeenCalled();

    finishSave({
      backupSchedule: { ...configuredSchedule, destinations: [RETAINED_DESTINATION] },
    });

    await waitFor(() => {
      expect(mocks.cancelActiveScheduledBackup).toHaveBeenCalledTimes(1);
      expect(mocks.cancelActiveScheduledBackup).toHaveBeenCalledWith(DESTINATION.token);
    });
  });

  it("does not cancel an active backup when saving the removal fails", async () => {
    mocks.mutateSettings.mockImplementation(async (_id, updater) => {
      updater({ backupSchedule: configuredSchedule });
      throw new Error("settings write failed");
    });

    await renderConfiguredSchedule();
    fireEvent.click(screen.getByRole("button", { name: `Remove ${DESTINATION.label}` }));
    fireEvent.click(screen.getByTestId("button-save-backup-schedule"));

    await waitFor(() => expect(mocks.mutateSettings).toHaveBeenCalledTimes(1));
    expect(mocks.cancelActiveScheduledBackup).not.toHaveBeenCalled();
  });
});