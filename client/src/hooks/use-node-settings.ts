import { useLiveQuery } from 'dexie-react-hooks';
import { db, NodeSettings, NodeProviderType } from '@/lib/database';

const DEFAULT_NODE_SETTINGS: NodeSettings = {
  id: 'default',
  providerType: 'mempool-space',
  useTor: false,
  requestTimeout: 30000,
  network: 'mainnet',
};

export function useNodeSettings() {
  const settings = useLiveQuery(
    () => db.nodeSettings.get('default'),
    []
  );

  const nodeSettings: NodeSettings = settings ?? DEFAULT_NODE_SETTINGS;

  const updateSettings = async (updates: Partial<Omit<NodeSettings, 'id'>>) => {
    const existing = await db.nodeSettings.get('default');
    if (existing) {
      await db.nodeSettings.update('default', updates);
    } else {
      await db.nodeSettings.put({
        ...DEFAULT_NODE_SETTINGS,
        ...updates,
      });
    }
  };

  const resetToDefaults = async () => {
    await db.nodeSettings.put(DEFAULT_NODE_SETTINGS);
  };

  const setConnectionStatus = async (status: string, connected: boolean) => {
    await updateSettings({
      lastConnectionStatus: status,
      lastConnectedAt: connected ? Date.now() : undefined,
    });
  };

  return {
    nodeSettings,
    updateSettings,
    resetToDefaults,
    setConnectionStatus,
    isLoading: settings === undefined,
  };
}

export function getDefaultNodeSettings(): NodeSettings {
  return { ...DEFAULT_NODE_SETTINGS };
}

export type { NodeSettings, NodeProviderType };
