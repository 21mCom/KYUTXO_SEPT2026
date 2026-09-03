import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { NodeSettings, NodeProviderType, DEFAULT_TRUSTED_LOCAL_HOSTS } from '@/lib/database';
import {
  getNodeSettings,
  putNodeSettings,
  updateNodeSettings as updateStoredNodeSettings,
} from '@/lib/data/node-settings-crud';
import {
  canonicalizeTorProxyUrl,
  syncTorProxySettings,
  torProxySettingsFromNodeSettings,
} from '@/lib/tor-proxy-settings-sync';

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
    () => getNodeSettings('default'),
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

  // Migrate legacy socks5:// values in-place. socks5 delegates destination DNS
  // to the local resolver; socks5h sends the hostname through Tor instead.
  useEffect(() => {
    if (!settings?.torProxyUrl) return;
    const normalized = canonicalizeTorProxyUrl(settings.torProxyUrl);
    if (normalized.ok && normalized.migrated && normalized.value) {
      void updateStoredNodeSettings('default', { torProxyUrl: normalized.value });
    }
  }, [settings?.torProxyUrl]);

  // Keep the Tor proxy's server-side allowlist/proxy settings in sync with the
  // stored node settings (deduped — only pushes when they actually change).
  const syncKey = JSON.stringify([
    nodeSettings.providerType,
    nodeSettings.customUrl,
    nodeSettings.allowLocalNetwork,
    nodeSettings.trustedLocalHosts,
    nodeSettings.torProxyUrl,
  ]);
  useEffect(() => {
    void syncTorProxySettings(torProxySettingsFromNodeSettings(nodeSettings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  const updateSettings = async (updates: Partial<Omit<NodeSettings, 'id'>>) => {
    const existing = await getNodeSettings('default');
    if (existing) {
      await updateStoredNodeSettings('default', updates);
    } else {
      await putNodeSettings({
        ...DEFAULT_NODE_SETTINGS,
        ...updates,
      });
    }
  };

  const resetToDefaults = async () => {
    await putNodeSettings(DEFAULT_NODE_SETTINGS);
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
