// @vitest-environment jsdom
//
// Page-level coverage for the pre-restore portable-preference PREVIEW on V3
// (modern, streaming) backups, wired through SettingsPage's
// `handlePrepareRestore`. The pure preview math (`previewSettingsPreferences`)
// and the data-layer preview/restore parity are unit-tested elsewhere; the
// LEGACY branch of this same dialog has its own component test
// (`SettingsPage.restorePreview.test.tsx`). This file drives the V3 branch —
// peek the manifest, `parseInline`, then `previewSettingsPreferences` — so the
// modern preview UI wiring can't silently diverge from the legacy one it was
// meant to match:
//   - a plain (unencrypted) v3 backup advances configure -> confirm and shows
//     the correct "From backup" vs "Kept (this device)" rows derived from the
//     backup's inline `settings`.
//   - an encrypted v3 backup with the CORRECT password produces the same
//     preview; a WRONG password fails non-destructively (stays on configure, no
//     vault writes); a MISSING password leaves the Continue button disabled.
//   - a v3 backup with no portable preferences shows the "doesn't change any of
//     your portable preferences" note.
//
// We build real v3 backup zips with the app's own streaming exporter
// (`exportBackup` + `MemorySink`), injecting the inline `settings` rows, and let
// the component read/decrypt them through its real streaming code path. Only the
// auth context, toast, and unrelated heavy sibling panels are stubbed.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

import { MemorySink } from "@/lib/backup/sink";
import { exportBackup } from "@/lib/backup/export";

// A hoisted toast spy so the mocked useToast hands back the same fn we assert on.
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
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

// Unrelated heavy sibling panels (own DB queries / auth) — stub so they don't
// interfere with the restore flow under test.
vi.mock("@/components/VocabularyManager", () => ({ default: () => null }));
vi.mock("@/components/StripMarkersPanel", () => ({ default: () => null }));
vi.mock("@/components/MigrationAuditPanel", () => ({ default: () => null }));
vi.mock("@/components/LegacyRecoveryPanel", () => ({ default: () => null }));

const SettingsPage = (await import("./SettingsPage")).default;
const { renderWithSettingsProviders } = await import("@/test/settingsTestProviders");
const { putSettings, getSettings } = await import("@/lib/data/settings-crud");
import type { Settings } from "@/lib/db-types";

beforeAll(() => {
  // Radix dialogs call scrollIntoView, which jsdom doesn't implement.
  Element.prototype.scrollIntoView = vi.fn();
  // Some SettingsPage panels mount virtualized lists; jsdom lacks ResizeObserver.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // A successful restore schedules window.location.reload() on a timer. jsdom's
  // reload is non-configurable and unimplemented, so replace window.location
  // wholesale with a plain object carrying a no-op reload spy.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: vi.fn() },
  });
});

// Build a real V3 (streaming) backup zip with the app's own exporter. The big
// tables are empty (the test DB carries no records); only the inline `settings`
// rows matter for the preview. When `password` is given the exporter encrypts
// the inline payload exactly as the real export does (AES-GCM, PBKDF2 key, salt
// + check sentinel stored in the manifest).
async function makeV3Backup(opts: {
  settings: any[];
  password?: string;
}): Promise<File> {
  const sink = new MemorySink();
  await exportBackup({
    sink,
    encrypted: !!opts.password,
    password: opts.password,
    attachmentIO: { listAll: async () => [], read: async () => null },
    readInline: async () => ({ settings: opts.settings }),
  });
  const bytes = sink.getBytes();
  return new File([bytes], "kyutxo-backup.zip", { type: "application/zip" });
}

// Settings row carrying a MIX of portable prefs: some present (From backup) and
// fundTrailTxLimit deliberately absent (Kept this device).
const PREFS_SETTINGS = [
  {
    id: "default",
    disableOrphanCheck: true, // -> "Off"
    cancelConfirmThreshold: 90, // -> "90%"
    privacyHistoryLimit: 100, // -> "100 runs"
    // fundTrailTxLimit absent -> kept
    entityListSnapshot: { entries: [{ address: "a" }, { address: "b" }] }, // -> "2 entries"
  },
];

async function openRestoreWith(file: File) {
  fireEvent.click(await screen.findByTestId("button-open-restore"));
  const input = (await screen.findByTestId("input-restore-file")) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(async () => {
  // The real app always has a 'default' settings row. Seed one with known
  // portable-pref values so "no vault writes" can be asserted against it.
  await putSettings(
    {
      id: "default",
      disableOrphanCheck: false,
      cancelConfirmThreshold: 75,
      privacyHistoryLimit: 30,
      fundTrailTxLimit: 2000,
      // Device-local settings (NOT in the portable allow-list) — must survive a
      // restore untouched.
      theme: "dark",
      defaultView: "grid",
    } as Settings,
    { skipNotification: true },
  );
  toastSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("SettingsPage — v3 backup preference preview (plain)", () => {
  it("advances to the confirm stage and shows the correct From-backup vs Kept rows", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(await makeV3Backup({ settings: PREFS_SETTINGS }));

    fireEvent.click(await screen.findByTestId("button-continue-restore"));

    // Reached the confirm stage (configure-stage controls are gone).
    await screen.findByTestId("restore-preferences-preview");
    expect(screen.queryByTestId("radio-replace")).toBeNull();

    // From-backup rows render their formatted values.
    expect(screen.getByTestId("pref-status-disableOrphanCheck").textContent).toContain(
      "From backup: Off",
    );
    expect(screen.getByTestId("pref-status-cancelConfirmThreshold").textContent).toContain(
      "From backup: 90%",
    );
    expect(screen.getByTestId("pref-status-privacyHistoryLimit").textContent).toContain(
      "From backup: 100 runs",
    );
    expect(screen.getByTestId("pref-status-entityListSnapshot").textContent).toContain(
      "From backup: 2 entries",
    );

    // The absent pref is reported as kept on this device.
    expect(screen.getByTestId("pref-status-fundTrailTxLimit").textContent).toContain(
      "Kept (this device)",
    );

    // At least one pref came from the backup, so the "nothing changes" note is hidden.
    expect(screen.queryByTestId("text-no-prefs-carried")).toBeNull();

    // The preview is non-destructive: the on-device settings row is untouched.
    const after = await getSettings("default");
    expect(after?.disableOrphanCheck).toBe(false);
    expect(after?.cancelConfirmThreshold).toBe(75);
    expect(after?.privacyHistoryLimit).toBe(30);
  });

  it("shows the 'doesn't change any of your portable preferences' note when the backup has none", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(await makeV3Backup({ settings: [{ id: "default" }] }));

    fireEvent.click(await screen.findByTestId("button-continue-restore"));

    await screen.findByTestId("restore-preferences-preview");
    expect(await screen.findByTestId("text-no-prefs-carried")).toBeTruthy();

    // Every allow-listed pref is shown as kept on this device.
    for (const key of [
      "disableOrphanCheck",
      "cancelConfirmThreshold",
      "privacyHistoryLimit",
      "fundTrailTxLimit",
      "entityListSnapshot",
    ]) {
      expect(screen.getByTestId(`pref-status-${key}`).textContent).toContain(
        "Kept (this device)",
      );
    }
  });
});

describe("SettingsPage — v3 backup preference preview (encrypted)", () => {
  const PASSWORD = "correct horse battery staple";

  it("produces the same preview as plain when given the correct password", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(
      await makeV3Backup({ settings: PREFS_SETTINGS, password: PASSWORD }),
    );

    // Password field appears once the backup is detected as encrypted.
    const pw = (await screen.findByTestId("input-restore-password")) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: PASSWORD } });

    fireEvent.click(await screen.findByTestId("button-continue-restore"));

    await screen.findByTestId("restore-preferences-preview");
    expect(screen.getByTestId("pref-status-disableOrphanCheck").textContent).toContain(
      "From backup: Off",
    );
    expect(screen.getByTestId("pref-status-privacyHistoryLimit").textContent).toContain(
      "From backup: 100 runs",
    );
    expect(screen.getByTestId("pref-status-entityListSnapshot").textContent).toContain(
      "From backup: 2 entries",
    );
    expect(screen.getByTestId("pref-status-fundTrailTxLimit").textContent).toContain(
      "Kept (this device)",
    );
  });

  it("fails non-destructively on a wrong password (stays on configure, no vault writes)", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(
      await makeV3Backup({ settings: PREFS_SETTINGS, password: PASSWORD }),
    );

    const pw = (await screen.findByTestId("input-restore-password")) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "the wrong password" } });

    fireEvent.click(await screen.findByTestId("button-continue-restore"));

    // An error toast surfaces and we never advance off the configure stage.
    await waitFor(() => {
      const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
      expect(titles.some((t) => /could not read backup/i.test(t))).toBe(true);
    });
    expect(screen.queryByTestId("restore-preferences-preview")).toBeNull();
    expect(screen.getByTestId("radio-replace")).toBeTruthy();

    // The on-device settings row is untouched (no portable prefs applied).
    const after = await getSettings("default");
    expect(after?.disableOrphanCheck).toBe(false);
    expect(after?.cancelConfirmThreshold).toBe(75);
    expect(after?.privacyHistoryLimit).toBe(30);
  });

  it("leaves the Continue button disabled when the password is missing", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(
      await makeV3Backup({ settings: PREFS_SETTINGS, password: PASSWORD }),
    );

    // Wait for the encrypted backup to be recognised (password field shows).
    await screen.findByTestId("input-restore-password");

    const continueBtn = (await screen.findByTestId(
      "button-continue-restore",
    )) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);

    // Nothing happens even if a click is dispatched, and no preview appears.
    fireEvent.click(continueBtn);
    await waitFor(() => {
      expect(screen.queryByTestId("restore-preferences-preview")).toBeNull();
    });
  });
});

// The preview tests above stop at the (read-only) confirm stage and never run
// the destructive restore. These drive the WHOLE flow — configure -> confirm ->
// "Restore Now" — so we don't just trust the preview but assert the v3 restore
// path actually APPLIES the previewed portable preferences to the on-device
// `default` settings row (and leaves device-local, non-allow-listed settings
// alone). A preview that's correct while the restore writes the wrong values
// would otherwise ship undetected.
describe("SettingsPage — v3 backup full restore (applies portable prefs)", () => {
  async function confirmRestore() {
    // Reach the confirm stage, then click through the destructive restore.
    await screen.findByTestId("restore-preferences-preview");
    fireEvent.click(await screen.findByTestId("button-confirm-restore"));
  }

  it("applies the portable prefs from a PLAIN backup and leaves device-local settings untouched", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(await makeV3Backup({ settings: PREFS_SETTINGS }));

    fireEvent.click(await screen.findByTestId("button-continue-restore"));
    await confirmRestore();

    // The restore reports success once it has cleared + re-applied everything.
    await waitFor(() => {
      const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
      expect(titles.some((t) => /restore successful/i.test(t))).toBe(true);
    });

    const after = await getSettings("default");
    // Portable prefs present in the backup are applied to the device row.
    expect(after?.disableOrphanCheck).toBe(true);
    expect(after?.cancelConfirmThreshold).toBe(90);
    expect(after?.privacyHistoryLimit).toBe(100);
    expect(after?.entityListSnapshot?.entries).toHaveLength(2);
    // A portable pref ABSENT from the backup keeps its current device value.
    expect(after?.fundTrailTxLimit).toBe(2000);
    // Device-local settings (not in the allow-list) are never touched.
    expect(after?.theme).toBe("dark");
    expect(after?.defaultView).toBe("grid");
  });

  it("applies the portable prefs from an ENCRYPTED backup given the correct password", async () => {
    const PASSWORD = "correct horse battery staple";
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(
      await makeV3Backup({ settings: PREFS_SETTINGS, password: PASSWORD }),
    );

    const pw = (await screen.findByTestId("input-restore-password")) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: PASSWORD } });

    fireEvent.click(await screen.findByTestId("button-continue-restore"));
    await confirmRestore();

    await waitFor(() => {
      const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
      expect(titles.some((t) => /restore successful/i.test(t))).toBe(true);
    });

    const after = await getSettings("default");
    expect(after?.disableOrphanCheck).toBe(true);
    expect(after?.cancelConfirmThreshold).toBe(90);
    expect(after?.privacyHistoryLimit).toBe(100);
    expect(after?.entityListSnapshot?.entries).toHaveLength(2);
    expect(after?.fundTrailTxLimit).toBe(2000);
    expect(after?.theme).toBe("dark");
    expect(after?.defaultView).toBe("grid");
  });
});
