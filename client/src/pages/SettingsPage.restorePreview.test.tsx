// @vitest-environment jsdom
//
// Page-level coverage for the pre-restore portable-preference PREVIEW on LEGACY
// (pre-v3) backups, wired through SettingsPage's `handlePrepareRestore` (Task
// #590). The pure preview math (`previewSettingsPreferences`) and the
// preview/restore parity are unit-tested elsewhere; this file drives the actual
// legacy branch of the restore dialog so the legacy and v3 preview paths can't
// silently diverge:
//   - a plain (unencrypted) legacy backup advances configure -> confirm and
//     shows the correct "From backup" vs "Kept (this device)" rows derived from
//     the backup's `data.settings`.
//   - an encrypted legacy backup with the CORRECT password produces the same
//     preview; a WRONG password fails non-destructively (stays on configure, no
//     vault writes); a MISSING password leaves the Continue button disabled.
//   - a legacy backup with no portable preferences shows the
//     "doesn't change any of your portable preferences" note.
//
// We build real legacy backup zips (JSZip + the real crypto helpers) and let the
// component read/decrypt them through its real code path. Only the auth context,
// toast, and unrelated heavy sibling panels are stubbed.

import "fake-indexeddb/auto";

import JSZip from "jszip";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

import {
  deriveKey,
  encrypt,
  generateSalt,
  bufferToBase64,
  LEGACY_PBKDF2_ITERATIONS,
} from "@/lib/crypto";

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
});

// Build a LEGACY (pre-v3) backup zip: a single `backup.json` holding the whole
// vault. When `password` is given the `data` blob is encrypted exactly as the
// app's legacy exporter does (AES-GCM over `deriveKey(password, salt)`), with
// the salt stored base64 alongside.
async function makeLegacyBackup(opts: {
  settings: any[];
  password?: string;
  data?: unknown;
}): Promise<File> {
  const dataObj = opts.data ?? { records: [], settings: opts.settings };
  let backup: any;
  if (opts.password) {
    const salt = generateSalt();
    // Mirrors the legacy exporter — pre-strengthening iteration count only.
    const key = await deriveKey(opts.password, salt, LEGACY_PBKDF2_ITERATIONS);
    backup = {
      exportDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      encrypted: true,
      salt: bufferToBase64(salt),
      data: await encrypt(JSON.stringify(dataObj), key),
    };
  } else {
    backup = {
      exportDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      encrypted: false,
      data: dataObj,
    };
  }
  const zip = new JSZip();
  zip.file("backup.json", JSON.stringify(backup));
  const bytes = await zip.generateAsync({ type: "uint8array" });
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
    } as Settings,
    { skipNotification: true },
  );
  toastSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("SettingsPage — legacy backup preference preview (plain)", () => {
  it("blocks malformed plaintext data before confirmation and preserves portable settings", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(
      await makeLegacyBackup({ settings: [], data: "not-a-vault-payload" }),
    );

    fireEvent.click(await screen.findByTestId("button-continue-restore"));

    await waitFor(() => {
      expect(
        toastSpy.mock.calls.some((call) => call[0]?.title === "Malformed backup data"),
      ).toBe(true);
    });
    expect(screen.queryByTestId("restore-preferences-preview")).toBeNull();
    expect(screen.getByTestId("radio-replace")).toBeTruthy();
    expect(screen.queryByTestId("button-confirm-restore")).toBeNull();

    const after = await getSettings("default");
    expect(after?.disableOrphanCheck).toBe(false);
    expect(after?.cancelConfirmThreshold).toBe(75);
    expect(after?.privacyHistoryLimit).toBe(30);
  });

  it("advances to the confirm stage and shows the correct From-backup vs Kept rows", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(await makeLegacyBackup({ settings: PREFS_SETTINGS }));

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
    await openRestoreWith(await makeLegacyBackup({ settings: [{ id: "default" }] }));

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

describe("SettingsPage — legacy backup preference preview (encrypted)", () => {
  const PASSWORD = "correct horse battery staple";

  it("produces the same preview as plain when given the correct password", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await openRestoreWith(
      await makeLegacyBackup({ settings: PREFS_SETTINGS, password: PASSWORD }),
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
      await makeLegacyBackup({ settings: PREFS_SETTINGS, password: PASSWORD }),
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
      await makeLegacyBackup({ settings: PREFS_SETTINGS, password: PASSWORD }),
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
