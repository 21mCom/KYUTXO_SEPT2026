// @vitest-environment jsdom
//
// Page-level coverage for the RAW AttachmentWriteError branch of SettingsPage's
// restore catch block. Its sibling (SettingsPage.restoreAttachmentWriteFailed.
// test.tsx) covers the WRAPPED case — an AttachmentWriteError surfaced as the
// `.cause` of a RestoreInterruptedError, which only happens AFTER the
// destructive clear, when the vault has been reset to empty.
//
// This test covers the OTHER half: a raw AttachmentWriteError thrown directly by
// restoreV3Backup. restore.ts throws this only when the attachment write fails
// BEFORE the destructive clear (`!cleared`), so the existing vault was never
// touched. SettingsPage's catch must:
//   - still show the attachment-specific "Restore Failed — Couldn't Write
//     Attachment" toast (naming the failed file + how many were saved before),
//   - but tell the truth about the vault: it must NOT claim "reset to empty"
//     (that is the wrapped/post-clear message). It must say the existing data
//     was left untouched.
//   - reset the dialog WITHOUT reloading the page (nothing changed, so a reload
//     would falsely imply the vault was wiped/refreshed).
// A regression that re-used the wrapped message here would tell a user whose
// data is perfectly intact that their vault had been wiped.

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
// checks line up), but stub restoreV3Backup to reproduce a pre-clear failure on
// a bad attachment: drive the injected writer (which fails), then throw a RAW
// AttachmentWriteError — exactly as restore.ts re-throws an attachment write
// failure that happened BEFORE the destructive clear. Crucially we never report
// a progress percent >= 8, so SettingsPage never marks the vault as cleared.
vi.mock("@/lib/backup/restore", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/backup/restore")>();
  return {
    ...actual,
    restoreV3Backup: vi.fn(async (opts: any) => {
      // Stay BEFORE the destructive-clear "point of no return" (percent < 8) so
      // the UI keeps the vault marked as intact, mirroring a pre-clear failure.
      opts.onProgress?.({ percent: 2, phase: "Reading backup..." });
      opts.onProgress?.({ percent: 5, phase: "Restoring attachment files..." });

      // Drive the injected attachment writer; it fails before the clear.
      let writeError: unknown = null;
      try {
        await opts.attachmentWriter.write(FAILED_REL_PATH, new ArrayBuffer(4));
      } catch (e) {
        writeError = e;
      }
      writerInvokedSpy(writeError !== null);

      // Raw AttachmentWriteError, NOT wrapped in a RestoreInterruptedError.
      throw new actual.AttachmentWriteError(
        FAILED_REL_PATH,
        `Failed to write attachment "${FAILED_REL_PATH}"`,
        { cause: writeError, filesWrittenBefore: FILES_WRITTEN_BEFORE },
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

  // A raw (pre-clear) failure must NOT reload the page. Capture reload anyway so
  // we can assert it was never called and so jsdom doesn't throw "Not
  // implemented: navigation" if a regression triggered one. reload is a
  // non-configurable data property in jsdom, so replace window.location
  // wholesale with a plain object that copies the real fields and swaps in a
  // reload spy.
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
  // the injected writer throws "before the clear".
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

describe("SettingsPage — failed v3 restore on a bad attachment BEFORE the clear (raw AttachmentWriteError)", () => {
  it("shows the attachment-specific toast WITHOUT claiming the vault was wiped, and resets the dialog without reloading", async () => {
    renderWithSettingsProviders(<SettingsPage />);

    await openRestoreWith(await makeV3Backup());

    // Configure -> confirm stage.
    fireEvent.click(await screen.findByTestId("button-continue-restore"));
    await screen.findByTestId("restore-preferences-preview");

    // Confirm -> run the restore (which fails before the destructive clear on a
    // bad attachment file).
    fireEvent.click(await screen.findByTestId("button-confirm-restore"));

    // The attachment-specific toast surfaces, naming the failed file, how many
    // files were saved before, and telling the user to run the restore again.
    let description = "";
    await waitFor(() => {
      const call = toastSpy.mock.calls.find(
        (c) => c[0]?.title === "Restore Failed — Couldn't Write Attachment",
      );
      expect(call).toBeTruthy();
      expect(call![0].variant).toBe("destructive");
      description = call![0].description;
      expect(description).toContain(FAILED_REL_PATH);
      expect(description).toMatch(/2 attachment files were saved before/i);
      expect(description).toMatch(/run the restore again/i);
    });

    // CRITICAL: the message must NOT falsely claim the vault was wiped — the
    // failure happened before the clear, so the existing data is intact.
    expect(description).not.toMatch(/reset to empty/i);
    expect(description).toMatch(/existing data was left untouched/i);

    // It must NOT fall through to the generic "Restore Interrupted" toast.
    expect(
      toastSpy.mock.calls.find((c) => c[0]?.title === "Restore Interrupted"),
    ).toBeFalsy();

    // The injected attachment writer really ran and really failed.
    expect(writerInvokedSpy).toHaveBeenCalledWith(true);

    // The dialog/progress state is reset, not stuck mid-restore.
    await waitFor(() => {
      expect(screen.queryByTestId("restore-progress")).toBeNull();
    });

    // The dialog closes (its controls only exist while open) without reloading,
    // since the vault was never touched.
    await waitFor(() => {
      expect(screen.queryByTestId("button-confirm-restore")).toBeNull();
    });
    expect(screen.queryByTestId("button-back-restore")).toBeNull();

    // Give any stray reload timer a chance to fire, then confirm it never did:
    // an intact vault must not be reloaded.
    await new Promise((r) => setTimeout(r, 50));
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
