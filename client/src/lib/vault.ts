import Dexie, { type Table } from 'dexie';
import {
  base64ToBuffer,
  hashPassword,
  CURRENT_PBKDF2_ITERATIONS,
  LEGACY_PBKDF2_ITERATIONS,
} from './crypto';

export interface VaultSettings {
  id: string;
  salt: string;
  passwordHash: string;
  // PBKDF2 iterations the stored passwordHash was derived with. Absent on
  // vaults created before the KDF strengthening — those are ALWAYS legacy
  // (100k). See getVaultKdfIterations.
  kdfIterations?: number;
  createdAt: number;
  migrationComplete?: boolean;
  attachmentPathsMigrated?: boolean;
  legacyDecryptComplete?: boolean;
  legacyDecryptCompletedTables?: string[];
  legacyFileDecryptComplete?: boolean;
  legacyFileDecryptCheckpoint?: { tableIndex: number; lastId: number };
  inputStringLowerRepaired?: boolean;
  searchVisibilityRepaired?: boolean;
}

class VaultDatabase extends Dexie {
  vault!: Table<VaultSettings>;

  constructor() {
    super('kybtc-vault');
    this.version(1).stores({
      vault: 'id',
    });
  }
}

export const vaultDb = new VaultDatabase();

export async function isVaultInitialized(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return !!settings;
}

export async function getVaultSettings(): Promise<VaultSettings | undefined> {
  return vaultDb.vault.get('main');
}

export async function saveVaultSettings(
  salt: string,
  passwordHash: string,
  kdfIterations: number = CURRENT_PBKDF2_ITERATIONS,
): Promise<void> {
  await vaultDb.vault.put({
    id: 'main',
    salt,
    passwordHash,
    kdfIterations,
    createdAt: Date.now(),
  });
}

// Iteration count the stored passwordHash was derived with. Vault rows written
// before the KDF strengthening carry no kdfIterations field and are always
// legacy (100k).
export function getVaultKdfIterations(settings: VaultSettings): number {
  return settings.kdfIterations ?? LEGACY_PBKDF2_ITERATIONS;
}

// Transparent KDF upgrade: after a successful unlock with legacy parameters,
// re-derive the password hash at the current iteration count and re-store it.
// The SALT IS KEPT — legacy at-rest payloads are decrypted with a key derived
// from this salt at LEGACY iterations (see runLegacyDecryptMigration), so
// rotating it would permanently orphan any not-yet-migrated locked data. Only
// the hash parameters change.
export async function upgradeVaultKdfIfNeeded(
  password: string,
  settings: VaultSettings,
): Promise<boolean> {
  if (getVaultKdfIterations(settings) >= CURRENT_PBKDF2_ITERATIONS) return false;
  const salt = base64ToBuffer(settings.salt);
  const passwordHash = await hashPassword(password, salt, CURRENT_PBKDF2_ITERATIONS);
  await vaultDb.vault.update('main', {
    passwordHash,
    kdfIterations: CURRENT_PBKDF2_ITERATIONS,
  });
  return true;
}

export async function clearVault(): Promise<void> {
  await vaultDb.vault.clear();
}

export async function isMigrationComplete(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return settings?.migrationComplete ?? false;
}

export async function setMigrationComplete(complete: boolean): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', { migrationComplete: complete });
  }
}

export async function isAttachmentPathsMigrated(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return settings?.attachmentPathsMigrated ?? false;
}

export async function setAttachmentPathsMigrated(migrated: boolean): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', { attachmentPathsMigrated: migrated });
  }
}

export async function isLegacyDecryptComplete(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return settings?.legacyDecryptComplete ?? false;
}

export async function setLegacyDecryptComplete(complete: boolean): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', { legacyDecryptComplete: complete });
  }
}

export async function getLegacyDecryptCompletedTables(): Promise<string[]> {
  const settings = await vaultDb.vault.get('main');
  return settings?.legacyDecryptCompletedTables ?? [];
}

export async function addLegacyDecryptCompletedTable(tableName: string): Promise<void> {
  await vaultDb.transaction('rw', vaultDb.vault, async () => {
    const settings = await vaultDb.vault.get('main');
    if (settings) {
      const current = settings.legacyDecryptCompletedTables ?? [];
      if (!current.includes(tableName)) {
        await vaultDb.vault.update('main', {
          legacyDecryptCompletedTables: [...current, tableName],
        });
      }
    }
  });
}

/**
 * Reset legacy-decrypt progress so a fresh restore pass scans EVERY table from
 * scratch. A past bug could set legacyDecryptComplete=true after a mid-table
 * abort, which permanently short-circuits login decryption and leaves rows
 * locked. Clearing both the flag and the per-table checkpoint list forces
 * decryptLegacyRecords to revisit all tables. No-ops safely when no vault row
 * exists (e.g. unit tests that seed data without a vault).
 */
export async function resetLegacyDecryptProgress(): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', {
      legacyDecryptComplete: false,
      legacyDecryptCompletedTables: [],
    });
  }
}

export async function isInputStringLowerRepaired(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return settings?.inputStringLowerRepaired ?? false;
}

export async function setInputStringLowerRepaired(repaired: boolean): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', { inputStringLowerRepaired: repaired });
  }
}

/**
 * Once-per-vault-generation flag for the startup search-visibility repair pass
 * (invalid/missing importance tiers + desynced inputStringLower search keys —
 * the two data classes that make old records unfindable in Records search).
 * Set only when the pass fully succeeds; re-armed (set false) after any backup
 * restore, because restores of old backups can reintroduce both classes.
 */
export async function isSearchVisibilityRepaired(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return settings?.searchVisibilityRepaired ?? false;
}

export async function setSearchVisibilityRepaired(repaired: boolean): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', { searchVisibilityRepaired: repaired });
  }
}

/**
 * Re-arm the startup search-visibility repair so it runs again on the next
 * login. Called after a backup restore completes (both v3 and legacy paths):
 * restored rows can carry legacy/unknown importance tiers or stale search
 * keys verbatim from old backups. No-ops safely when no vault row exists.
 */
export async function rearmSearchVisibilityRepair(): Promise<void> {
  await setSearchVisibilityRepaired(false);
}

export async function isLegacyFileDecryptComplete(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return settings?.legacyFileDecryptComplete ?? false;
}

export async function setLegacyFileDecryptComplete(complete: boolean): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', { legacyFileDecryptComplete: complete });
  }
}

export async function getLegacyFileDecryptCheckpoint(): Promise<{ tableIndex: number; lastId: number } | null> {
  const settings = await vaultDb.vault.get('main');
  return settings?.legacyFileDecryptCheckpoint ?? null;
}

export async function setLegacyFileDecryptCheckpoint(
  checkpoint: { tableIndex: number; lastId: number },
): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', { legacyFileDecryptCheckpoint: checkpoint });
  }
}

/**
 * Mark every one-time startup migration as already done. Called immediately after
 * a BRAND-NEW vault is created: a fresh vault has no legacy/un-normalised data, so
 * there is nothing to scan, decrypt, or repair. Without this, the very first login
 * of a large fresh vault would needlessly walk every big table looking for legacy
 * rows that cannot exist. Uses update() so it merges onto the row saved by
 * saveVaultSettings without clobbering salt/passwordHash.
 */
export async function markFreshVaultMigrationsComplete(): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', {
      attachmentPathsMigrated: true,
      legacyDecryptComplete: true,
      legacyFileDecryptComplete: true,
      inputStringLowerRepaired: true,
      searchVisibilityRepaired: true,
    });
  }
}

/**
 * DEV-ONLY: undo markFreshVaultMigrationsComplete so a generated legacy fixture
 * actually exercises the runtime repair passes on the next login. No-ops safely
 * when no vault row exists (e.g. unit tests that seed data without a vault).
 */
export async function resetMigrationFlagsForLegacyFixture(): Promise<void> {
  const settings = await vaultDb.vault.get('main');
  if (settings) {
    await vaultDb.vault.update('main', {
      attachmentPathsMigrated: false,
      legacyDecryptComplete: false,
      legacyDecryptCompletedTables: [],
      legacyFileDecryptComplete: false,
      legacyFileDecryptCheckpoint: { tableIndex: 0, lastId: 0 },
      inputStringLowerRepaired: false,
      searchVisibilityRepaired: false,
    });
  }
}
