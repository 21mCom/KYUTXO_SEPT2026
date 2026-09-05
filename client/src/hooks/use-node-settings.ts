import { useState, useEffect, useMemo } from 'react';
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
import {
  getForgottenNetworkSourceUpdates,
  replaceRuntimeNetworkSettings,
  serializeNodeSettingsWrite,
  setRuntimeNetworkSettings,
  updateRuntimeNetworkSettings,
} from '@/lib/network-privacy';

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

const UNRESOLVED_NODE_SETTINGS: NodeSettings = {
  ...DEFAULT_NODE_SETTINGS,
  networkAccessEnabled: false,
  networkOnboardingStage: 'source',
};

function getResetSettings(current: NodeSettings): NodeSettings {
  return {
    ...DEFAULT_NODE_SETTINGS,
    networkAccessEnabled: current.networkAccessEnabled,
    networkOnboardingStage: current.networkOnboardingStage,
    networkPrivacyMode: current.networkPrivacyMode === undefined
      ? undefined
      : 'public-direct',
    networkPrivacyChosenAt: current.networkPrivacyChosenAt,
    firstSyncConfirmedAt: current.firstSyncConfirmedAt,
  };
}

export function useNodeSettings() {
  const [hasTimedOut, setHasTimedOut] = useState(false);
  
  const queryResult = useLiveQuery(
    async () => ({ settings: await getNodeSettings('default') }),
    []
  );
  const queryResolved = queryResult !== undefined;
  const settings = queryResult?.settings;

  // Timeout fallback - if database doesn't respond in 2 seconds, use defaults
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!queryResolved) {
        setHasTimedOut(true);
      }
    }, 2000);
    
    return () => clearTimeout(timeout);
  }, [queryResolved]);

  // Use defaults if settings haven't loaded or timed out
  // Also merge in any missing fields (e.g., trustedLocalHosts for existing users)
  const nodeSettings: NodeSettings = useMemo(() => {
    if (!queryResolved) return UNRESOLVED_NODE_SETTINGS;
    if (!settings) return DEFAULT_NODE_SETTINGS;
    return {
        ...DEFAULT_NODE_SETTINGS,
        ...settings,
        // Ensure allowLocalNetwork defaults to false for existing users (security)
        allowLocalNetwork: settings.allowLocalNetwork ?? false,
        // Ensure trustedLocalHosts is always defined (for existing users who don't have it)
        trustedLocalHosts: settings.trustedLocalHosts ?? [...DEFAULT_TRUSTED_LOCAL_HOSTS],
      };
  }, [queryResolved, settings]);

  // Only a new persisted snapshot may replace an optimistic runtime update.
  // Ordinary component renders must never race an offline-switch write by
  // restoring the previous live-query value.
  useEffect(() => {
    if (queryResolved) setRuntimeNetworkSettings(nodeSettings);
  }, [queryResolved, nodeSettings]);

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
    updateRuntimeNetworkSettings(updates, nodeSettings);
    await serializeNodeSettingsWrite(async () => {
      const existing = await getNodeSettings('default');
      const latestSettings = {
        ...DEFAULT_NODE_SETTINGS,
        ...existing,
        ...updates,
      };
      if (existing) {
        await updateStoredNodeSettings('default', updates);
      } else {
        await putNodeSettings(latestSettings);
      }
    });
  };

  const resetToDefaults = async () => {
    replaceRuntimeNetworkSettings(getResetSettings, nodeSettings);
    await serializeNodeSettingsWrite(async () => {
      const existing = await getNodeSettings('default');
      await putNodeSettings(getResetSettings({
        ...DEFAULT_NODE_SETTINGS,
        ...existing,
      }));
    });
  };

  const forgetNetworkSource = async () => {
    await updateSettings(getForgottenNetworkSourceUpdates());
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
    forgetNetworkSource,
    resetToDefaults,
    setConnectionStatus,
    // Only show loading if not timed out and settings haven't loaded
    isLoading: !queryResolved && !hasTimedOut,
  };
}

export function getDefaultNodeSettings(): NodeSettings {
  return { ...DEFAULT_NODE_SETTINGS };
}

export type { NodeSettings, NodeProviderType };
