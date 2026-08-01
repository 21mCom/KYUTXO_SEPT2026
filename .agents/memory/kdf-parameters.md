---
name: Vault/backup KDF parameters
description: KDF record (Argon2id/PBKDF2) travels with the salt; absent always means legacy 100k PBKDF2; legacy at-rest decryption is pinned to LEGACY forever; Argon2id needs 'wasm-unsafe-eval' in the packaged CSP.
---

The vault password KDF evolved: PBKDF2-HMAC-SHA-256 100k (legacy) -> 600k
(strengthening era) -> Argon2id via hash-wasm (current, m=64MiB t=3 p=1;
CURRENT_KDF_PARAMS in client/src/lib/crypto.ts). Rules future work must keep:

- Parameters are recorded alongside the salt as a full record
  (VaultSettings.kdf / BackupManifest.kdf, taking precedence over the older
  numeric kdfIterations field). Resolution: explicit `kdf` > `kdfIterations`
  (PBKDF2 at that count) > nothing = LEGACY 100k PBKDF2. Always resolve via
  getVaultKdfParams / getBackupKdfParams, never by assuming.
- New derivations go through deriveKeyWithParams / hashPasswordWithParams /
  verifyPasswordWithParams. The bare PBKDF2 helpers remain only for legacy
  paths pinned to a known iteration count.
- Legacy at-rest encrypted payloads were only ever produced at PBKDF2 100k, so
  their decryption stays pinned to LEGACY even after a vault upgrades. The KDF
  upgrade (upgradeVaultKdfIfNeeded, gated by isCurrentKdf) re-derives ONLY the
  password hash and KEEPS THE SAME SALT — rotating the salt would permanently
  orphan not-yet-migrated locked data.
- hash-wasm inlines its wasm in the JS bundle (no locateFile/asset problems),
  but WebAssembly compilation under the packaged app's CSP requires
  'wasm-unsafe-eval' in script-src (electron/main.cjs). Node tests cannot see
  this class of failure — scripts/check-argon2-kdf-browser.mjs is the
  real-browser gate.

**Why:** an exported backup is the offline brute-force target, so parameters
must be self-describing; PBKDF2 alone is GPU-cheap, hence memory-hard Argon2id;
and the salt is shared between the login hash and the legacy at-rest
encryption key, coupling upgrade to migration state.

**How to apply:** when touching crypto.ts call sites, backup formats, or the
legacy-decrypt migration, check which parameter record the data was written
with rather than accepting defaults; never silently fall back to a weaker KDF
when wasm fails.
