// @vitest-environment jsdom
//
// Task: a FAILED transparent KDF upgrade must never block a valid login, and
// must retry (and succeed) on the next unlock instead of being lost.
//
// login() treats upgradeVaultKdfIfNeeded as best-effort: the call is wrapped in
// a try/catch that only logs. These tests exercise that failure path end-to-end
// through the REAL AuthContext login and the REAL vault database
// (fake-indexeddb) + REAL crypto:
//
//   1. the vault-row update inside upgradeVaultKdfIfNeeded throws → login still
//      returns true and the row keeps its exact legacy shape (no kdf record,
//      same hash, same salt), so the next unlock still sees an upgradeable row,
//   2. a subsequent login with the failure removed completes the upgrade to the
//      current parameters — same salt, new hash, password still verifies.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import React from "react";

// ---- Mock the heavy startup-migration dependencies AuthContext pulls in ----
// (All are irrelevant here: the seeded vault marks every one-time migration
// complete, but the modules must still load without dragging in the app DB.)

vi.mock("@/lib/data/record-crud", () => ({
  repairInputStringLower: vi.fn(async () => ({ ok: true, fixed: 0, scanned: 0 })),
  repairAddressImportanceTiers: vi.fn(async () => ({ ok: true, fixed: 0, scanned: 0 })),
  detectSearchVisibilityIssues: vi.fn(async () => ({ tiersAffected: false, searchKeysAffected: false })),
  countRecords: vi.fn(async () => 0),
  warmRecordSearchIndex: vi.fn(),
}));
vi.mock("@/lib/data/attachments-crud", () => ({ countAttachments: vi.fn(async () => 0) }));
vi.mock("@/lib/data/evidence-crud", () => ({ countEvidenceAttachments: vi.fn(async () => 0) }));
vi.mock("@/lib/attachments", () => ({
  migrateAttachmentPaths: vi.fn(async () => ({ migrated: 0, failed: 0 })),
}));
vi.mock("@/lib/legacy-decrypt", () => ({
  decryptLegacyRecords: vi.fn(async () => ({ totalDecrypted: 0, totalFailed: 0, tableErrors: [] })),
  getTotalTableCount: vi.fn(() => 0),
  countUnrecoveredLegacyRows: vi.fn(async () => ({
    totalUnrecovered: 0,
    lockedRecords: [],
    lockedRecordsTruncated: false,
  })),
}));
vi.mock("@/lib/legacy-decrypt-files", () => ({
  decryptLegacyAttachmentFiles: vi.fn(async () => ({ totalDecrypted: 0, totalFailed: 0, totalSkipped: 0 })),
}));
vi.mock("@/lib/activity-bus", () => ({
  getActivityBus: () => ({ publishTask: () => {}, completeTask: () => {} }),
}));
vi.mock("@/lib/database", () => ({
  db: { open: vi.fn(async () => {}) },
  CURRENT_SCHEMA_VERSION: 1,
}));
vi.mock("@/lib/db-upgrade-progress", () => ({
  subscribeDbUpgradeProgress: () => () => {},
  clearDbUpgradeProgress: () => {},
}));
// One-time "vault protection strengthened" notice shown after a successful
// transparent KDF upgrade — mocked so tests can assert exactly when it fires.
const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
  useToast: () => ({ toast: (...args: unknown[]) => toastMock(...args), toasts: [], dismiss: () => {} }),
}));

import { AuthProvider, useAuth } from "./AuthContext";
import {
  vaultDb,
  getVaultSettings,
  verifyVaultPassword,
} from "@/lib/vault";
import {
  generateSalt,
  hashPassword,
  bufferToBase64,
  LEGACY_PBKDF2_ITERATIONS,
  CURRENT_KDF_PARAMS,
} from "@/lib/crypto";

const PASSWORD = "vault-unlock-password";

// Seed a pre-strengthening (legacy 100k PBKDF2) vault row, with every one-time
// startup migration already marked done so login's background migration pass
// no-ops instantly.
async function seedLegacyVault(password: string): Promise<void> {
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt, LEGACY_PBKDF2_ITERATIONS);
  await vaultDb.vault.put({
    id: "main",
    salt: bufferToBase64(salt),
    passwordHash,
    createdAt: Date.now(),
    attachmentPathsMigrated: true,
    legacyDecryptComplete: true,
    legacyFileDecryptComplete: true,
    inputStringLowerRepaired: true,
    searchVisibilityRepaired: true,
  });
}

// Expose the live auth context to the test without asserting on rendered UI.
let auth: ReturnType<typeof useAuth> | null = null;
function Probe() {
  auth = useAuth();
  return null;
}

async function mountAuth(): Promise<void> {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => {
    expect(auth?.isLoading).toBe(false);
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  cleanup();
  auth = null;
  vi.restoreAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  toastMock.mockClear();
  await vaultDb.vault.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("login: failed transparent KDF upgrade", () => {
  it("still succeeds when the upgrade write throws, keeps the legacy row, and completes the upgrade on the next unlock", async () => {
    await seedLegacyVault(PASSWORD);
    const before = (await getVaultSettings())!;
    expect(before.kdf).toBeUndefined();
    expect(before.kdfIterations).toBeUndefined();

    await mountAuth();

    // ---- Unlock #1: the vault-row update inside upgradeVaultKdfIfNeeded
    // throws (e.g. quota/IO failure mid-write). Login must still succeed.
    const updateSpy = vi
      .spyOn(vaultDb.vault, "update")
      .mockRejectedValue(new Error("simulated vault write failure"));

    let ok = false;
    await act(async () => {
      ok = await auth!.login(PASSWORD);
    });
    expect(ok).toBe(true);
    expect(auth!.isAuthenticated).toBe(true);
    // The upgrade was attempted (this is a legacy row) and its failure was
    // swallowed by login's best-effort catch, not surfaced as a login failure.
    expect(updateSpy).toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes("KDF upgrade failed")),
    ).toBe(true);
    // No "protection strengthened" notice when the upgrade did NOT happen.
    expect(toastMock).not.toHaveBeenCalled();

    // Row keeps its exact legacy shape: no kdf record, hash and salt untouched
    // — nothing about the failed attempt can strand the vault half-upgraded.
    const afterFailure = (await getVaultSettings())!;
    expect(afterFailure.kdf).toBeUndefined();
    expect(afterFailure.kdfIterations).toBeUndefined();
    expect(afterFailure.passwordHash).toBe(before.passwordHash);
    expect(afterFailure.salt).toBe(before.salt);
    // And the password still verifies at the legacy parameters.
    expect(await verifyVaultPassword(PASSWORD, afterFailure)).toBe(true);

    // ---- Unlock #2: failure removed → the upgrade retries and completes.
    updateSpy.mockRestore();

    await act(async () => {
      auth!.logout();
    });
    expect(auth!.isAuthenticated).toBe(false);

    await act(async () => {
      ok = await auth!.login(PASSWORD);
    });
    expect(ok).toBe(true);

    const upgraded = (await getVaultSettings())!;
    expect(upgraded.kdf).toEqual(CURRENT_KDF_PARAMS);
    expect(upgraded.salt).toBe(before.salt); // salt preserved
    expect(upgraded.passwordHash).not.toBe(before.passwordHash);
    // Password unlocks via the stored (upgraded) parameters, wrong one fails.
    expect(await verifyVaultPassword(PASSWORD, upgraded)).toBe(true);
    expect(await verifyVaultPassword("wrong", upgraded)).toBe(false);

    // The successful upgrade surfaces the one-time strengthening notice.
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatchObject({
      title: "Vault protection strengthened",
    });
  });

  it("shows the strengthening notice once — never again on subsequent logins", async () => {
    await seedLegacyVault(PASSWORD);
    await mountAuth();

    let ok = false;
    await act(async () => {
      ok = await auth!.login(PASSWORD);
    });
    expect(ok).toBe(true);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatchObject({
      title: "Vault protection strengthened",
    });

    await act(async () => {
      auth!.logout();
    });
    await act(async () => {
      ok = await auth!.login(PASSWORD);
    });
    expect(ok).toBe(true);
    // Already at current parameters — no repeat notice.
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("a wrong password never reaches the upgrade path", async () => {
    await seedLegacyVault(PASSWORD);
    await mountAuth();

    const updateSpy = vi.spyOn(vaultDb.vault, "update");
    let ok = true;
    await act(async () => {
      ok = await auth!.login("wrong-password");
    });
    expect(ok).toBe(false);
    expect(auth!.isAuthenticated).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();

    const settings = (await getVaultSettings())!;
    expect(settings.kdf).toBeUndefined();
  });
});
