import { beforeEach, describe, expect, it, vi } from 'vitest';

const crud = vi.hoisted(() => ({
  getNodeSettings: vi.fn(),
  putNodeSettings: vi.fn(),
  updateNodeSettings: vi.fn(),
}));

vi.mock('./data/node-settings-crud', () => crud);

const activityCrud = vi.hoisted(() => ({
  addNetworkPrivacyActivity: vi.fn().mockResolvedValue(1),
}));

vi.mock('./data/network-privacy-activity-crud', () => activityCrud);

import {
  FIRST_SYNC_CONFIRMATION_REQUIRED_MESSAGE,
  NETWORK_BLOCKED_MESSAGE,
  NETWORK_CHOICE_REQUIRED_MESSAGE,
  assertFirstSyncConfirmed,
  assertNetworkAccessAllowed,
  getNetworkPrivacyLabel,
  initializeFreshNetworkPrivacy,
  isFirstSyncConfirmationRequired,
  isNetworkAccessEnabled,
  isNetworkPolicyBlockedMessage,
  recordNetworkPrivacyActivity,
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
  activityCrud.addNetworkPrivacyActivity.mockResolvedValue(1);
  setRuntimeNetworkSettings(legacy);
});

describe('network privacy policy', () => {
  it('identifies only errors that a UI can recover from in Node Settings', () => {
    expect(isNetworkPolicyBlockedMessage(NETWORK_BLOCKED_MESSAGE)).toBe(true);
    expect(isNetworkPolicyBlockedMessage(NETWORK_CHOICE_REQUIRED_MESSAGE)).toBe(true);
    expect(isNetworkPolicyBlockedMessage(FIRST_SYNC_CONFIRMATION_REQUIRED_MESSAGE)).toBe(false);
    expect(isNetworkPolicyBlockedMessage('Request failed: 500')).toBe(false);
  });

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
    expect(() => assertNetworkAccessAllowed(fresh)).toThrow(NETWORK_CHOICE_REQUIRED_MESSAGE);
    expect(NETWORK_CHOICE_REQUIRED_MESSAGE).toContain('Node Settings');
  });

  it('distinguishes intentionally unconfigured offline vaults from disabled configured sources', () => {
    const unconfigured = {
      ...legacy,
      networkAccessEnabled: false,
      networkOnboardingStage: 'complete' as const,
      networkPrivacyChosenAt: 123,
    };
    expect(getNetworkPrivacyLabel(unconfigured)).toBe('Offline');
    expect(() => assertNetworkAccessAllowed(unconfigured)).toThrow(NETWORK_CHOICE_REQUIRED_MESSAGE);
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

  it('records only the derived provider class, action, time, and sanitized count', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123_456);
    recordNetworkPrivacyActivity({
      action: 'address-check',
      addressCount: 2.9,
    }, {
      ...legacy,
      useTor: true,
    });

    await vi.waitFor(() => {
      expect(activityCrud.addNetworkPrivacyActivity).toHaveBeenCalledWith({
        timestamp: 123_456,
        providerClass: 'public-tor',
        action: 'address-check',
        addressCount: 2,
      });
    });
  });

  it('does not retain invalid address counts', async () => {
    recordNetworkPrivacyActivity({
      action: 'sync',
      addressCount: Number.NaN,
    }, legacy);

    await vi.waitFor(() => {
      expect(activityCrud.addNetworkPrivacyActivity).toHaveBeenCalledWith({
        timestamp: expect.any(Number),
        providerClass: 'public-direct',
        action: 'sync',
      });
    });
  });
});