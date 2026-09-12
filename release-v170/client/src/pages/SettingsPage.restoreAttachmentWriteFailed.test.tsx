// @vitest-environment jsdom
//
// Page-level coverage for the attachment-specific failure wiring when a v3
// restore fails on a bad attachment file (Task #918). SettingsPage's catch
// block has TWO post-clear branches: the generic "Restore Interrupted" toast
// (covered by SettingsPage.restoreInterrupted.test.tsx) and a DISTINCT branch
// that fires when a RestoreInterruptedError's `.cause` is an
// AttachmentWriteError. That branch shows a different toast ("Restore Failed —
// Couldn't Write Attachment") with attachment-specific guidance (the failed
// file's path, how many files were saved before the failure, and "run the
// restore again"). A regression in that instanceof wiring would silently fall
// through to the generic toast — or no toast — so the user would never learn
// WHICH file broke or what to do next.
//
// This drives the REAL restore dialog (open -> select file -> continue ->
// Restore Now) over a REAL v3 backup so handleFileSelect/handlePrepareRestore
// run their real peek/preview code. Only restoreV3Backup is stubbed to simulate
// a writer that fails mid-restore: it invokes the injected attachmentWriter
// (which fails via a mocked /api/attachments/write), then throws the same
// RestoreInterruptedError the real reset-to-empty path raises — but this time
// the cause is a REAL AttachmentWriteError, exactly as restore.ts wraps it.
// We then assert:
//   - the attachment-specific "Restore Failed — Couldn't Write Attachment"
//     toast appears (NOT the generic "Restore Interrupted" toast), naming the
//     failed file and how many files were saved before,
//   - the dialog/progress state is reset (not stuck mid-restore) and the page
//     reloads to reflect the now-empty vault.

import "fake-indexeddb/auto";

import JSZip from "jszip";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Hoisted spies so the mocked modules and the assertions share the same fns.
const { toastSpy, writerInvokedSpy } = vi.hoisted(() => ({
  toastSpy: vi.fn(),
  writerInvokedSpy: vi.fn(),
}));

// The failed attachment's relative path and how many files were written before
// it failed — surfaced verbatim in the attachment-specific toast.
const FAILED_REL_PATH = "attachments/doc.pdf";
const FILES_WRITTEN_BEFORE = 2;
// A distinctive, NON-disk-full underlying cause so we can prove the real reason
// (not just the generic disk-full guidance) reaches the user-facing toast.
const WRITE_FAILURE_REASON = "EACCES: permission denied, open 'doc.pdf'";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

// useAuth throws outside an AuthProvider; the restore panel doesn't need it.
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    isInitialized: true,
    isAuthenticated: true,
    setupPassword: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    isLoading: false,
    isMigrating: false,
    legacyMigrationProgress: null,
    legacyMigrationResult: null,
    fileDecryptProgress: null,
  }),
}));

// Unrelated heavy sibling panels (own DB queries / auth) — stub them out.
vi.mock("@/components/VocabularyManager", () => ({ default: () => null }));
vi.mock("@/components/StripMarkersPanel", () => ({ default: () => null }));
vi.mock("@/components/MigrationAuditPanel", () => ({ default: () => null }));
vi.mock("@/components/LegacyRecoveryPanel", () => ({ default: () => null }));

// Keep peekManifest + the real error classes (so SettingsPage's instanceof
// checks line up), but stub restoreV3Backup to reproduce the post-clear failure
// on a bad attachment: drive the injected writer (which fails), then throw the
// real RestoreInterruptedError whose cause is a real AttachmentWriteError —
// exactly as restore.ts wraps an attachment write failure after the destructive
// clear. SettingsPage must take the attachment-specific branch, not the generic
// "Restore Interrupted" one.
vi.mock("@/lib/backup/restore", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/backup/restore")>();
  return {
    ...actual,
    restoreV3Backup: vi.fn(async (opts: any) => {
      // Cross the destructive-clear "point of no return" so the UI marks the
      // vault as cleared, mirroring the real progress sequence.
      opts.onProgress?.({ percent: 8, phase: "Clearing existing data..." });
      opts.onProgress?.({ percent: 50, phase: "Restoring attachment files..." });

      // Drive the injected attachment writer; it fails mid-restore.
      let writeError: unknown = null;
      try {
        await opts.attachmentWriter.write(FAILED_REL_PATH, new ArrayBuffer(4));
      } catch (e) {
        writeError = e;
      }
      writerInvokedSpy(writeError !== null);

      const attachmentError = new actual.AttachmentWriteError(
        FAILED_REL_PATH,
        `Failed to write attachment "${FAILED_REL_PATH}"`,
        { cause: writeError, filesWrittenBefore: FILES_WRITTEN_BEFORE },
      );
      throw new actual.RestoreInterruptedError(
        "Restore failed partway through, after the existing data had been cleared, " +
          "so the vault is only partially restored. It has been reset to empty — " +
          "restore again to recover your data.",
        { cause: attachmentError },
      );
    }),
  };
});

const SettingsPage = (await import("./SettingsPage")).default;
const { renderWithSettingsProviders } = await import("@/test/settingsTestProviders");

let reloadSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(() => {
  // Radix dialogs call scrollIntoView, which jsdom doesn't implement.
  Element.prototype.scrollIntoView = vi.fn();
  // Some SettingsPage panels mount virtualized lists; jsdom lacks ResizeObserver.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Build a minimal but real v3 backup zip: the manifest must be the FIRST entry
// so the streaming peek reads it. Only the manifest is read by the real
// peek/preview code under test (restoreV3Backup is stubbed), so a single
// attachment placeholder entry is enough.
async function makeV3Backup(): Promise<File> {
  const manifest = {
    formatVersion: 3,
    app: "KYUTXO",
    appVersion: "test",
    exportDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
    encrypted: false,
    counts: {
      records: 0,
      blockchainTransactions: 0,
      transactionParticipants: 0,
      attachments: 0,
      addressSyncState: 0,
      utxoLineage: 0,
      custodySegments: 0,
      attachmentFiles: 1,
    },
    streamedTables: [],
    inline: { settings: [] },
  };
  const zip = new JSZip();
  zip.file("backup.json", JSON.stringify(manifest));
  zip.file("attachments/doc.pdf", new Uint8Array([1, 2, 3, 4]));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes], "kyutxo-backup.zip", { type: "application/zip" });
}

async function openRestoreWith(file: File) {
  fireEvent.click(await screen.findByTestId("button-open-restore"));
  const input = (await screen.findByTestId("input-restore-file")) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  toastSpy.mockClear();
  writerInvokedSpy.mockClear();

  // The post-clear failure path reloads the page; capture the call instead of
  // letting jsdom throw "Not implemented: navigation". reload is a non-configurable
  // data property in jsdom, so replace window.location wholesale with a plain
  // object that copies the real fields and swaps in a reload spy.
  reloadSpy = vi.fn();
  const loc = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      href: loc.href,
      origin: loc.origin,
      protocol: loc.protocol,
      host: loc.host,
      hostname: loc.hostname,
      port: loc.port,
      pathname: loc.pathname,
      search: loc.search,
      hash: loc.hash,
      reload: reloadSpy,
      assign: vi.fn(),
      replace: vi.fn(),
      toString: () => loc.href,
    },
  });

  // The web attachment writer POSTs to /api/attachments/write; make it fail so
  // the injected writer throws "mid-restore". Use a distinctive, NON-disk-full
  // reason so we can prove the real underlying cause (not just the generic
  // disk-full guess) reaches the user-facing toast.
  fetchSpy = vi.fn(async () => ({
    ok: false,
    statusText: "Internal Server Error",
    json: async () => ({ error: WRITE_FAILURE_REASON }),
  }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsPage — failed v3 restore on a bad attachment (AttachmentWriteError cause)", () => {
  it("shows the attachment-specific 'Couldn't Write Attachment' toast and resets the dialog", async () => {
    renderWithSettingsProviders(<SettingsPage />);

    await openRestoreWith(await makeV3Backup());

    // Configure -> confirm stage.
    fireEvent.click(await screen.findByTestId("button-continue-restore"));
    await screen.findByTestId("restore-preferences-preview");

    // Confirm -> run the restore (which fails after the destructive clear on a
    // bad attachment file).
    fireEvent.click(await screen.findByTestId("button-confirm-restore"));

    // The attachment-specific toast surfaces, naming the failed file, how many
    // files were saved before, and telling the user to run the restore again.
    await waitFor(() => {
      const call = toastSpy.mock.calls.find(
        (c) => c[0]?.title === "Restore Failed — Couldn't Write Attachment",
      );
      expect(call).toBeTruthy();
      expect(call![0].variant).toBe("destructive");
      expect(call![0].description).toContain(FAILED_REL_PATH);
      expect(call![0].description).toMatch(/2 attachment files were saved before/i);
      expect(call![0].description).toMatch(/run the restore again/i);
      // The REAL underlying cause must reach the user — not just the generic
      // disk-full guess — so they can self-diagnose (here: a permission error).
      expect(call![0].description).toContain(WRITE_FAILURE_REASON);
    });

    // It must NOT fall through to the generic "Restore Interrupted" toast.
    expect(
      toastSpy.mock.calls.find((c) => c[0]?.title === "Restore Interrupted"),
    ).toBeFalsy();

    // The injected attachment writer really ran and really failed mid-restore.
    expect(writerInvokedSpy).toHaveBeenCalledWith(true);

    // The dialog/progress state is reset, not stuck mid-restore: the in-progress
    // UI is gone immediately after the failure is handled.
    await waitFor(() => {
      expect(screen.queryByTestId("restore-progress")).toBeNull();
    });

    // After the short delay the dialog closes and the page reloads to reflect
    // the now-empty vault.
    await waitFor(
      () => {
        expect(reloadSpy).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );
    // The restore dialog's own controls are gone (they only exist while the
    // dialog is open), confirming it closed rather than staying stuck open.
    expect(screen.queryByTestId("button-confirm-restore")).toBeNull();
    expect(screen.queryByTestId("button-back-restore")).toBeNull();
  });
});
