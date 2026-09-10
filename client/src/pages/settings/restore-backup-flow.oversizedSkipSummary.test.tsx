// @vitest-environment jsdom
//
// Guards the Settings restore flow's completion summary for OVERSIZED
// attachment skips — including the oversized ORPHANED (Needs Review) file
// case. A desktop merge restore now SKIPS an oversized orphaned file instead
// of failing, recording it in counts.skippedOversizedAttachmentFiles and
// skippedOversizedAttachments (restore.ts writeReview catch branch). The
// engine behavior is tested elsewhere; this proves the UI actually TELLS the
// user: the "Restore Successful" toast must carry the oversized warning that
// NAMES the skipped file, and the skip must not be silently absorbed by the
// generic orphaned-files notice (both messages must appear when both apply).
//
// Same harness pattern as restore-backup-flow.v3MergeEnabled.test.tsx:
// peekManifest/restoreV3Backup are mocked (the streaming pipeline needs real
// ZIP bytes) and the REAL RestoreBackupFlow builds the summary from the
// mocked RestoreResult. The toast is captured via a mocked useToast so the
// exact description string is asserted without rendering a Toaster.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import JSZip from "jszip";

const peekManifest = vi.fn();
const restoreV3Backup = vi.fn();
const runLegacyJsonRestore = vi.fn();
vi.mock("@/lib/backup/restore", () => ({
  peekManifest: (...args: unknown[]) => peekManifest(...args),
  restoreV3Backup: (...args: unknown[]) => restoreV3Backup(...args),
  evaluateDiskSpace: vi.fn(),
  RestoreInterruptedError: class RestoreInterruptedError extends Error {},
  AttachmentWriteError: class AttachmentWriteError extends Error {},
}));

vi.mock("@/lib/backup/analyze", () => ({
  analyzeV3Backup: vi.fn(),
}));

vi.mock("@/lib/backup/restore-attachment-writer", () => ({
  createRestoreAttachmentWriter: () => ({ write: async () => {} }),
}));

vi.mock("@/lib/backup/post-restore-backfill", () => ({
  runPostRestoreTxidBackfill: vi.fn(async () => ({ suffix: "", orphansFound: false })),
}));

vi.mock("@/lib/backup/legacy-restore-pipeline", () => ({
  runLegacyJsonRestore: (...args: unknown[]) => runLegacyJsonRestore(...args),
  assertLegacyBackupData: (data: unknown) => {
    if (!data || typeof data !== "object" ||
        !Array.isArray((data as { records?: unknown }).records)) {
      throw new Error("Invalid legacy backup data");
    }
  },
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

// Capture toast calls so the summary description can be asserted verbatim.
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { RestoreBackupFlow } from "./restore-backup-flow";

const V3_MANIFEST = {
  formatVersion: 3,
  app: "KYUTXO",
  appVersion: "3.0.0-legacy",
  encrypted: false,
  exportDate: "2026-08-01T00:00:00.000Z",
  counts: { records: 2 },
  streamedTables: [],
};

const BASE_COUNTS = {
  records: 2,
  attachments: 1,
  transactionParticipants: 0,
  addressSyncState: 0,
  blockchainTransactions: 0,
  recordOrigins: 0,
  utxoLineage: 0,
  custodySegments: 0,
  lineageSnapshots: 0,
  attachmentFiles: 1,
  orphanedAttachmentFiles: 0,
  orphanedAttachmentFilesLost: 0,
  rebuiltDiscoveredShells: 0,
  skippedOversizedAttachmentFiles: 0,
  droppedOversizedAttachmentRows: 0,
};

function makeV3ZipFile(): File {
  return new File([new Uint8Array([0x50, 0x4b])], "v3-backup.zip", {
    type: "application/zip",
  });
}

async function makeLegacyZipFile(): Promise<File> {
  const zip = new JSZip();
  zip.file(
    "backup.json",
    JSON.stringify({
      encrypted: false,
      exportDate: "2026-08-01T00:00:00.000Z",
      data: { records: [], settings: [] },
    }),
  );
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes], "legacy-backup.zip", { type: "application/zip" });
}

async function openDialogAndSelectFile(file: File): Promise<void> {
  fireEvent.click(screen.getByTestId("button-open-restore"));
  const input = screen.getByTestId("input-restore-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => {
    expect(screen.queryByText("Backup Date:")).toBeTruthy();
  });
}

async function selectMerge(): Promise<void> {
  fireEvent.click(screen.getByTestId("radio-merge"));
  await waitFor(() => {
    expect(screen.getByTestId("radio-merge").getAttribute("aria-checked")).toBe("true");
  });
}

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

function successToast(): { title: string; description: string } {
  const call = toastSpy.mock.calls.find(
    (c) => (c[0] as { title?: string }).title === "Restore Successful",
  );
  expect(call).toBeTruthy();
  return call![0] as { title: string; description: string };
}

const originalLocation = window.location;

describe("restore summary surfaces oversized attachment skips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    peekManifest.mockResolvedValue(V3_MANIFEST);
    // jsdom's location.reload is non-configurable; replace window.location
    // wholesale with a spy-backed plain object.
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

  it("includes restored lineage snapshots in the v3 success summary", async () => {
    restoreV3Backup.mockResolvedValue({
      manifest: V3_MANIFEST,
      counts: {
        ...BASE_COUNTS,
        lineageSnapshots: 2,
      },
    });

    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());
    await continueAndRestore();

    await waitFor(() => {
      expect(successToast().description).toContain(", 2 snapshots.");
    });
  });

  it("includes legacy snapshots in the success toast description", async () => {
    // The legacy pipeline folds the snapshotsAdded result from
    // restoreLegacySnapshots into baseMessage. Keep this test at the flow
    // boundary so that the toast cannot silently discard that summary text.
    peekManifest.mockResolvedValue(null);
    runLegacyJsonRestore.mockResolvedValue({
      baseMessage:
        "Restored 0 records, 0 tags, 0 categories, 0 vocabulary items, 0 templates, 2 snapshots.",
      orphanedFilesRouted: 0,
      orphanedFilesLost: 0,
    });

    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(await makeLegacyZipFile());

    fireEvent.click(screen.getByTestId("button-continue-restore"));
    await waitFor(() => {
      expect(screen.queryByTestId("button-confirm-restore")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("button-confirm-restore"));

    await waitFor(() => {
      expect(runLegacyJsonRestore).toHaveBeenCalledTimes(1);
    });
    expect(successToast().description).toContain(", 2 snapshots.");
  });

  it("reports only newly added snapshots for a legacy merge", async () => {
    // The real legacy pipeline is covered by its runtime test; this boundary
    // guard proves the selected merge mode and added-only baseMessage reach the
    // success toast without the flow inflating the count.
    peekManifest.mockResolvedValue(null);
    runLegacyJsonRestore.mockResolvedValue({
      baseMessage:
        "Added 0 records (0 skipped), 0 tags, 0 categories, 0 vocabulary items, 0 templates, 1 snapshot.",
      orphanedFilesRouted: 0,
      orphanedFilesLost: 0,
    });

    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(await makeLegacyZipFile());
    await selectMerge();

    fireEvent.click(screen.getByTestId("button-continue-restore"));
    await waitFor(() => {
      expect(screen.queryByTestId("button-confirm-restore")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("button-confirm-restore"));

    await waitFor(() => {
      expect(runLegacyJsonRestore).toHaveBeenCalledTimes(1);
      expect(successToast().description).toContain(", 1 snapshot.");
    });
    expect(runLegacyJsonRestore.mock.calls[0][2]).toBe("merge");
    expect(successToast().description).not.toContain(", 2 snapshots.");
  });

  it("names an oversized ORPHANED file in the merge summary alongside the orphaned-files notice", async () => {
    // A merge restore that met one orphaned attachment file which was ALSO
    // oversized: writeReview rejected it for size, so it is counted as an
    // orphan AND recorded as an oversized skip (never as a lost file).
    restoreV3Backup.mockResolvedValue({
      manifest: V3_MANIFEST,
      counts: {
        ...BASE_COUNTS,
        orphanedAttachmentFiles: 1,
        skippedOversizedAttachmentFiles: 1,
      },
      skippedOversizedAttachments: ["ab/cd/orphan-big.bin"],
    });

    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());
    await selectMerge();
    await continueAndRestore();

    await waitFor(() => {
      expect(
        toastSpy.mock.calls.some(
          (c) => (c[0] as { title?: string }).title === "Restore Successful",
        ),
      ).toBe(true);
    });
    const { description } = successToast();

    // The oversized skip is surfaced as an explicit warning NAMING the file…
    expect(description).toContain(
      "Warning: 1 attachment file exceeded the maximum size and was not restored: ab/cd/orphan-big.bin.",
    );
    // …and is NOT silently absorbed by the orphaned-files notice, which still
    // appears independently (the orphan count includes the oversized one).
    expect(description).toContain("1 attachment file could not be re-linked");
    expect(description).toContain('"Needs Review" section of Settings');
    // The file was skipped for size, not lost — no data-loss warning.
    expect(description).not.toContain("contents were lost");
  });

  it("names a regular oversized skip and reports dropped attachment rows", async () => {
    restoreV3Backup.mockResolvedValue({
      manifest: V3_MANIFEST,
      counts: {
        ...BASE_COUNTS,
        skippedOversizedAttachmentFiles: 1,
        droppedOversizedAttachmentRows: 1,
      },
      skippedOversizedAttachments: ["ab/cd/too-big.bin"],
    });

    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());
    await continueAndRestore();

    await waitFor(() => {
      expect(
        toastSpy.mock.calls.some(
          (c) => (c[0] as { title?: string }).title === "Restore Successful",
        ),
      ).toBe(true);
    });
    const { description } = successToast();
    expect(description).toContain(
      "Warning: 1 attachment file exceeded the maximum size and was not restored: ab/cd/too-big.bin.",
    );
    expect(description).toContain(
      "1 matching attachment entry was removed so no record points at a missing file.",
    );
  });

  it("shows no oversized warning when nothing was skipped", async () => {
    restoreV3Backup.mockResolvedValue({
      manifest: V3_MANIFEST,
      counts: { ...BASE_COUNTS },
      skippedOversizedAttachments: [],
    });

    render(<RestoreBackupFlow />);
    await openDialogAndSelectFile(makeV3ZipFile());
    await continueAndRestore();

    await waitFor(() => {
      expect(
        toastSpy.mock.calls.some(
          (c) => (c[0] as { title?: string }).title === "Restore Successful",
        ),
      ).toBe(true);
    });
    const { description } = successToast();
    expect(description).not.toContain("exceeded the maximum size");
  });
});
