// @vitest-environment jsdom
//
// Component test for the evidence package builder's explicit opt-in
// streaming-to-disk toggle (Task #2116). Exercises the branching in
// handleExport WITHOUT a real Dexie database or File System Access API:
// every CRUD/library seam is stubbed so the test proves the WIRING —
// which build function gets called, with what sink, and how success /
// cancellation / unsupported-environment states are surfaced — while the
// actual streaming mechanics are covered by evidence-package-export.test.ts
// and the real-browser check.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    // EvidencePackageBuilder's only useLiveQuery call is getAllEvidence();
    // resolve it synchronously enough for the tests below (empty list — the
    // tests select nothing via the evidence checklist and instead exercise
    // the record-ID path so an evidence live-query result isn't needed).
    void fn();
    return [];
  },
}));

vi.mock("@/lib/data/evidence-crud", () => ({
  getAllEvidence: vi.fn(async () => []),
  getEvidenceAttachmentsByEvidenceId: vi.fn(async () => []),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByIds: vi.fn(async (ids: number[]) => ids.map((id) => ({ id, type: "address", inputString: `addr-${id}`, tags: [], categories: [], createdAt: 1, updatedAt: 1 }))),
}));

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsByTxids: vi.fn(async () => []),
  getParticipantsByTxids: vi.fn(async () => []),
}));

vi.mock("@/lib/data/lineage-crud", () => ({
  getCustodySegmentsBySegmentIds: vi.fn(async () => []),
  getLineageSnapshotsBySnapshotIds: vi.fn(async () => []),
  getUtxoLineageByOutpoints: vi.fn(async () => []),
}));

vi.mock("@/lib/attachments", () => ({
  getFileBlob: vi.fn(async () => new Uint8Array()),
}));

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const { buildEvidencePackageMock, buildEvidencePackageToSinkMock } = vi.hoisted(() => ({
  buildEvidencePackageMock: vi.fn(),
  buildEvidencePackageToSinkMock: vi.fn(),
}));
vi.mock("@/lib/evidence-package-export", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/evidence-package-export")>();
  return {
    ...original,
    buildEvidencePackage: (...args: unknown[]) => buildEvidencePackageMock(...args),
    buildEvidencePackageToSink: (...args: unknown[]) => buildEvidencePackageToSinkMock(...args),
  };
});

const { downloadBlobMock, openElectronFileSinkMock, openFileSystemSinkMock } = vi.hoisted(() => ({
  downloadBlobMock: vi.fn(),
  openElectronFileSinkMock: vi.fn(),
  openFileSystemSinkMock: vi.fn(),
}));
let mockSupportsElectronBackup = false;
let mockSupportsFileSystemAccess = false;
vi.mock("@/lib/backup/sink", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/backup/sink")>();
  return {
    ...original,
    downloadBlob: downloadBlobMock,
    openElectronFileSink: (...args: unknown[]) => openElectronFileSinkMock(...args),
    openFileSystemSink: (...args: unknown[]) => openFileSystemSinkMock(...args),
    supportsElectronBackup: () => mockSupportsElectronBackup,
    supportsFileSystemAccess: () => mockSupportsFileSystemAccess,
  };
});

let mockIsElectron = false;
vi.mock("@/lib/electron", () => ({
  isElectron: () => mockIsElectron,
}));

import { EvidencePackageBuilder } from "./EvidencePackageBuilder";
import { BackupCancelledError } from "@/lib/backup/sink";

function enterRecordId() {
  fireEvent.change(screen.getByTestId("input-package-record-ids"), { target: { value: "4" } });
}

describe("EvidencePackageBuilder streaming toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsElectron = false;
    mockSupportsElectronBackup = false;
    mockSupportsFileSystemAccess = false;
    buildEvidencePackageMock.mockResolvedValue({
      blob: new Blob(["zip"]),
      manifest: { generatedAt: 1700000000000, files: [{}], counts: { attachments: 0 } },
      reportHtml: "<html></html>",
    });
    buildEvidencePackageToSinkMock.mockResolvedValue({
      manifest: { generatedAt: 1700000000000, files: [{}], counts: { attachments: 0 } },
      reportHtml: "<html></html>",
    });
  });

  afterEach(() => cleanup());

  it("disables the streaming toggle when no streaming-to-disk destination is available", () => {
    render(<EvidencePackageBuilder />);
    const toggle = screen.getByTestId("switch-package-stream-to-disk");
    expect(toggle.getAttribute("data-disabled") ?? toggle.getAttribute("disabled")).not.toBeNull();
    expect(screen.getByTestId("text-package-stream-description").textContent).toMatch(/Unavailable/);
  });

  it("enables the toggle when the File System Access API is available and streams via that sink", async () => {
    mockSupportsFileSystemAccess = true;
    const fakeSink = { write: vi.fn(), drain: vi.fn(), close: vi.fn(), abort: vi.fn() };
    openFileSystemSinkMock.mockResolvedValue(fakeSink);

    render(<EvidencePackageBuilder />);
    const toggle = screen.getByTestId("switch-package-stream-to-disk");
    expect(toggle.getAttribute("data-disabled")).toBeNull();
    expect(toggle.getAttribute("disabled")).toBeNull();
    fireEvent.click(toggle);

    enterRecordId();
    fireEvent.click(screen.getByTestId("button-export-evidence-package"));

    await waitFor(() => expect(buildEvidencePackageToSinkMock).toHaveBeenCalledTimes(1));
    expect(openElectronFileSinkMock).not.toHaveBeenCalled();
    expect(buildEvidencePackageMock).not.toHaveBeenCalled();
    expect(downloadBlobMock).not.toHaveBeenCalled();
    // The sink handed to the streaming builder is the one the picker opened.
    expect(buildEvidencePackageToSinkMock.mock.calls[0][2]).toBe(fakeSink);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Evidence package exported",
      description: expect.stringContaining("saved to"),
    })));
  });

  it("prefers the Electron backup bridge over File System Access when both are available", async () => {
    mockIsElectron = true;
    mockSupportsElectronBackup = true;
    mockSupportsFileSystemAccess = true;
    const fakeSink = { write: vi.fn(), drain: vi.fn(), close: vi.fn(), abort: vi.fn() };
    openElectronFileSinkMock.mockResolvedValue(fakeSink);

    render(<EvidencePackageBuilder />);
    fireEvent.click(screen.getByTestId("switch-package-stream-to-disk"));
    enterRecordId();
    fireEvent.click(screen.getByTestId("button-export-evidence-package"));

    await waitFor(() => expect(buildEvidencePackageToSinkMock).toHaveBeenCalledTimes(1));
    expect(openElectronFileSinkMock).toHaveBeenCalledTimes(1);
    expect(openFileSystemSinkMock).not.toHaveBeenCalled();
  });

  it("silently stops (no error toast) when the user dismisses the save dialog", async () => {
    mockSupportsFileSystemAccess = true;
    openFileSystemSinkMock.mockRejectedValue(new BackupCancelledError());

    render(<EvidencePackageBuilder />);
    fireEvent.click(screen.getByTestId("switch-package-stream-to-disk"));
    enterRecordId();
    fireEvent.click(screen.getByTestId("button-export-evidence-package"));

    await waitFor(() => expect(openFileSystemSinkMock).toHaveBeenCalledTimes(1));
    expect(buildEvidencePackageToSinkMock).not.toHaveBeenCalled();
    // No completion or failure toast — a dismissed dialog is a silent no-op.
    expect(toastMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((screen.getByTestId("button-export-evidence-package") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("aborts and surfaces a failure toast (not a success) when the streamed build throws", async () => {
    mockSupportsFileSystemAccess = true;
    const fakeSink = { write: vi.fn(), drain: vi.fn(), close: vi.fn(), abort: vi.fn() };
    openFileSystemSinkMock.mockResolvedValue(fakeSink);
    buildEvidencePackageToSinkMock.mockRejectedValue(new Error("disk full"));

    render(<EvidencePackageBuilder />);
    fireEvent.click(screen.getByTestId("switch-package-stream-to-disk"));
    enterRecordId();
    fireEvent.click(screen.getByTestId("button-export-evidence-package"));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Evidence package failed",
      variant: "destructive",
    })));
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("still uses the in-memory build + download path when the toggle is off", async () => {
    mockSupportsFileSystemAccess = true; // supported, but not opted in

    render(<EvidencePackageBuilder />);
    enterRecordId();
    fireEvent.click(screen.getByTestId("button-export-evidence-package"));

    await waitFor(() => expect(buildEvidencePackageMock).toHaveBeenCalledTimes(1));
    expect(buildEvidencePackageToSinkMock).not.toHaveBeenCalled();
    expect(openFileSystemSinkMock).not.toHaveBeenCalled();
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
  });
});
