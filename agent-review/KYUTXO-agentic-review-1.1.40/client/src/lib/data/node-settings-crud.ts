import { db, notifyDbChange, type NodeSettings } from '../database';

export interface NodeSettingsWriteOptions {
  skipNotification?: boolean;
}

export async function getNodeSettings(id: string = 'default'): Promise<NodeSettings | undefined> {
  return db.nodeSettings.get(id);
}

export async function getAllNodeSettings(): Promise<NodeSettings[]> {
  return db.nodeSettings.toArray();
}

export async function addNodeSettings(
  data: NodeSettings,
  options?: NodeSettingsWriteOptions
): Promise<string> {
  const id = await db.nodeSettings.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('nodeSettings');
  }

  return id as string;
}

export async function putNodeSettings(
  data: NodeSettings,
  options?: NodeSettingsWriteOptions
): Promise<void> {
  await db.nodeSettings.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('nodeSettings');
  }
}

export async function updateNodeSettings(
  id: string,
  changes: Partial<NodeSettings>,
  options?: NodeSettingsWriteOptions
): Promise<void> {
  await db.nodeSettings.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('nodeSettings');
  }
}

export async function clearNodeSettings(
  options?: NodeSettingsWriteOptions
): Promise<void> {
  await db.nodeSettings.clear();

  if (!options?.skipNotification) {
    notifyDbChange('nodeSettings');
  }
}
