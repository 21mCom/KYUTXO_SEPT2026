// @vitest-environment jsdom
//
// Guards the restore dialog's "Merge with existing" choice against the v3
// streaming restore path, which is replace-only (restoreV3Backup always clears
// the vault and never reads restoreMode). Before this guard a user could pick
// "Merge" on a v3 backup and have their existing data silently wiped — the
// opposite of what the UI promised.
//
//   1. Selecting a v3 backup disables the Merge radio, shows the explanation,
//      and forces the mode back to "Replace all data" even when Merge was
//      selected for a previously-chosen legacy file.
//   2. Selecting a legacy backup keeps Merge selectable (that path honors it).
//
// peekManifest is mocked (the real streaming peek needs real ZIP bytes); the
// REAL isV3Manifest classifies its return value, so the manifest shapes here
// must match what the format module actually accepts. The legacy case feeds a
// REAL JSZip archive because the legacy branch re-reads the file via JSZip.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import JSZip from "jszip";

const peekManifest = vi.fn();
vi.mock("@/lib/backup/restore", () => ({
  peekManifest: (...args: unknown[]) => peekManifest(...args),
  restoreV3Backup: vi.fn(),
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

// A manifest shape the REAL isV3Manifest accepts (formatVersion === 3).
const V3_MANIFEST = {
  formatVersion: 3,
  encrypted: false,
  exportDate: "2026-07-30T00:00:00.000Z",
  counts: { records: 5 },
};

async function makeLegacyZipFile(): Promise<File> {
  const zip = new JSZip();
  zip.file(
    "backup.json",
    JSON.stringify({
      encrypted: false,
      exportDate: "2026-07-30T00:00:00.000Z",
      data: { records: [], settings: [] },
    }),
  );
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], "legacy-backup.zip", { type: "application/zip" });
}

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

describe("restore dialog merge option vs v3 backups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("disables Merge with an explanation when a v3 backup is selected", async () => {
    peekManifest.mockResolvedValue(V3_MANIFEST);
    render(<RestoreBackupFlow />);

    await openDialogAndSelectFile(makeV3ZipFile());

    const merge = screen.getByTestId("radio-merge");
    expect(merge.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("text-merge-unavailable-v3").textContent).toMatch(
      /always replace all existing data/i,
    );
    // Replace stays the selected mode.
    expect(screen.getByTestId("radio-replace").getAttribute("aria-checked")).toBe("true");
    expect(merge.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps Merge selectable for legacy backups (which honor it)", async () => {
    peekManifest.mockResolvedValue(null); // not a v3 manifest → legacy path
    render(<RestoreBackupFlow />);

    await openDialogAndSelectFile(await makeLegacyZipFile());

    const merge = screen.getByTestId("radio-merge");
    expect(merge.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("text-merge-unavailable-v3")).toBeNull();

    fireEvent.click(merge);
    await waitFor(() => {
      expect(merge.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("forces a stale Merge selection back to Replace when a v3 file replaces a legacy file", async () => {
    peekManifest.mockResolvedValue(null);
    render(<RestoreBackupFlow />);

    await openDialogAndSelectFile(await makeLegacyZipFile());
    fireEvent.click(screen.getByTestId("radio-merge"));
    await waitFor(() => {
      expect(screen.getByTestId("radio-merge").getAttribute("aria-checked")).toBe("true");
    });

    // Swap the selected file for a v3 backup: Merge must be disabled AND the
    // mode snapped back to Replace so the stale choice can't reach handleRestore.
    peekManifest.mockResolvedValue(V3_MANIFEST);
    const input = screen.getByTestId("input-restore-file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeV3ZipFile()] } });

    await waitFor(() => {
      expect(screen.getByTestId("radio-merge").hasAttribute("disabled")).toBe(true);
    });
    expect(screen.getByTestId("radio-replace").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("radio-merge").getAttribute("aria-checked")).toBe("false");
  });
});
