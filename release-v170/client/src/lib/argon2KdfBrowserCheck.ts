// Real-browser self-check for the Argon2id vault/backup KDF (hash-wasm).
//
// Unit tests run in Node, where WebAssembly compilation always works and no
// CSP applies, so they CANNOT catch a browser-only wasm-loading failure (the
// exact class the sqlite-wasm work hit: bundler/asset-resolution differences
// only show up in the actual Vite-served bundle). This module is loaded by
// scripts/check-argon2-kdf-browser.mjs inside real headless Chromium via a
// dynamic '/src/...' import and exercises the full derivation surface:
//
//   1. Argon2id hash round-trip (verify accepts right password, rejects wrong)
//   2. Argon2id AES-GCM key round-trip (encrypt/decrypt)
//   3. legacy + strengthened PBKDF2 params still derive (backward compat)
//   4. derivation-time benchmark, reported for parameter sanity
//
// It never touches the vault database — pure crypto, safe to run anywhere.

import {
  generateSalt,
  hashPasswordWithParams,
  verifyPasswordWithParams,
  deriveKeyWithParams,
  encrypt,
  decrypt,
  CURRENT_KDF_PARAMS,
  LEGACY_PBKDF2_ITERATIONS,
  CURRENT_PBKDF2_ITERATIONS,
  base64ToBuffer,
} from './crypto';

export interface Argon2KdfCheckStep {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Argon2KdfCheckReport {
  ok: boolean;
  bufferGlobalPresent: boolean;
  argonDeriveMs: number;
  steps: Argon2KdfCheckStep[];
}

export async function runArgon2KdfBrowserCheck(): Promise<Argon2KdfCheckReport> {
  const steps: Argon2KdfCheckStep[] = [];
  const step = (name: string, passed: boolean, detail: string) => {
    steps.push({ name, passed, detail });
  };

  const password = 'argon2-browser-check-password';
  const salt = generateSalt();
  let argonDeriveMs = -1;

  try {
    const t0 = performance.now();
    const hash = await hashPasswordWithParams(password, salt, CURRENT_KDF_PARAMS);
    argonDeriveMs = performance.now() - t0;
    step('argon2id-derive', hash.length > 0, `derived in ${argonDeriveMs.toFixed(0)}ms`);

    const okRight = await verifyPasswordWithParams(password, salt, hash, CURRENT_KDF_PARAMS);
    const okWrong = await verifyPasswordWithParams('wrong-password', salt, hash, CURRENT_KDF_PARAMS);
    step('argon2id-verify', okRight === true && okWrong === false, `right=${okRight} wrong=${okWrong}`);

    const key = await deriveKeyWithParams(password, salt, CURRENT_KDF_PARAMS);
    const verifierBytes = base64ToBuffer(hash);
    const encryptionBytes = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    const outputsDiffer =
      verifierBytes.length === encryptionBytes.length &&
      verifierBytes.some((byte, index) => byte !== encryptionBytes[index]);
    step(
      'argon2id-domain-separation',
      outputsDiffer,
      `verifierBytes=${verifierBytes.length} encryptionBytes=${encryptionBytes.length}`,
    );
    const ciphertext = await encrypt('argon2id browser payload', key);
    const roundTrip = await decrypt(ciphertext, key);
    step('argon2id-aes-roundtrip', roundTrip === 'argon2id browser payload', `decrypted="${roundTrip}"`);

    // Backward compatibility: both PBKDF2 eras must still derive in-browser.
    for (const iterations of [LEGACY_PBKDF2_ITERATIONS, CURRENT_PBKDF2_ITERATIONS]) {
      const pk = await deriveKeyWithParams(password, salt, {
        algorithm: 'pbkdf2-sha256',
        iterations,
      });
      const ct = await encrypt('pbkdf2 payload', pk);
      const rt = await decrypt(ct, pk);
      step(`pbkdf2-${iterations}-roundtrip`, rt === 'pbkdf2 payload', 'ok');
    }
  } catch (err) {
    step('unexpected-error', false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }

  return {
    ok: steps.length > 0 && steps.every((s) => s.passed),
    bufferGlobalPresent: typeof (globalThis as { Buffer?: unknown }).Buffer !== 'undefined',
    argonDeriveMs,
    steps,
  };
}
