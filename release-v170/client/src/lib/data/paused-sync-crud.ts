import { db, notifyDbChange, type PausedSyncState } from '../database';
import { getVaultRepository } from '../repository';

export interface PausedSyncStateWriteOptions {
  skipNotification?: boolean;
}

export async function getPausedSyncState(
  id: string = 'default'
): Promise<PausedSyncState | undefined> {
  const repository = getVaultRepository();
  return repository.kind === 'protected' ? repository.get('pausedSyncState', id) : db.pausedSyncState.get(id);
}

export async function putPausedSyncState(
  data: PausedSyncState,
  options?: PausedSyncStateWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.put('pausedSyncState', data);
  else await db.pausedSyncState.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('pausedSyncState');
  }
}

export async function deletePausedSyncState(
  id: string = 'default',
  options?: PausedSyncStateWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.delete('pausedSyncState', id);
  else await db.pausedSyncState.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('pausedSyncState');
  }
}
