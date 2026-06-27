// @vitest-environment jsdom
//
// Page-level coverage for the "your old data was wiped" wiring when a v3 restore
// fails AFTER the destructive clear (Task #826). When an attachment file write
// fails partway through a v3 restore, restore.ts resets the vault to empty and
// throws a RestoreInterruptedError. SettingsPage's catch block must turn that
// into a visible "Restore Interrupted" toast that explains the vault is only
// partially restored and tells the user to restore again — otherwise a
// regression in the toast/reload wiring would leave users staring at an empty
// vault with no explanation.
//
// This drives the REAL restore dialog (open -> select file -> continue ->
// Restore Now) over a REAL v3 backup so handleFileSelect/handlePrepareRestore
// run their real peek/preview code. Only restoreV3Backup is stubbed to simulate
// a writer that fails mid-restore: it invokes the injected attachmentWriter
// (which fails via a mocked /api/attachments/write), then throws the same
// RestoreInterruptedError the real reset-to-empty path raises. We then assert:
//   - the destructive "Restore Interrupted" toast appears with the partial-
//     restore "restore again" guidance,
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

// The exact partial-restore message the real reset-to-empty branch raises.
const PARTIAL_RESTORE_MESSAGE =
  "Restore failed partway through, after the existing data had been cleared, " +
  "so the vault is only partially restored. It has been reset to empty — " +
  "restore again to recover your data.";

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
// checks line up), but stub restoreV3Backup to reproduce the post-clear failure:
// drive the injected writer (which fails), then throw the real
// RestoreInterruptedError. The cause is a plain error (NOT an AttachmentWriteError)
// so SettingsPage takes the generic "Restore Interrupted" branch, exactly as the
// real reset-then-cleanup-also-failed path does.
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
      let writerThrew = false;
      try {
        await opts.attachmentWriter.write("attachments/doc.pdf", new ArrayBuffer(4));
      } catch {
        writerThrew = true;
      }
      writerInvokedSpy(writerThrew);

      throw new actual.RestoreInterruptedError(PARTIAL_RESTORE_MESSAGE, {
        cause: new Error("cleanup failed"),
      });
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
  // the injected writer throws "mid-restore".
  fetchSpy = vi.fn(async () => ({
    ok: false,
    statusText: "Internal Server Error",
    json: async () => ({ error: "disk full" }),
  }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsPage — failed v3 restore wiped the vault (RestoreInterruptedError)", () => {
  it("shows the 'Restore Interrupted' partial-restore toast and resets the dialog", async () => {
    renderWithSettingsProviders(<SettingsPage />);

    await openRestoreWith(await makeV3Backup());

    // Configure -> confirm stage.
    fireEvent.click(await screen.findByTestId("button-continue-restore"));
    await screen.findByTestId("restore-preferences-preview");

    // Confirm -> run the restore (which fails after the destructive clear).
    fireEvent.click(await screen.findByTestId("button-confirm-restore"));

    // The destructive "Restore Interrupted" toast surfaces with the partial-
    // restore "restore again" guidance.
    await waitFor(() => {
      const call = toastSpy.mock.calls.find(
        (c) => c[0]?.title === "Restore Interrupted",
      );
      expect(call).toBeTruthy();
      expect(call![0].variant).toBe("destructive");
      expect(call![0].description).toMatch(/only partially restored/i);
      expect(call![0].description).toMatch(/restore again/i);
    });

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
      { timeout: 4000 },
    );
    // The restore dialog's own controls are gone (they only exist while the
    // dialog is open), confirming it closed rather than staying stuck open.
    expect(screen.queryByTestId("button-confirm-restore")).toBeNull();
    expect(screen.queryByTestId("button-back-restore")).toBeNull();
  });
});
