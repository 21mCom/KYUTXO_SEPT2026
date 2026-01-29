import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, NodeSettings, NodeProviderType, DEFAULT_TRUSTED_LOCAL_HOSTS } from '@/lib/database';

const DEFAULT_NODE_SETTINGS: NodeSettings = {
  id: 'default',
  providerType: 'mempool-space',
  useTor: false,
  requestTimeout: 30000,
  network: 'mainnet',
  allowLocalNetwork: false,  // SECURITY: disabled by default
  trustedLocalHosts: [...DEFAULT_TRUSTED_LOCAL_HOSTS],
  useElectrum: false,
  electrumPort: 50001,
  electrumSSL: false,
};

export function useNodeSettings() {
  const [hasTimedOut, setHasTimedOut] = useState(false);
  
  const settings = useLiveQuery(
    () => db.nodeSettings.get('default'),
    []
  );

  // Timeout fallback - if database doesn't respond in 2 seconds, use defaults
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (settings === undefined) {
        setHasTimedOut(true);
      }
    }, 2000);
    
    return () => clearTimeout(timeout);
  }, [settings]);

  // Use defaults if settings haven't loaded or timed out
  // Also merge in any missing fields (e.g., trustedLocalHosts for existing users)
  const nodeSettings: NodeSettings = settings 
    ? {
        ...DEFAULT_NODE_SETTINGS,
        ...settings,
        // Ensure allowLocalNetwork defaults to false for existing users (security)
        allowLocalNetwork: settings.allowLocalNetwork ?? false,
        // Ensure trustedLocalHosts is always defined (for existing users who don't have it)
        trustedLocalHosts: settings.trustedLocalHosts ?? [...DEFAULT_TRUSTED_LOCAL_HOSTS],
      }
    : DEFAULT_NODE_SETTINGS;

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
    // Only show loading if not timed out and settings haven't loaded
    isLoading: settings === undefined && !hasTimedOut,
  };
}

export function getDefaultNodeSettings(): NodeSettings {
  return { ...DEFAULT_NODE_SETTINGS };
}

export type { NodeSettings, NodeProviderType };
