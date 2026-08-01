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
  hashPassword,
  verifyPassword,
  generateSalt,
  encrypt,
  decrypt,
  LEGACY_PBKDF2_ITERATIONS,
  CURRENT_PBKDF2_ITERATIONS,
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
});
