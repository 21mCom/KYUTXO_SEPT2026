import { db } from '../database';
import { getElectronAPISafe } from '../electron';
import { DexieVaultRepository } from './dexie';
import { ProtectedVaultRepository } from './protected';
import type { VaultRepository } from './contracts';

export * from './contracts';
export { DexieVaultRepository } from './dexie';
export { ProtectedVaultRepository } from './protected';

let browserRepository: VaultRepository | undefined;
let protectedRepository: VaultRepository | undefined;

/** Select exactly one live backend. Desktop never selects the Dexie adapter. */
export function getVaultRepository(): VaultRepository {
  // Electron development deliberately retains the explicitly visible Dexie
  // fallback. A packaged renderer must select only the protected store.
  if (getElectronAPISafe()?.isElectron && !import.meta.env.DEV) {
    return protectedRepository ??= new ProtectedVaultRepository();
  }
  return browserRepository ??= new DexieVaultRepository(db);
}

/** Startup callers can use this to prove the selected packaged store is open. */
export async function verifyVaultRepository(): Promise<VaultRepository> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    const status = await getElectronAPISafe()!.protectedStore.status();
    if (!status.ok || !status.result?.available || !status.result.unlocked || !status.result.verified || status.result.ready !== true) {
      throw new Error(status.error || 'Protected vault is not unlocked and verified');
    }
  }
  return repository;
}