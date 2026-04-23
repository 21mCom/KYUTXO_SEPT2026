// Vault storage for encrypted app credentials
// This stores the salt and password hash for authentication

import Dexie, { type Table } from 'dexie';

export interface VaultSettings {
  id: string;
  salt: string; // Base64 encoded salt
  passwordHash: string; // PBKDF2 hash for verification
  createdAt: number;
  migrationComplete?: boolean; // Flag indicating if plaintext data has been migrated
  attachmentPathsMigrated?: boolean; // Flag indicating attachment dirs have been hashed
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

// Check if vault is initialized (password has been set)
export async function isVaultInitialized(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return !!settings;
}

// Get vault settings
export async function getVaultSettings(): Promise<VaultSettings | undefined> {
  return vaultDb.vault.get('main');
}

// Save vault settings (called during initial setup)
export async function saveVaultSettings(salt: string, passwordHash: string): Promise<void> {
  await vaultDb.vault.put({
    id: 'main',
    salt,
    passwordHash,
    createdAt: Date.now(),
  });
}

// Clear vault (for password reset - WARNING: all data will be lost)
export async function clearVault(): Promise<void> {
  await vaultDb.vault.clear();
}

// Check if migration is complete
export async function isMigrationComplete(): Promise<boolean> {
  const settings = await vaultDb.vault.get('main');
  return settings?.migrationComplete ?? false;
}

// Set migration complete flag
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

