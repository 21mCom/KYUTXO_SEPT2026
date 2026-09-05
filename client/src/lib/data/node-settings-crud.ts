import { db, notifyDbChange, type NodeSettings } from '../database';
import { getVaultRepository } from '../repository';

export interface NodeSettingsWriteOptions {
  skipNotification?: boolean;
}

export async function getNodeSettings(id: string = 'default'): Promise<NodeSettings | undefined> {
  const repository = getVaultRepository();
  return repository.kind === 'protected' ? repository.get('nodeSettings', id) : db.nodeSettings.get(id);
}

export async function getAllNodeSettings(): Promise<NodeSettings[]> {
  const repository = getVaultRepository();
  if (repository.kind !== 'protected') return db.nodeSettings.toArray();
  const rows: NodeSettings[] = [];
  let cursor: string | number | undefined;
  do {
    const page = await repository.list('nodeSettings', { cursor, limit: 1000 });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

export async function addNodeSettings(
  data: NodeSettings,
  options?: NodeSettingsWriteOptions
): Promise<string> {
  const repository = getVaultRepository();
  const id = repository.kind === 'protected' ? await repository.add('nodeSettings', data) : await db.nodeSettings.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('nodeSettings');
  }

  return id as string;
}

export async function putNodeSettings(
  data: NodeSettings,
  options?: NodeSettingsWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.put('nodeSettings', data);
  else await db.nodeSettings.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('nodeSettings');
  }
}

export async function updateNodeSettings(
  id: string,
  changes: Partial<NodeSettings>,
  options?: NodeSettingsWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.update('nodeSettings', id, changes);
  else await db.nodeSettings.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('nodeSettings');
  }
}

export async function clearNodeSettings(
  options?: NodeSettingsWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.clear('nodeSettings');
  else await db.nodeSettings.clear();

  if (!options?.skipNotification) {
    notifyDbChange('nodeSettings');
  }
}
