---
name: Vault/backup KDF parameters
description: PBKDF2 iteration count travels with the salt; absent always means legacy 100k; legacy at-rest decryption is pinned to LEGACY forever.
---

The vault password KDF was strengthened from PBKDF2-HMAC-SHA-256 100k to 600k
iterations (LEGACY_PBKDF2_ITERATIONS / CURRENT_PBKDF2_ITERATIONS in
client/src/lib/crypto.ts). Rules future work must keep:

- The iteration count is recorded alongside the salt (VaultSettings.kdfIterations,
  BackupManifest.kdfIterations). An ABSENT parameter always means LEGACY 100k —
  resolve via getVaultKdfIterations / getBackupKdfIterations, never by assuming.
- Any new consumer of deriveKey/hashPassword/verifyPassword must thread the
  resolved parameters explicitly; the function defaults are CURRENT, which is
  WRONG for anything written by a pre-strengthening build (legacy backups,
  legacy at-rest payloads, legacy test fixtures).
- Legacy at-rest encrypted payloads were only ever produced at 100k, so their
  decryption stays pinned to LEGACY even after a vault upgrades. The KDF
  upgrade therefore re-derives ONLY the password hash and KEEPS THE SAME SALT —
  rotating the salt would permanently orphan not-yet-migrated locked data.

**Why:** an exported backup is the offline brute-force target, so parameters
must be self-describing; and the salt is shared between the login hash and the
legacy at-rest encryption key, coupling upgrade to migration state.

**How to apply:** when touching crypto.ts call sites, backup formats, or the
legacy-decrypt migration, check which parameter set the data was written with
rather than accepting defaults.
