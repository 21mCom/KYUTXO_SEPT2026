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

const analyzeV3Backup = vi.fn();
vi.mock("@/lib/backup/analyze", () => ({
  analyzeV3Backup: (...args: unknown[]) => analyzeV3Backup(...args),
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
  app: "KYUTXO",
  appVersion: "3.0.0-legacy",
  encrypted: false,
  exportDate: "2026-07-30T00:00:00.000Z",
  counts: { records: 5 },
  streamedTables: [],
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

// A merge-analysis result shape the REAL dialog renders: per-table counts plus
// the addable-records CSV report (parts/rowCount).
function makeAnalysisResult(rowCount: number) {
  const zero = { total: 0, added: 0, alreadyPresent: 0 };
  return {
    manifest: V3_MANIFEST,
    tables: {
      records: { total: 5, added: rowCount, alreadyPresent: 1, discoveryOnlySkipped: 1 },
      attachments: { ...zero, orphanedSkipped: 0 },
      transactionParticipants: { ...zero },
      addressSyncState: { ...zero },
      blockchainTransactions: { total: 2, added: 2, alreadyPresent: 0 },
      utxoLineage: { ...zero },
      custodySegments: { ...zero },
      lineageSnapshots: { ...zero },
    },
    inline: {
      tags: { ...zero },
      categories: { ...zero },
      owners: { ...zero },
      walletNames: { ...zero },
      seedNames: { ...zero },
      walletSoftware: { ...zero },
      customFields: { ...zero },
      derivationTemplates: { ...zero },
      recordOrigins: { ...zero, orphanedSkipped: 0 },
      evidence: { ...zero },
      priceData: { ...zero },
      dustFlags: { ...zero },
      savedPsbts: { ...zero },
    },
    report: { parts: ["Type,Identifier,Label\r\n"], rowCount },
  };
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

describe("merge analysis (read-only preview)", () => {
  beforeEach(() => {
    // Self-sufficient setup: never rely on mock state from the sibling
    // describe (call counts must not accumulate across its tests).
    vi.clearAllMocks();
    peekManifest.mockResolvedValue(V3_MANIFEST);
    restoreV3Backup.mockResolvedValue(RESTORE_RESULT);
    analyzeV3Backup.mockResolvedValue(makeAnalysisResult(3));
  });

  afterEach(() => {
    cleanup();
  });

  it("offers Analyze for v3 backups and renders per-table results + CSV download", async () => {
    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());

    expect(screen.getByTestId("merge-analysis-section")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-analyze-merge"));

    await waitFor(() => {
      expect(analyzeV3Backup).toHaveBeenCalledTimes(1);
    });
    // Read-only pipeline: no attachment writer, and a cancel signal is wired.
    expect(analyzeV3Backup.mock.calls[0][0]).toMatchObject({
      source: expect.anything(),
      signal: expect.anything(),
    });
    expect(analyzeV3Backup.mock.calls[0][0].attachmentWriter).toBeUndefined();

    await waitFor(() => {
      expect(screen.queryByTestId("analysis-results")).toBeTruthy();
    });
    const recordsRow = screen.getByTestId("analysis-row-records");
    expect(recordsRow.textContent).toContain("3 new");
    expect(recordsRow.textContent).toContain("1 already present");
    expect(recordsRow.textContent).toContain("1 discovery-only");
    expect(screen.getByTestId("analysis-row-blockchainTransactions").textContent).toContain(
      "2 new",
    );
    // Tables with no rows in the backup are not listed.
    expect(screen.queryByTestId("analysis-row-attachments")).toBeNull();

    const csvButton = screen.getByTestId("button-download-analysis-csv") as HTMLButtonElement;
    expect(csvButton.disabled).toBe(false);
    expect(csvButton.textContent).toContain("3 new records");
  });

  it("keeps the CSV download disabled when nothing would be added", async () => {
    analyzeV3Backup.mockResolvedValue(makeAnalysisResult(0));
    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());

    fireEvent.click(screen.getByTestId("button-analyze-merge"));
    await waitFor(() => {
      expect(screen.queryByTestId("analysis-results")).toBeTruthy();
    });
    const csvButton = screen.getByTestId("button-download-analysis-csv") as HTMLButtonElement;
    expect(csvButton.disabled).toBe(true);
  });

  it("surfaces analysis failures with the pre-flight messaging style", async () => {
    analyzeV3Backup.mockRejectedValue(new Error("Invalid password or corrupted backup"));
    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());

    fireEvent.click(screen.getByTestId("button-analyze-merge"));
    await waitFor(() => {
      expect(analyzeV3Backup).toHaveBeenCalledTimes(1);
    });
    // No results render; the dialog stays on the configure stage.
    await waitFor(() => {
      expect(screen.queryByTestId("analysis-results")).toBeNull();
    });
    expect(screen.queryByTestId("button-continue-restore")).toBeTruthy();
  });
});
