// Tests for the vault KDF parameter record + the transparent unlock-time
// upgrade (PBKDF2 eras -> Argon2id):
//
//   1. vault rows written before the strengthening carry no kdfIterations/kdf
//      field and resolve to LEGACY PBKDF2 (100k); strengthening-era rows with
//      only kdfIterations resolve to PBKDF2 at that count; an explicit kdf
//      record wins,
//   2. saveVaultSettings records the CURRENT Argon2id parameters for new vaults,
//   3. upgradeVaultKdfIfNeeded re-derives the stored hash at CURRENT (Argon2id)
//      on legacy AND strengthening-era PBKDF2 vaults — same salt, password
//      still verifies via the stored-parameter resolver, wrong password fails,
//      old parameters no longer verify,
//   4. the upgrade is a no-op on an already-Argon2id vault (hash untouched).
//
// Uses the REAL vault Dexie database on fake-indexeddb.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  vaultDb,
  saveVaultSettings,
  getVaultSettings,
  getVaultKdfParams,
  verifyVaultPassword,
  upgradeVaultKdfIfNeeded,
  type VaultSettings,
} from "./vault";
import {
  generateSalt,
  hashPassword,
  hashPasswordWithParams,
  verifyPasswordWithParams,
  bufferToBase64,
  base64ToBuffer,
  LEGACY_PBKDF2_ITERATIONS,
  CURRENT_PBKDF2_ITERATIONS,
  CURRENT_KDF_PARAMS,
} from "./crypto";

const PASSWORD = "vault-unlock-password";

// Writes a vault row exactly the way a pre-strengthening build did: 100k hash,
// NO kdfIterations / kdf field.
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

// Writes a vault row the way a strengthening-era (PBKDF2 600k) build did:
// kdfIterations recorded, no kdf record.
async function seedStrengthenedPbkdf2Vault(password: string): Promise<void> {
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt, CURRENT_PBKDF2_ITERATIONS);
  await vaultDb.vault.put({
    id: "main",
    salt: bufferToBase64(salt),
    passwordHash,
    kdfIterations: CURRENT_PBKDF2_ITERATIONS,
    createdAt: Date.now(),
  });
}

beforeEach(async () => {
  await vaultDb.vault.clear();
});

describe("getVaultKdfParams", () => {
  it("resolves an absent record to legacy PBKDF2", () => {
    const settings = { id: "main", salt: "s", passwordHash: "h", createdAt: 0 } as VaultSettings;
    expect(getVaultKdfParams(settings)).toEqual({
      algorithm: "pbkdf2-sha256",
      iterations: LEGACY_PBKDF2_ITERATIONS,
    });
  });

  it("resolves kdfIterations-only rows to PBKDF2 at the recorded count", () => {
    const settings = {
      id: "main",
      salt: "s",
      passwordHash: "h",
      kdfIterations: 600000,
      createdAt: 0,
    } as VaultSettings;
    expect(getVaultKdfParams(settings)).toEqual({
      algorithm: "pbkdf2-sha256",
      iterations: 600000,
    });
  });

  it("prefers an explicit kdf record over kdfIterations", () => {
    const settings = {
      id: "main",
      salt: "s",
      passwordHash: "h",
      kdfIterations: 600000,
      kdf: CURRENT_KDF_PARAMS,
      createdAt: 0,
    } as VaultSettings;
    expect(getVaultKdfParams(settings)).toEqual(CURRENT_KDF_PARAMS);
  });
});

describe("saveVaultSettings", () => {
  it("records the current Argon2id parameters for newly created vaults", async () => {
    await saveVaultSettings("c2FsdA==", "aGFzaA==");
    const settings = await getVaultSettings();
    expect(settings?.kdf).toEqual(CURRENT_KDF_PARAMS);
    expect(settings?.kdf?.algorithm).toBe("argon2id");
  });
});

describe("verifyVaultPassword", () => {
  it("verifies against each era's stored parameters", async () => {
    // Legacy row.
    await seedLegacyVault(PASSWORD);
    expect(await verifyVaultPassword(PASSWORD, (await getVaultSettings())!)).toBe(true);
    expect(await verifyVaultPassword("wrong", (await getVaultSettings())!)).toBe(false);

    // Strengthened PBKDF2 row.
    await vaultDb.vault.clear();
    await seedStrengthenedPbkdf2Vault(PASSWORD);
    expect(await verifyVaultPassword(PASSWORD, (await getVaultSettings())!)).toBe(true);
    expect(await verifyVaultPassword("wrong", (await getVaultSettings())!)).toBe(false);

    // Argon2id row.
    await vaultDb.vault.clear();
    const salt = generateSalt();
    const hash = await hashPasswordWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS);
    await saveVaultSettings(bufferToBase64(salt), hash);
    expect(await verifyVaultPassword(PASSWORD, (await getVaultSettings())!)).toBe(true);
    expect(await verifyVaultPassword("wrong", (await getVaultSettings())!)).toBe(false);
  });
});

describe("upgradeVaultKdfIfNeeded", () => {
  it.each([
    ["legacy 100k", seedLegacyVault],
    ["strengthened 600k", seedStrengthenedPbkdf2Vault],
  ])("upgrades a %s PBKDF2 vault to Argon2id: same salt, new hash", async (_label, seed) => {
    await seed(PASSWORD);
    const before = (await getVaultSettings())!;
    expect(before.kdf).toBeUndefined();

    const upgraded = await upgradeVaultKdfIfNeeded(PASSWORD, before);
    expect(upgraded).toBe(true);

    const after = (await getVaultSettings())!;
    expect(after.kdf).toEqual(CURRENT_KDF_PARAMS);
    // Salt is preserved — legacy at-rest payloads key off salt + LEGACY PBKDF2.
    expect(after.salt).toBe(before.salt);
    expect(after.passwordHash).not.toBe(before.passwordHash);

    const salt = base64ToBuffer(after.salt);
    // Password still unlocks via the stored-parameter resolver used by login...
    expect(await verifyVaultPassword(PASSWORD, after)).toBe(true);
    // ...wrong password still fails...
    expect(await verifyVaultPassword("wrong", after)).toBe(false);
    // ...and the old PBKDF2 parameters no longer match the stored hash.
    expect(
      await verifyPasswordWithParams(PASSWORD, salt, after.passwordHash, {
        algorithm: "pbkdf2-sha256",
        iterations: LEGACY_PBKDF2_ITERATIONS,
      }),
    ).toBe(false);
    expect(
      await verifyPasswordWithParams(PASSWORD, salt, after.passwordHash, {
        algorithm: "pbkdf2-sha256",
        iterations: CURRENT_PBKDF2_ITERATIONS,
      }),
    ).toBe(false);
  });

  it("a failed upgrade write leaves the legacy row intact and retries to completion", async () => {
    await seedLegacyVault(PASSWORD);
    const before = (await getVaultSettings())!;

    // Simulate the re-hash write failing (quota/IO error mid-update).
    const updateSpy = vi
      .spyOn(vaultDb.vault, "update")
      .mockRejectedValue(new Error("simulated vault write failure"));
    await expect(upgradeVaultKdfIfNeeded(PASSWORD, before)).rejects.toThrow(
      "simulated vault write failure",
    );
    updateSpy.mockRestore();

    // Row keeps its exact legacy shape — the failed attempt changed nothing,
    // so the next unlock still detects an upgradeable vault.
    const afterFailure = (await getVaultSettings())!;
    expect(afterFailure.kdf).toBeUndefined();
    expect(afterFailure.kdfIterations).toBeUndefined();
    expect(afterFailure.passwordHash).toBe(before.passwordHash);
    expect(afterFailure.salt).toBe(before.salt);
    expect(await verifyVaultPassword(PASSWORD, afterFailure)).toBe(true);

    // Retry (failure removed) completes the upgrade.
    expect(await upgradeVaultKdfIfNeeded(PASSWORD, afterFailure)).toBe(true);
    const upgraded = (await getVaultSettings())!;
    expect(upgraded.kdf).toEqual(CURRENT_KDF_PARAMS);
    expect(upgraded.salt).toBe(before.salt);
    expect(upgraded.passwordHash).not.toBe(before.passwordHash);
    expect(await verifyVaultPassword(PASSWORD, upgraded)).toBe(true);
  });

  it("is a no-op on an already-Argon2id vault", async () => {
    const salt = generateSalt();
    const passwordHash = await hashPasswordWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS);
    await saveVaultSettings(bufferToBase64(salt), passwordHash);
    const before = (await getVaultSettings())!;

    const upgraded = await upgradeVaultKdfIfNeeded(PASSWORD, before);
    expect(upgraded).toBe(false);

    const after = (await getVaultSettings())!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.kdf).toEqual(CURRENT_KDF_PARAMS);
  });

  it("upgrades a pre-domain-separation Argon2id verifier without changing its salt", async () => {
    const salt = generateSalt();
    const legacyParams = {
      algorithm: "argon2id" as const,
      memoryKiB: 65536,
      timeCost: 3,
      parallelism: 1,
      // Older Argon2id rows did not carry a version and used the raw output.
    };
    const passwordHash = await hashPasswordWithParams(PASSWORD, salt, legacyParams);
    await vaultDb.vault.put({
      id: "main",
      salt: bufferToBase64(salt),
      passwordHash,
      kdf: legacyParams,
      createdAt: Date.now(),
    });
    const before = (await getVaultSettings())!;

    expect(await verifyVaultPassword(PASSWORD, before)).toBe(true);
    expect(await upgradeVaultKdfIfNeeded(PASSWORD, before)).toBe(true);

    const after = (await getVaultSettings())!;
    expect(after.salt).toBe(before.salt);
    expect(after.kdf).toEqual(CURRENT_KDF_PARAMS);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(await verifyVaultPassword(PASSWORD, after)).toBe(true);
  });
});
