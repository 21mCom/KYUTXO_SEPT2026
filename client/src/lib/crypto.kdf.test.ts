// Round-trip + parameter-isolation tests for the strengthened vault/backup KDF
// (PBKDF2-HMAC-SHA-256 raised from 100k to 600k iterations, with the count now
// traveling alongside the salt). Covers:
//
//   1. new derivations default to the CURRENT (strengthened) iteration count,
//   2. explicit LEGACY parameters still round-trip (old vaults/backups stay
//      decryptable),
//   3. parameters are load-bearing: a hash/key derived at one iteration count
//      does NOT verify/decrypt at the other,
//   4. derivation-time sanity: the strengthened count completes well inside a
//      generous bound even on slow CI hardware (a pathological regression —
//      e.g. an accidental 100x count — would blow past it).
//
// Runs in Node (webcrypto) — no jsdom needed.

import { describe, it, expect } from "vitest";

import {
  deriveKey,
  deriveKeyWithParams,
  hashPassword,
  hashPasswordWithParams,
  verifyPassword,
  verifyPasswordWithParams,
  generateSalt,
  encrypt,
  decrypt,
  LEGACY_PBKDF2_ITERATIONS,
  CURRENT_PBKDF2_ITERATIONS,
  CURRENT_KDF_PARAMS,
  isCurrentKdf,
} from "./crypto";

const PASSWORD = "correct horse battery staple";
const WRONG = "not the password";

describe("KDF constants", () => {
  it("pins the legacy and strengthened iteration counts", () => {
    // These values are load-bearing for backwards compatibility: LEGACY must
    // remain exactly what pre-strengthening builds used, and CURRENT must be
    // strictly stronger.
    expect(LEGACY_PBKDF2_ITERATIONS).toBe(100000);
    expect(CURRENT_PBKDF2_ITERATIONS).toBe(600000);
    expect(CURRENT_PBKDF2_ITERATIONS).toBeGreaterThan(LEGACY_PBKDF2_ITERATIONS);
  });

  it("pins the current KDF to memory-hard Argon2id at/above the chosen floor", () => {
    expect(CURRENT_KDF_PARAMS.algorithm).toBe("argon2id");
    if (CURRENT_KDF_PARAMS.algorithm === "argon2id") {
      // 64 MiB / 3 passes: memory-hard floor. Lowering either silently
      // weakens every new vault/backup — fail loudly instead.
      expect(CURRENT_KDF_PARAMS.memoryKiB).toBeGreaterThanOrEqual(65536);
      expect(CURRENT_KDF_PARAMS.timeCost).toBeGreaterThanOrEqual(3);
      expect(CURRENT_KDF_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
    }
    expect(isCurrentKdf(CURRENT_KDF_PARAMS)).toBe(true);
    expect(isCurrentKdf({ algorithm: "pbkdf2-sha256", iterations: CURRENT_PBKDF2_ITERATIONS })).toBe(false);
    expect(isCurrentKdf({ algorithm: "argon2id", memoryKiB: 19456, timeCost: 2, parallelism: 1 })).toBe(false);
  });
});

describe("Argon2id password hashing (current parameters)", () => {
  it("round-trips and rejects a wrong password", async () => {
    const salt = generateSalt();
    const hash = await hashPasswordWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS);
    expect(await verifyPasswordWithParams(PASSWORD, salt, hash, CURRENT_KDF_PARAMS)).toBe(true);
    expect(await verifyPasswordWithParams(WRONG, salt, hash, CURRENT_KDF_PARAMS)).toBe(false);
  });

  it("is deterministic for the same salt and differs across salts", async () => {
    const salt = generateSalt();
    const h1 = await hashPasswordWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS);
    const h2 = await hashPasswordWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS);
    expect(h1).toBe(h2);
    const h3 = await hashPasswordWithParams(PASSWORD, generateSalt(), CURRENT_KDF_PARAMS);
    expect(h3).not.toBe(h1);
  });

  it("does NOT verify an Argon2id hash under PBKDF2 parameters (and vice versa)", async () => {
    const salt = generateSalt();
    const argonHash = await hashPasswordWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS);
    expect(
      await verifyPasswordWithParams(PASSWORD, salt, argonHash, {
        algorithm: "pbkdf2-sha256",
        iterations: CURRENT_PBKDF2_ITERATIONS,
      }),
    ).toBe(false);
    const pbkdf2Hash = await hashPassword(PASSWORD, salt, CURRENT_PBKDF2_ITERATIONS);
    expect(await verifyPasswordWithParams(PASSWORD, salt, pbkdf2Hash, CURRENT_KDF_PARAMS)).toBe(false);
  });

  it("Argon2id parameters are load-bearing for key derivation", async () => {
    const salt = generateSalt();
    const key = await deriveKeyWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS);
    const ciphertext = await encrypt("argon2id vault payload", key);
    expect(await decrypt(ciphertext, await deriveKeyWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS))).toBe(
      "argon2id vault payload",
    );
    // A different memory cost derives a different key.
    const otherKey = await deriveKeyWithParams(PASSWORD, salt, {
      algorithm: "argon2id",
      memoryKiB: 32768,
      timeCost: 3,
      parallelism: 1,
    });
    await expect(decrypt(ciphertext, otherKey)).rejects.toThrow();
    // And a PBKDF2 key from the same salt/password cannot read it either.
    const pbkdf2Key = await deriveKeyWithParams(PASSWORD, salt, {
      algorithm: "pbkdf2-sha256",
      iterations: CURRENT_PBKDF2_ITERATIONS,
    });
    await expect(decrypt(ciphertext, pbkdf2Key)).rejects.toThrow();
  });

  it("deriveKeyWithParams with PBKDF2 params matches the legacy deriveKey path", async () => {
    const salt = generateSalt();
    const viaParams = await deriveKeyWithParams(PASSWORD, salt, {
      algorithm: "pbkdf2-sha256",
      iterations: LEGACY_PBKDF2_ITERATIONS,
    });
    const ciphertext = await encrypt("legacy payload", viaParams);
    const legacyKey = await deriveKey(PASSWORD, salt, LEGACY_PBKDF2_ITERATIONS);
    expect(await decrypt(ciphertext, legacyKey)).toBe("legacy payload");
  });
});

describe("password hashing with current (default) parameters", () => {
  it("round-trips and rejects a wrong password", async () => {
    const salt = generateSalt();
    const hash = await hashPassword(PASSWORD, salt);
    expect(await verifyPassword(PASSWORD, salt, hash)).toBe(true);
    expect(await verifyPassword(WRONG, salt, hash)).toBe(false);
  });
});

describe("password hashing with explicit legacy parameters", () => {
  it("round-trips a pre-strengthening vault hash", async () => {
    const salt = generateSalt();
    const hash = await hashPassword(PASSWORD, salt, LEGACY_PBKDF2_ITERATIONS);
    expect(await verifyPassword(PASSWORD, salt, hash, LEGACY_PBKDF2_ITERATIONS)).toBe(true);
    expect(await verifyPassword(WRONG, salt, hash, LEGACY_PBKDF2_ITERATIONS)).toBe(false);
  });

  it("does NOT verify a legacy hash against the current iteration count", async () => {
    const salt = generateSalt();
    const legacyHash = await hashPassword(PASSWORD, salt, LEGACY_PBKDF2_ITERATIONS);
    // Verifying with the wrong (current) parameters must fail — this is what
    // makes the recorded parameter set load-bearing rather than cosmetic.
    expect(await verifyPassword(PASSWORD, salt, legacyHash, CURRENT_PBKDF2_ITERATIONS)).toBe(false);
  });
});

describe("encryption keys with both parameter sets", () => {
  it.each([
    ["legacy", LEGACY_PBKDF2_ITERATIONS],
    ["current", CURRENT_PBKDF2_ITERATIONS],
  ])("encrypts/decrypts with a %s-parameters key", async (_label, iterations) => {
    const salt = generateSalt();
    const key = await deriveKey(PASSWORD, salt, iterations);
    const ciphertext = await encrypt("vault secret payload", key);
    expect(await decrypt(ciphertext, key)).toBe("vault secret payload");
  });

  it("a legacy-parameters ciphertext is unreadable under a current-parameters key", async () => {
    const salt = generateSalt();
    const legacyKey = await deriveKey(PASSWORD, salt, LEGACY_PBKDF2_ITERATIONS);
    const ciphertext = await encrypt("old backup body", legacyKey);
    const currentKey = await deriveKey(PASSWORD, salt, CURRENT_PBKDF2_ITERATIONS);
    await expect(decrypt(ciphertext, currentKey)).rejects.toThrow();
  });
});

describe("derivation-time sanity", () => {
  it("completes a strengthened derivation well inside the acceptable bound", async () => {
    const salt = generateSalt();
    const t0 = performance.now();
    await hashPassword(PASSWORD, salt, CURRENT_PBKDF2_ITERATIONS);
    const ms = performance.now() - t0;
    console.log(`[kdf-bench] PBKDF2-SHA256 x${CURRENT_PBKDF2_ITERATIONS}: ${ms.toFixed(0)}ms`);
    // Typical desktop hardware does this in a few hundred ms; the bound is a
    // pathology tripwire (e.g. an accidental extra 10x on the count), not a
    // performance assertion, so slow CI machines must still pass.
    expect(ms).toBeLessThan(15000);
  });

  it("completes an Argon2id derivation inside the acceptable bound", async () => {
    const salt = generateSalt();
    const t0 = performance.now();
    await hashPasswordWithParams(PASSWORD, salt, CURRENT_KDF_PARAMS);
    const ms = performance.now() - t0;
    console.log(`[kdf-bench] Argon2id m=64MiB t=3 p=1: ${ms.toFixed(0)}ms`);
    // Pathology tripwire, not a performance assertion: an accidental 10x on
    // memory/passes would blow well past this even on slow CI hardware.
    expect(ms).toBeLessThan(20000);
  });
});
