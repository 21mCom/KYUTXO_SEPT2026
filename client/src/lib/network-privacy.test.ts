import { beforeEach, describe, expect, it, vi } from 'vitest';

const crud = vi.hoisted(() => ({
  getNodeSettings: vi.fn(),
  putNodeSettings: vi.fn(),
  updateNodeSettings: vi.fn(),
}));

vi.mock('./data/node-settings-crud', () => crud);

import {
  FIRST_SYNC_CONFIRMATION_REQUIRED_MESSAGE,
  NETWORK_BLOCKED_MESSAGE,
  assertFirstSyncConfirmed,
  assertNetworkAccessAllowed,
  getNetworkPrivacyLabel,
  initializeFreshNetworkPrivacy,
  isFirstSyncConfirmationRequired,
  isNetworkAccessEnabled,
  setRuntimeNetworkSettings,
} from './network-privacy';
import type { NodeSettings } from './database';

const legacy: NodeSettings = {
  id: 'default',
  providerType: 'mempool-space',
  useTor: false,
  requestTimeout: 30_000,
  network: 'mainnet',
  allowLocalNetwork: false,
  trustedLocalHosts: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  setRuntimeNetworkSettings(legacy);
});

describe('network privacy policy', () => {
  it('preserves networking for existing vaults without onboarding fields', () => {
    expect(isNetworkAccessEnabled(legacy)).toBe(true);
    expect(getNetworkPrivacyLabel(legacy)).toBe('Direct public');
    expect(() => assertNetworkAccessAllowed(legacy)).not.toThrow();
  });

  it('blocks a fresh vault before an explicit source choice', () => {
    const fresh = {
      ...legacy,
      networkAccessEnabled: false,
      networkOnboardingStage: 'source' as const,
    };
    setRuntimeNetworkSettings(fresh);
    expect(isNetworkAccessEnabled(fresh)).toBe(false);
    expect(() => assertNetworkAccessAllowed(fresh)).toThrow();
  });

  it('keeps the configured source while the kill switch is offline', () => {
    const offline = {
      ...legacy,
      networkPrivacyMode: 'public-tor' as const,
      networkOnboardingStage: 'complete' as const,
      networkAccessEnabled: false,
    };
    setRuntimeNetworkSettings(offline);
    expect(getNetworkPrivacyLabel(offline)).toBe('Offline');
    expect(() => assertNetworkAccessAllowed(offline)).toThrow(NETWORK_BLOCKED_MESSAGE);
    expect(offline.networkPrivacyMode).toBe('public-tor');
  });

  it('requires disclosure once for newly-chosen sources, not legacy vaults', () => {
    const chosen = {
      ...legacy,
      networkPrivacyMode: 'public-direct' as const,
      networkAccessEnabled: true,
      networkOnboardingStage: 'complete' as const,
    };
    setRuntimeNetworkSettings(chosen);
    expect(isFirstSyncConfirmationRequired(chosen)).toBe(true);
    expect(() => assertFirstSyncConfirmed(chosen)).toThrow(FIRST_SYNC_CONFIRMATION_REQUIRED_MESSAGE);
    expect(isFirstSyncConfirmationRequired({ ...chosen, firstSyncConfirmedAt: 1 })).toBe(false);
    expect(isFirstSyncConfirmationRequired(legacy)).toBe(false);
  });

  it('persists an offline source-selection stage for a fresh vault', async () => {
    crud.getNodeSettings.mockResolvedValue(undefined);
    await initializeFreshNetworkPrivacy();
    expect(crud.putNodeSettings).toHaveBeenCalledWith(expect.objectContaining({
      id: 'default',
      networkAccessEnabled: false,
      networkOnboardingStage: 'source',
    }));
  });
});