import Dexie, { type Table } from 'dexie';

export interface VaultSettings {
  id: string;
  salt: string;
  passwordHash: string;
  createdAt: number;
  migrationComplete?: boolean;
  attachmentPathsMigrated?: boolean;
  legacyDecryptComplete?: boolean;
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

export async function saveVaultSettings(salt: string, passwordHash: string): Promise<void> {
  await vaultDb.vault.put({
    id: 'main',
    salt,
    passwordHash,
    createdAt: Date.now(),
  });
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
