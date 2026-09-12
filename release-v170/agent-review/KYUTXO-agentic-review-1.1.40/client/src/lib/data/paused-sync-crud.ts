import { db, notifyDbChange, type PausedSyncState } from '../database';

export interface PausedSyncStateWriteOptions {
  skipNotification?: boolean;
}

export async function getPausedSyncState(
  id: string = 'default'
): Promise<PausedSyncState | undefined> {
  return db.pausedSyncState.get(id);
}

export async function putPausedSyncState(
  data: PausedSyncState,
  options?: PausedSyncStateWriteOptions
): Promise<void> {
  await db.pausedSyncState.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('pausedSyncState');
  }
}

export async function deletePausedSyncState(
  id: string = 'default',
  options?: PausedSyncStateWriteOptions
): Promise<void> {
  await db.pausedSyncState.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('pausedSyncState');
  }
}
