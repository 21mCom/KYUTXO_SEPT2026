// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Gate value returned by the mocked useLiveQuery (the real hook would run a
// Dexie live query; here we drive it directly per test case).
let liveCount: number | undefined;

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveCount,
}));

// Fully mock the CRUD module so the real Dexie database is never imported.
vi.mock("@/lib/data/record-crud", () => ({
  countRecords: vi.fn(async () => 0),
}));

const peekManifest = vi.fn();
const restoreV3Backup = vi.fn();
vi.mock("@/lib/backup/restore", () => ({
  peekManifest: (...args: unknown[]) => peekManifest(...args),
  restoreV3Backup: (...args: unknown[]) => restoreV3Backup(...args),
  RestoreInterruptedError: class RestoreInterruptedError extends Error {},
}));

vi.mock("@/lib/backup/zip-stream", () => ({
  blobChunks: (file: unknown) => file,
}));

const isV3Manifest = vi.fn();
vi.mock("@/lib/backup/format", () => ({
  isV3Manifest: (...args: unknown[]) => isV3Manifest(...args),
}));

vi.mock("@/lib/backup/restore-attachment-writer", () => ({
  createRestoreAttachmentWriter: () => ({}),
}));

const runPostRestoreTxidBackfill = vi.fn(async () => ({ suffix: "", orphansFound: false }));
vi.mock("@/lib/backup/post-restore-backfill", () => ({
  runPostRestoreTxidBackfill: (...args: unknown[]) => runPostRestoreTxidBackfill(...args),
}));

const resetOrphanCheckGate = vi.fn();
vi.mock("@/lib/orphan-check-session", () => ({
  resetOrphanCheckGate: (...args: unknown[]) => resetOrphanCheckGate(...args),
}));

import { DemoVaultLoader } from "./DemoVaultLoader";

// jsdom's location.reload is non-configurable — replace window.location
// wholesale with a plain object carrying a reload spy.
const reloadSpy = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).location;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).location = { ...originalLocation, reload: reloadSpy };
});

afterEach(() => {
  cleanup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).location = originalLocation;
});

function pickFile() {
  const input = screen.getByTestId("input-demo-vault-file");
  const file = new File(["zipbytes"], "kyutxo-demo-vault.zip", { type: "application/zip" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("DemoVaultLoader", () => {
  it("renders nothing while the record count is loading", () => {
    liveCount = undefined;
    render(<DemoVaultLoader />);
    expect(screen.queryByTestId("demo-vault-loader")).toBeNull();
  });

  it("renders nothing when the vault already has records", () => {
    liveCount = 3;
    render(<DemoVaultLoader />);
    expect(screen.queryByTestId("demo-vault-loader")).toBeNull();
  });

  it("runs the v3 restore path and reloads when a plaintext v3 zip is picked", async () => {
    liveCount = 0;
    peekManifest.mockResolvedValue({ formatVersion: 3, encrypted: false });
    isV3Manifest.mockReturnValue(true);
    restoreV3Backup.mockResolvedValue({
      counts: { records: 4500, blockchainTransactions: 700 },
    });

    render(<DemoVaultLoader />);
    expect(screen.getByTestId("button-load-demo-vault")).toBeTruthy();
    pickFile();

    await waitFor(() => expect(restoreV3Backup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runPostRestoreTxidBackfill).toHaveBeenCalledTimes(1));
    expect(resetOrphanCheckGate).toHaveBeenCalled();
    await waitFor(() => expect(reloadSpy).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("refuses encrypted backups without touching the vault", async () => {
    liveCount = 0;
    peekManifest.mockResolvedValue({ formatVersion: 3, encrypted: true });
    isV3Manifest.mockReturnValue(true);

    render(<DemoVaultLoader />);
    pickFile();

    await waitFor(() => expect(peekManifest).toHaveBeenCalledTimes(1));
    expect(restoreV3Backup).not.toHaveBeenCalled();
    // Button returns to idle so the user can pick another file.
    await waitFor(() =>
      expect(
        (screen.getByTestId("button-load-demo-vault") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("refuses non-v3 zips without touching the vault", async () => {
    liveCount = 0;
    peekManifest.mockResolvedValue({});
    isV3Manifest.mockReturnValue(false);

    render(<DemoVaultLoader />);
    pickFile();

    await waitFor(() => expect(peekManifest).toHaveBeenCalledTimes(1));
    expect(restoreV3Backup).not.toHaveBeenCalled();
  });

  it("surfaces restore failures and re-enables the button", async () => {
    liveCount = 0;
    peekManifest.mockResolvedValue({ formatVersion: 3, encrypted: false });
    isV3Manifest.mockReturnValue(true);
    restoreV3Backup.mockRejectedValue(new Error("boom"));

    render(<DemoVaultLoader />);
    pickFile();

    await waitFor(() => expect(restoreV3Backup).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByTestId("button-load-demo-vault") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
