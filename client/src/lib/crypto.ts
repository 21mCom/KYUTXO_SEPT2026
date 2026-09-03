import { argon2id } from 'hash-wasm';

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

// PBKDF2-HMAC-SHA-256 iteration counts. Vaults/backups created before the KDF
// strengthening used 100k and never recorded the count anywhere — an absent
// parameter ALWAYS means LEGACY. The 600k count was the strengthened PBKDF2
// step (OWASP guidance) and remains readable; new derivations now use Argon2id
// (see CURRENT_KDF_PARAMS). The parameters are stored alongside the salt
// (vault settings row / backup manifest) so old entries stay decryptable.
export const LEGACY_PBKDF2_ITERATIONS = 100000;
export const CURRENT_PBKDF2_ITERATIONS = 600000;

// KDF record versions. Records without a version predate domain separation and
// MUST continue using the raw derivation so existing vaults and backups remain
// readable. Version 2 derives independent outputs for password verification and
// encryption by including a purpose-specific label in the KDF salt input.
export const LEGACY_KDF_VERSION = 1;
export const CURRENT_KDF_VERSION = 2;
export const PASSWORD_VERIFIER_LABEL = 'KYUTXO/KDF/v2/password-verifier';
export const ENCRYPTION_KEY_LABEL = 'KYUTXO/KDF/v2/encryption-key';

// ---- KDF parameter record --------------------------------------------------
//
// Every vault row / backup manifest records WHICH algorithm and parameters its
// stored hash / encryption key was derived with. Resolution rules:
//   - explicit `kdf` record        -> use it verbatim
//   - only `kdfIterations`         -> PBKDF2 at that count (strengthening era)
//   - neither                      -> PBKDF2 at LEGACY 100k (pre-strengthening)
export type KdfParams =
  | { algorithm: 'pbkdf2-sha256'; iterations: number; version?: 1 | 2 }
  | {
      algorithm: 'argon2id';
      /** Memory cost in KiB. */
      memoryKiB: number;
      /** Number of passes (Argon2 "time cost" / iterations). */
      timeCost: number;
      /** Lanes. hash-wasm computes them sequentially; keep low. */
      parallelism: number;
      version?: 1 | 2;
    };

// Current defaults for NEW vaults/backups: Argon2id, 64 MiB, 3 passes, 1 lane.
// Memory-hard, so GPU/ASIC brute force against an exported backup pays the
// 64 MiB per-guess cost that PBKDF2 never imposed. 64 MiB stays comfortably
// inside the renderer's memory headroom (a single transient buffer, freed
// after derivation) and derives in ~0.3s on mid hardware / ~1-2s on low-end —
// an intentional unlock-time cost. Exceeds OWASP's Argon2id minimum
// (19 MiB / t=2 / p=1).
export const CURRENT_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 65536,
  timeCost: 3,
  parallelism: 1,
  version: CURRENT_KDF_VERSION,
};

export function isCurrentKdf(params: KdfParams): boolean {
  return (
    params.version === CURRENT_KDF_VERSION &&
    params.algorithm === 'argon2id' &&
    params.memoryKiB >= 65536 &&
    params.timeCost >= 3
  );
}

function getKdfSalt(
  salt: Uint8Array,
  label: string,
  params: KdfParams,
): Uint8Array {
  const version = (params as { version?: unknown }).version;
  if (version == null || version === LEGACY_KDF_VERSION) {
    return salt;
  }
  if (version !== CURRENT_KDF_VERSION) {
    throw new Error(`Unsupported KDF version: ${String(version)}`);
  }

  const labelBytes = new TextEncoder().encode(label);
  // Keep the caller's random salt intact as the prefix and add an unambiguous
  // separator before the purpose label. This preserves the old salt for legacy
  // records while making the two version-2 outputs cryptographically distinct.
  const derivedSalt = new Uint8Array(salt.length + 1 + labelBytes.length);
  derivedSalt.set(salt, 0);
  derivedSalt[salt.length] = 0;
  derivedSalt.set(labelBytes, salt.length + 1);
  return derivedSalt;
}

// Raw 32-byte Argon2id derivation (hash-wasm; wasm is inlined in the bundle so
// there is no separate .wasm asset to locate in Vite dev or the packaged app).
// Throws loudly on wasm failure — callers must never silently fall back to a
// weaker KDF.
async function argon2idBits(
  password: string,
  salt: Uint8Array,
  params: Extract<KdfParams, { algorithm: 'argon2id' }>,
): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    memorySize: params.memoryKiB,
    iterations: params.timeCost,
    parallelism: params.parallelism,
    hashLength: KEY_LENGTH / 8,
    outputType: 'binary',
  });
}

// Derive an AES-GCM encryption key with an explicit KDF parameter record.
export async function deriveKeyWithParams(
  password: string,
  salt: Uint8Array,
  params: KdfParams = CURRENT_KDF_PARAMS,
): Promise<CryptoKey> {
  const derivationSalt = getKdfSalt(salt, ENCRYPTION_KEY_LABEL, params);
  if (params.algorithm === 'pbkdf2-sha256') {
    return deriveKey(password, derivationSalt, params.iterations);
  }
  const bits = await argon2idBits(password, derivationSalt, params);
  return crypto.subtle.importKey(
    'raw',
    bits,
    { name: 'AES-GCM', length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt'],
  );
}

// Hash a password for storage with an explicit KDF parameter record.
export async function hashPasswordWithParams(
  password: string,
  salt: Uint8Array,
  params: KdfParams = CURRENT_KDF_PARAMS,
): Promise<string> {
  const derivationSalt = getKdfSalt(salt, PASSWORD_VERIFIER_LABEL, params);
  if (params.algorithm === 'pbkdf2-sha256') {
    return hashPassword(password, derivationSalt, params.iterations);
  }
  const bits = await argon2idBits(password, derivationSalt, params);
  return bufferToBase64(bits);
}

export async function verifyPasswordWithParams(
  password: string,
  salt: Uint8Array,
  storedHash: string,
  params: KdfParams,
): Promise<boolean> {
  const hash = await hashPasswordWithParams(password, salt, params);
  return constantTimeEquals(hash, storedHash);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = CURRENT_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  );
}

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
}

export async function encrypt(data: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const iv = generateIV();
  
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data)
  );

  const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedBuffer), iv.length);

  return bufferToBase64(combined);
}

export async function decrypt(encryptedData: string, key: CryptoKey): Promise<string> {
  const combined = base64ToBuffer(encryptedData);
  
  const iv = combined.slice(0, IV_LENGTH);
  const encrypted = combined.slice(IV_LENGTH);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted
  );

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}

export async function decryptBinary(encryptedData: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const combined = new Uint8Array(encryptedData);
  const iv = combined.slice(0, IV_LENGTH);
  const encrypted = combined.slice(IV_LENGTH);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted
  );
}

export function bufferToBase64(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary);
}

export function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function hashPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = CURRENT_PBKDF2_ITERATIONS,
): Promise<string> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    256
  );

  return bufferToBase64(new Uint8Array(hashBuffer));
}

export async function verifyPassword(
  password: string,
  salt: Uint8Array,
  storedHash: string,
  iterations: number = CURRENT_PBKDF2_ITERATIONS,
): Promise<boolean> {
  const hash = await hashPassword(password, salt, iterations);
  return constantTimeEquals(hash, storedHash);
}
