// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import React from 'react';

const vault = vi.hoisted(() => ({
  isVaultInitialized: vi.fn(async () => false),
  getVaultSettings: vi.fn(),
  saveVaultSettings: vi.fn(),
  isAttachmentPathsMigrated: vi.fn(async () => true),
  setAttachmentPathsMigrated: vi.fn(),
  isLegacyDecryptComplete: vi.fn(async () => true),
  setLegacyDecryptComplete: vi.fn(),
  getLegacyDecryptCompletedTables: vi.fn(async () => []),
  addLegacyDecryptCompletedTable: vi.fn(),
  isLegacyFileDecryptComplete: vi.fn(async () => true),
  setLegacyFileDecryptComplete: vi.fn(),
  getLegacyFileDecryptCheckpoint: vi.fn(),
  setLegacyFileDecryptCheckpoint: vi.fn(),
  markFreshVaultMigrationsComplete: vi.fn(),
  isInputStringLowerRepaired: vi.fn(async () => true),
  setInputStringLowerRepaired: vi.fn(),
  isSearchVisibilityRepaired: vi.fn(async () => true),
  setSearchVisibilityRepaired: vi.fn(),
  isCanonicalInputStringsRepaired: vi.fn(async () => true),
  setCanonicalInputStringsRepaired: vi.fn(),
  verifyVaultPassword: vi.fn(),
  upgradeVaultKdfIfNeeded: vi.fn(),
}));

vi.mock('@/lib/vault', () => vault);
vi.mock('@/lib/database', () => ({ db: { open: vi.fn() }, CURRENT_SCHEMA_VERSION: 1 }));
vi.mock('@/lib/data/record-crud', () => ({
  repairInputStringLower: vi.fn(), repairAddressImportanceTiers: vi.fn(),
  repairCanonicalInputStrings: vi.fn(), detectSearchVisibilityIssues: vi.fn(),
  countRecords: vi.fn(), warmRecordSearchIndex: vi.fn(),
}));
vi.mock('@/lib/data/attachments-crud', () => ({ countAttachments: vi.fn() }));
vi.mock('@/lib/data/evidence-crud', () => ({ countEvidenceAttachments: vi.fn() }));
vi.mock('@/lib/attachments', () => ({ migrateAttachmentPaths: vi.fn() }));
vi.mock('@/lib/legacy-decrypt', () => ({
  decryptLegacyRecords: vi.fn(), getTotalTableCount: vi.fn(), countUnrecoveredLegacyRows: vi.fn(),
}));
vi.mock('@/lib/legacy-decrypt-files', () => ({ decryptLegacyAttachmentFiles: vi.fn() }));
vi.mock('@/lib/activity-bus', () => ({ getActivityBus: () => ({ publishTask: vi.fn(), completeTask: vi.fn() }) }));
vi.mock('@/lib/data/settings-crud', () => ({ syncDesktopLockSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/db-upgrade-progress', () => ({ subscribeDbUpgradeProgress: vi.fn(), clearDbUpgradeProgress: vi.fn() }));
vi.mock('@/lib/network-privacy', () => ({ initializeFreshNetworkPrivacy: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

import { AuthProvider, useAuth } from './AuthContext';

let auth: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return <span>{auth.protectedRepository}</span>;
}

const protectedStatus = (overrides = {}) => ({
  mode: 'protected' as const, available: true, exists: true, unlocked: false,
  verified: false, version: 1, ...overrides,
});

function setDesktopBridge(bridge: Record<string, unknown>) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { isElectron: true, protectedStore: bridge },
  });
}

describe('AuthContext protected repository startup gate', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', false);
    vi.clearAllMocks();
    vault.isVaultInitialized.mockResolvedValue(false);
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it('stays locked without touching the Dexie fallback', async () => {
    const status = vi.fn(async () => ({ ok: true, result: protectedStatus() }));
    setDesktopBridge({ status, integrity: vi.fn(), lock: vi.fn(), unlock: vi.fn(), create: vi.fn() });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.protectedRepository).toBe('locked'));
    expect(auth.isInitialized).toBe(true);
    expect(vault.isVaultInitialized).not.toHaveBeenCalled();
  });

  it('fails closed when post-unlock status is unverified', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: protectedStatus() })
      .mockResolvedValueOnce({ ok: true, result: protectedStatus({ unlocked: true, verified: false }) });
    const integrity = vi.fn(async () => ({ ok: true, result: { ok: true } }));
    setDesktopBridge({
      status, integrity, lock: vi.fn(),
      unlock: vi.fn(async () => ({ ok: true, result: { unlocked: true, verified: true } })),
      create: vi.fn(),
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.protectedRepository).toBe('locked'));
    await act(async () => expect(await auth.login('password')).toBe(false));
    expect(auth.protectedRepository).toBe('error');
    expect(auth.isAuthenticated).toBe(false);
  });

  it('fails closed when protected status cannot be read', async () => {
    setDesktopBridge({ status: vi.fn(async () => ({ ok: false, error: 'offline' })), lock: vi.fn() });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.protectedRepository).toBe('error'));
    expect(auth.isInitialized).toBeNull();
    expect(vault.isVaultInitialized).not.toHaveBeenCalled();
  });

  it('authenticates only after unlock, integrity, and ready status succeed', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: protectedStatus() })
      .mockResolvedValueOnce({ ok: true, result: protectedStatus({ unlocked: true, verified: true, ready: true }) });
    const integrity = vi.fn(async () => ({ ok: true, result: { ok: true } }));
    setDesktopBridge({
      status, integrity, lock: vi.fn(),
      unlock: vi.fn(async () => ({ ok: true, result: { unlocked: true, verified: true } })),
      create: vi.fn(),
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.protectedRepository).toBe('locked'));
    await act(async () => expect(await auth.login('password')).toBe(true));
    expect(integrity).toHaveBeenCalledOnce();
    expect(auth.protectedRepository).toBe('ready');
    expect(auth.isAuthenticated).toBe(true);
  });

  it('retains the browser/development Dexie fallback', async () => {
    vi.stubEnv('DEV', true);
    vault.isVaultInitialized.mockResolvedValue(true);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.protectedRepository).toBe('fallback'));
    expect(vault.isVaultInitialized).toHaveBeenCalledOnce();
  });
});