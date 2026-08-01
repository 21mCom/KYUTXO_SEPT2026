// Tests for the vault KDF parameter record + the transparent unlock-time
// upgrade:
//
//   1. vault rows written before the strengthening carry no kdfIterations
//      field and resolve to LEGACY (100k),
//   2. saveVaultSettings records the CURRENT count for new vaults,
//   3. upgradeVaultKdfIfNeeded re-derives the stored hash at CURRENT on a
//      legacy vault — same salt, password still verifies at CURRENT, wrong
//      password still fails, legacy parameters no longer verify,
//   4. the upgrade is a no-op on an already-current vault (hash untouched).
//
// Uses the REAL vault Dexie database on fake-indexeddb.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  vaultDb,
  saveVaultSettings,
  getVaultSettings,
  getVaultKdfIterations,
  upgradeVaultKdfIfNeeded,
  type VaultSettings,
} from "./vault";
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  bufferToBase64,
  base64ToBuffer,
  LEGACY_PBKDF2_ITERATIONS,
  CURRENT_PBKDF2_ITERATIONS,
} from "./crypto";

const PASSWORD = "vault-unlock-password";

// Writes a vault row exactly the way a pre-strengthening build did: 100k hash,
// NO kdfIterations field.
async function seedLegacyVault(password: string): Promise<void> {
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt, LEGACY_PBKDF2_ITERATIONS);
  await vaultDb.vault.put({
    id: "main",
    salt: bufferToBase64(salt),
    passwordHash,
    createdAt: Date.now(),
  });
}

beforeEach(async () => {
  await vaultDb.vault.clear();
});

describe("getVaultKdfIterations", () => {
  it("resolves an absent field to the legacy count", () => {
    const settings = { id: "main", salt: "s", passwordHash: "h", createdAt: 0 } as VaultSettings;
    expect(getVaultKdfIterations(settings)).toBe(LEGACY_PBKDF2_ITERATIONS);
  });

  it("returns the recorded count when present", () => {
    const settings = {
      id: "main",
      salt: "s",
      passwordHash: "h",
      kdfIterations: 600000,
      createdAt: 0,
    } as VaultSettings;
    expect(getVaultKdfIterations(settings)).toBe(600000);
  });
});

describe("saveVaultSettings", () => {
  it("records the current iteration count for newly created vaults", async () => {
    await saveVaultSettings("c2FsdA==", "aGFzaA==");
    const settings = await getVaultSettings();
    expect(settings?.kdfIterations).toBe(CURRENT_PBKDF2_ITERATIONS);
  });
});

describe("upgradeVaultKdfIfNeeded", () => {
  it("upgrades a legacy vault: same salt, new hash verifies only at CURRENT", async () => {
    await seedLegacyVault(PASSWORD);
    const before = (await getVaultSettings())!;
    expect(before.kdfIterations).toBeUndefined();

    const upgraded = await upgradeVaultKdfIfNeeded(PASSWORD, before);
    expect(upgraded).toBe(true);

    const after = (await getVaultSettings())!;
    expect(after.kdfIterations).toBe(CURRENT_PBKDF2_ITERATIONS);
    // Salt is preserved — legacy at-rest payloads key off salt + LEGACY.
    expect(after.salt).toBe(before.salt);
    expect(after.passwordHash).not.toBe(before.passwordHash);

    const salt = base64ToBuffer(after.salt);
    // Password still unlocks — at the CURRENT parameters now...
    expect(await verifyPassword(PASSWORD, salt, after.passwordHash, CURRENT_PBKDF2_ITERATIONS)).toBe(true);
    // ...and via the stored-parameter resolver used by login.
    expect(
      await verifyPassword(PASSWORD, salt, after.passwordHash, getVaultKdfIterations(after)),
    ).toBe(true);
    // Wrong password still fails; legacy parameters no longer match the hash.
    expect(await verifyPassword("wrong", salt, after.passwordHash, CURRENT_PBKDF2_ITERATIONS)).toBe(false);
    expect(await verifyPassword(PASSWORD, salt, after.passwordHash, LEGACY_PBKDF2_ITERATIONS)).toBe(false);
  });

  it("is a no-op on an already-current vault", async () => {
    const salt = generateSalt();
    const passwordHash = await hashPassword(PASSWORD, salt);
    await saveVaultSettings(bufferToBase64(salt), passwordHash);
    const before = (await getVaultSettings())!;

    const upgraded = await upgradeVaultKdfIfNeeded(PASSWORD, before);
    expect(upgraded).toBe(false);

    const after = (await getVaultSettings())!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.kdfIterations).toBe(CURRENT_PBKDF2_ITERATIONS);
  });
});
