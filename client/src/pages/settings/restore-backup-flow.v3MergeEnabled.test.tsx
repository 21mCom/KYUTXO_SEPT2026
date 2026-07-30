// @vitest-environment jsdom
//
// Guards the restore dialog's "Merge with existing" choice for v3 (new-format)
// backups. restoreV3Backup now supports a real merge mode (restoreMode:
// "merge"), so the dialog must:
//   1. Keep the Merge radio SELECTABLE when a v3 backup is chosen (it used to
//      be disabled while the pipeline was replace-only) and never show the old
//      "merge unavailable" explanation.
//   2. Pass the selected mode through to restoreV3Backup — "merge" when Merge
//      is chosen, "replace" by default — so the user's choice actually reaches
//      the pipeline.
//
// peekManifest is mocked (the real streaming peek needs real ZIP bytes); the
// REAL isV3Manifest classifies its return value, so the manifest shapes here
// must match what the format module actually accepts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const peekManifest = vi.fn();
const restoreV3Backup = vi.fn();
vi.mock("@/lib/backup/restore", () => ({
  peekManifest: (...args: unknown[]) => peekManifest(...args),
  restoreV3Backup: (...args: unknown[]) => restoreV3Backup(...args),
  evaluateDiskSpace: vi.fn(),
  RestoreInterruptedError: class RestoreInterruptedError extends Error {},
  AttachmentWriteError: class AttachmentWriteError extends Error {},
}));

vi.mock("@/lib/backup/restore-attachment-writer", () => ({
  createRestoreAttachmentWriter: () => ({ write: async () => {} }),
}));

vi.mock("@/lib/backup/post-restore-backfill", () => ({
  runPostRestoreTxidBackfill: vi.fn(async () => ({ suffix: "", orphansFound: false })),
}));

vi.mock("@/lib/backup/legacy-restore-pipeline", () => ({
  runLegacyJsonRestore: vi.fn(),
}));

vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: vi.fn(async () => null),
  updateSettings: vi.fn(async () => {}),
}));

vi.mock("@/lib/data/entity-list-store", () => ({
  loadEntitySnapshotFromStorage: vi.fn(async () => {}),
}));

vi.mock("@/lib/orphan-check-session", () => ({
  resetOrphanCheckGate: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  isElectron: () => false,
  getElectronAPI: () => ({}),
}));

import { RestoreBackupFlow } from "./restore-backup-flow";

// A manifest shape the REAL isV3Manifest accepts (formatVersion === 3). No
// `inline` payload, so the prepare stage's parseInline returns {}.
const V3_MANIFEST = {
  formatVersion: 3,
  encrypted: false,
  exportDate: "2026-07-30T00:00:00.000Z",
  counts: { records: 5 },
};

const RESTORE_RESULT = {
  manifest: V3_MANIFEST,
  counts: {
    records: 5,
    attachments: 0,
    transactionParticipants: 0,
    addressSyncState: 0,
    blockchainTransactions: 0,
    utxoLineage: 0,
    custodySegments: 0,
    lineageSnapshots: 0,
    attachmentFiles: 0,
    orphanedAttachmentFiles: 0,
    orphanedAttachmentFilesLost: 0,
  },
};

function makeV3ZipFile(): File {
  // Contents never parsed — peekManifest is mocked; only the File object matters.
  return new File([new Uint8Array([0x50, 0x4b])], "v3-backup.zip", {
    type: "application/zip",
  });
}

async function openDialogAndSelectFile(file: File): Promise<void> {
  fireEvent.click(screen.getByTestId("button-open-restore"));
  const input = screen.getByTestId("input-restore-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => {
    // Backup info card renders only after the file was successfully read.
    expect(screen.queryByText("Backup Date:")).toBeTruthy();
  });
}

// Drive the two-stage flow to the point where restoreV3Backup is invoked.
async function continueAndRestore(): Promise<void> {
  fireEvent.click(screen.getByTestId("button-continue-restore"));
  await waitFor(() => {
    expect(screen.queryByTestId("button-confirm-restore")).toBeTruthy();
  });
  fireEvent.click(screen.getByTestId("button-confirm-restore"));
  await waitFor(() => {
    expect(restoreV3Backup).toHaveBeenCalledTimes(1);
  });
}

const originalLocation = window.location;

describe("restore dialog merge option for v3 backups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    peekManifest.mockResolvedValue(V3_MANIFEST);
    restoreV3Backup.mockResolvedValue(RESTORE_RESULT);
    // The success path schedules window.location.reload(); jsdom's reload is
    // non-configurable, so replace window.location wholesale with a spy-backed
    // plain object.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: vi.fn() },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("keeps Merge selectable for v3 backups and shows no 'unavailable' notice", async () => {
    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());

    const merge = screen.getByTestId("radio-merge");
    expect(merge.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("text-merge-unavailable-v3")).toBeNull();

    fireEvent.click(merge);
    await waitFor(() => {
      expect(merge.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("passes restoreMode 'merge' through to restoreV3Backup when Merge is selected", async () => {
    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());

    fireEvent.click(screen.getByTestId("radio-merge"));
    await waitFor(() => {
      expect(screen.getByTestId("radio-merge").getAttribute("aria-checked")).toBe("true");
    });

    await continueAndRestore();
    expect(restoreV3Backup.mock.calls[0][0]).toMatchObject({ restoreMode: "merge" });
  });

  it("passes restoreMode 'replace' by default", async () => {
    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());
    expect(screen.getByTestId("radio-replace").getAttribute("aria-checked")).toBe("true");

    await continueAndRestore();
    expect(restoreV3Backup.mock.calls[0][0]).toMatchObject({ restoreMode: "replace" });
  });
});
