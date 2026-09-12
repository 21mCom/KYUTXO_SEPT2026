// Startup search-visibility repair (Task #1742): detection + flag lifecycle.
//
// Covers the pieces the automatic startup pass is built from:
//   - detectSearchVisibilityIssues() uses the exact predicates of the two
//     Doctor repairs, returns all-clear on a healthy vault, and flags each
//     class independently.
//   - The repairs actually clear a positive detection (shared
//     deriveAddressImportance provenance rules).
//   - The vault flag re-arms via rearmSearchVisibilityRepair() (called after
//     backup restores) so the pass runs again on the next login.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRecord,
  updateRecord,
  clearAllRecords,
  getRecordsByInputStrings,
  detectSearchVisibilityIssues,
  repairAddressImportanceTiers,
  repairInputStringLower,
} from './record-crud';
import {
  vaultDb,
  saveVaultSettings,
  isSearchVisibilityRepaired,
  setSearchVisibilityRepaired,
  rearmSearchVisibilityRepair,
  markFreshVaultMigrationsComplete,
} from '../vault';

async function seedHealthy(input: string): Promise<number> {
  return createRecord({
    type: 'address',
    inputString: input,
    label: '',
    notes: '',
    tags: [],
    source: 'manual',
  } as any);
}

// Corrupt rows the way old backups reintroduce them. updateRecord merges
// changes verbatim (it only recomputes inputStringLower when inputString
// itself changes), so it can carry an unrecognized tier / stale search key
// exactly like a verbatim restore of an old backup row.
async function corruptTier(id: number) {
  await updateRecord(id, { addressImportance: 'legacy-unknown-tier' as any });
}
async function desyncSearchKey(id: number) {
  await updateRecord(id, { inputStringLower: 'stale-key' });
}

describe('detectSearchVisibilityIssues', () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  it('returns all-clear on a healthy vault', async () => {
    await seedHealthy('bc1qhealthy1');
    await seedHealthy('bc1qhealthy2');
    const issues = await detectSearchVisibilityIssues();
    expect(issues).toEqual({ tiersAffected: false, searchKeysAffected: false });
  });

  it('flags invalid tiers and desynced search keys independently', async () => {
    const id1 = await seedHealthy('bc1qbadtier');
    await corruptTier(id1);
    expect(await detectSearchVisibilityIssues()).toEqual({
      tiersAffected: true,
      searchKeysAffected: false,
    });

    await clearAllRecords();
    const id2 = await seedHealthy('bc1qBadKey');
    await desyncSearchKey(id2);
    expect(await detectSearchVisibilityIssues()).toEqual({
      tiersAffected: false,
      searchKeysAffected: true,
    });
  });

  it('flags missing tiers (pre-tier legacy rows)', async () => {
    const id = await seedHealthy('bc1qmissingtier');
    await updateRecord(id, { addressImportance: undefined });
    expect((await detectSearchVisibilityIssues()).tiersAffected).toBe(true);
  });

  it('is cleared by the shared repairs', async () => {
    const id = await seedHealthy('bc1qBothBroken');
    await corruptTier(id);
    await desyncSearchKey(id);

    const tierResult = await repairAddressImportanceTiers();
    expect(tierResult.ok).toBe(true);
    expect(tierResult.fixed).toBe(1);
    const keyResult = await repairInputStringLower();
    expect(keyResult.ok).toBe(true);
    expect(keyResult.fixed).toBe(1);

    expect(await detectSearchVisibilityIssues()).toEqual({
      tiersAffected: false,
      searchKeysAffected: false,
    });
    // Provenance rules identical to the Doctor button: a manual row with no
    // sync provenance normalizes to 'manual', never a discovery tier.
    const rows = await getRecordsByInputStrings(['bc1qBothBroken']);
    expect(rows[0]?.addressImportance).toBe('manual');
  });
});

describe('searchVisibilityRepaired vault flag', () => {
  beforeEach(async () => {
    await vaultDb.vault.clear();
  });

  it('defaults false, persists true, and re-arms', async () => {
    await saveVaultSettings('salt', 'hash');
    expect(await isSearchVisibilityRepaired()).toBe(false);
    await setSearchVisibilityRepaired(true);
    expect(await isSearchVisibilityRepaired()).toBe(true);
    await rearmSearchVisibilityRepair();
    expect(await isSearchVisibilityRepaired()).toBe(false);
  });

  it('is marked done for brand-new (empty) vaults', async () => {
    await saveVaultSettings('salt', 'hash');
    await markFreshVaultMigrationsComplete();
    expect(await isSearchVisibilityRepaired()).toBe(true);
  });

  it('re-arm no-ops safely without a vault row', async () => {
    await expect(rearmSearchVisibilityRepair()).resolves.toBeUndefined();
    expect(await isSearchVisibilityRepaired()).toBe(false);
  });
});
