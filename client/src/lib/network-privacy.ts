import type {
  NetworkPrivacyMode,
  NodeSettings,
} from './database';
import {
  getNodeSettings,
  putNodeSettings,
  updateNodeSettings,
} from './data/node-settings-crud';
import {
  addNetworkPrivacyActivity,
  type NetworkPrivacyActivityInput,
} from './data/network-privacy-activity-crud';

export const NETWORK_BLOCKED_MESSAGE =
  'Network access is offline. Use the privacy control in the header to enable it.';
export const NETWORK_CHOICE_REQUIRED_MESSAGE =
  'No network source is configured. Configure and enable one in Node Settings before contacting the Bitcoin network.';
export const FIRST_SYNC_CONFIRMATION_REQUIRED_MESSAGE =
  'Review and confirm the first-sync privacy disclosure before syncing.';

export function isNetworkPolicyBlockedMessage(message: string): boolean {
  return message === NETWORK_BLOCKED_MESSAGE || message === NETWORK_CHOICE_REQUIRED_MESSAGE;
}

const FRESH_NODE_SETTINGS: NodeSettings = {
  id: 'default',
  providerType: 'mempool-space',
  useTor: false,
  requestTimeout: 30000,
  network: 'mainnet',
  allowLocalNetwork: false,
  trustedLocalHosts: [],
  useElectrum: false,
  electrumPort: 50001,
  electrumSSL: false,
  networkAccessEnabled: false,
  networkOnboardingStage: 'source',
};

let runtimeSettings: NodeSettings | undefined;
let settingsWriteQueue: Promise<void> = Promise.resolve();

export function serializeNodeSettingsWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = settingsWriteQueue.then(write, write);
  settingsWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function setRuntimeNetworkSettings(settings: NodeSettings): void {
  runtimeSettings = settings;
}

export function updateRuntimeNetworkSettings(
  updates: Partial<Omit<NodeSettings, 'id'>>,
  fallback: NodeSettings,
): void {
  runtimeSettings = {
    ...(runtimeSettings ?? fallback),
    ...updates,
  };
}

export function replaceRuntimeNetworkSettings(
  replace: (current: NodeSettings) => NodeSettings,
  fallback: NodeSettings,
): void {
  runtimeSettings = replace(runtimeSettings ?? fallback);
}

/**
 * A rejected settings write must never leave an optimistic network policy
 * active. Restore the authoritative snapshot, but force access offline for the
 * rest of the session so both failed enables and failed disables fail closed.
 */
export function failRuntimeNetworkSettingsClosed(
  persisted: NodeSettings | undefined,
  fallback: NodeSettings,
): void {
  runtimeSettings = {
    ...fallback,
    ...persisted,
    networkAccessEnabled: false,
  };
}

export function isExplicitNetworkChoice(settings: NodeSettings): boolean {
  return settings.networkPrivacyMode !== undefined;
}

export function isNetworkAccessEnabled(settings: NodeSettings): boolean {
  // Missing fields mean a pre-onboarding vault. Preserve its existing behavior.
  if (settings.networkOnboardingStage === undefined && settings.networkPrivacyMode === undefined) {
    return settings.networkAccessEnabled !== false;
  }
  return settings.networkAccessEnabled === true && isExplicitNetworkChoice(settings);
}

export function assertNetworkAccessAllowed(settings?: NodeSettings): void {
  const current = settings ?? runtimeSettings;
  if (!current) return;
  if (!isExplicitNetworkChoice(current) && current.networkOnboardingStage !== undefined) {
    throw new Error(NETWORK_CHOICE_REQUIRED_MESSAGE);
  }
  if (!isNetworkAccessEnabled(current)) {
    throw new Error(NETWORK_BLOCKED_MESSAGE);
  }
}

export function isFirstSyncConfirmationRequired(settings: NodeSettings): boolean {
  return isExplicitNetworkChoice(settings) && settings.firstSyncConfirmedAt === undefined;
}

export function assertFirstSyncConfirmed(settings?: NodeSettings): void {
  const current = settings ?? runtimeSettings;
  if (current && isFirstSyncConfirmationRequired(current)) {
    throw new Error(FIRST_SYNC_CONFIRMATION_REQUIRED_MESSAGE);
  }
}

export function deriveNetworkPrivacyMode(settings: NodeSettings): NetworkPrivacyMode {
  if (settings.useElectrum) return 'electrum';
  if (settings.providerType.startsWith('custom-')) return 'own-node';
  if (settings.useTor) return 'public-tor';
  return 'public-direct';
}

export function getForgottenNetworkSourceUpdates(): Partial<Omit<NodeSettings, 'id'>> {
  return {
    networkAccessEnabled: false,
    networkOnboardingStage: 'source',
    networkPrivacyMode: undefined,
    networkPrivacyChosenAt: undefined,
    firstSyncConfirmedAt: undefined,
    lastConnectionStatus: undefined,
    lastConnectedAt: undefined,
  };
}

export function getNetworkPrivacyLabel(settings: NodeSettings): 'Offline' | 'Own node' | 'Tor' | 'Direct public' {
  if (!isNetworkAccessEnabled(settings)) return 'Offline';
  switch (deriveNetworkPrivacyMode(settings)) {
    case 'own-node':
    case 'electrum':
      return 'Own node';
    case 'public-tor':
      return 'Tor';
    case 'public-direct':
      return 'Direct public';
  }
}

export function getProviderClassDescription(settings: NodeSettings): string {
  switch (deriveNetworkPrivacyMode(settings)) {
    case 'own-node':
      return settings.customUrl
        ? `your own-node provider at ${settings.customUrl}`
        : 'your configured own-node HTTP provider';
    case 'electrum':
      return settings.electrumHost
        ? `your Electrum server at ${settings.electrumHost}:${settings.electrumPort ?? 50001}`
        : 'your configured Electrum server';
    case 'public-tor':
      return `${settings.providerType === 'blockstream' ? 'blockstream.info' : 'mempool.space'} through Tor`;
    case 'public-direct':
      return `${settings.providerType === 'blockstream' ? 'blockstream.info' : 'mempool.space'} directly`;
  }
}

/**
 * Record only the category of a network action. The persisted entry contains
 * no address, URL, transaction, or provider response. Logging is deliberately
 * best-effort so a local storage problem can never block the requested action.
 */
export function recordNetworkPrivacyActivity(
  activity: NetworkPrivacyActivityInput,
  settings?: NodeSettings,
): void {
  const current = settings ?? runtimeSettings;
  if (!current) return;
  const addressCount =
    typeof activity.addressCount === 'number' && Number.isFinite(activity.addressCount)
      ? Math.max(0, Math.floor(activity.addressCount))
      : undefined;
  void addNetworkPrivacyActivity({
    timestamp: Date.now(),
    providerClass: deriveNetworkPrivacyMode(current),
    action: activity.action,
    ...(addressCount === undefined ? {} : { addressCount }),
  }).catch(error => {
    console.warn('[NetworkPrivacy] Could not save local activity entry:', error);
  });
}

export async function initializeFreshNetworkPrivacy(): Promise<void> {
  await serializeNodeSettingsWrite(async () => {
    const existing = await getNodeSettings('default');
    if (existing) {
      await updateNodeSettings('default', {
        networkAccessEnabled: false,
        networkOnboardingStage: 'source',
        networkPrivacyMode: undefined,
        networkPrivacyChosenAt: undefined,
        firstSyncConfirmedAt: undefined,
      });
      runtimeSettings = { ...existing, ...FRESH_NODE_SETTINGS };
      return;
    }
    await putNodeSettings(FRESH_NODE_SETTINGS);
    runtimeSettings = FRESH_NODE_SETTINGS;
  });
}

export async function markFirstSyncConfirmed(): Promise<void> {
  const chosenAt = Date.now();
  await serializeNodeSettingsWrite(async () => {
    await updateNodeSettings('default', { firstSyncConfirmedAt: chosenAt });
    if (runtimeSettings) runtimeSettings = { ...runtimeSettings, firstSyncConfirmedAt: chosenAt };
  });
}