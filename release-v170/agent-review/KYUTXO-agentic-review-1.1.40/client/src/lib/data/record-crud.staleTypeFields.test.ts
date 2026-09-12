// Stale type-specific field cleanup (Task #1914): records whose Type was
// switched before the edit form started clearing type-irrelevant metadata
// still carry orphaned values (e.g. flowType on an address). Covers:
//   - getStaleTypeSpecificFields matches getTypeSwitchClears exactly per type
//   - repairStaleTypeSpecificFields deletes only the stale fields, keeps
//     shared/valid fields, bumps updatedAt, and is idempotent
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRecord,
  clearAllRecords,
  getRecord,
  repairStaleTypeSpecificFields,
} from './record-crud';
import { db } from '../database';
import {
  getTypeSwitchClears,
  getStaleTypeSpecificFields,
} from '../record-type-clears';

describe('getStaleTypeSpecificFields', () => {
  it('flags only fields the current type cannot show, per getTypeSwitchClears', () => {
    const full = {
      flowType: 'sent',
      acquisitionMethod: 'purchase',
      dispositionType: 'sale',
      costBasisUsd: 0, // 0 is a real value and must count
      counterpartyType: 'exchange',
      counterpartyName: 'Coinbase',
    } as const;

    expect(getStaleTypeSpecificFields({ type: 'address', ...full }).sort()).toEqual(
      Object.keys(getTypeSwitchClears('address')).sort(),
    );
    expect(getStaleTypeSpecificFields({ type: 'transaction', ...full }).sort()).toEqual(
      Object.keys(getTypeSwitchClears('transaction')).sort(),
    );
    expect(getStaleTypeSpecificFields({ type: 'other', ...full }).sort()).toEqual(
      Object.keys(getTypeSwitchClears('other')).sort(),
    );
  });

  it('ignores blank/undefined values and unknown types', () => {
    expect(
      getStaleTypeSpecificFields({
        type: 'address',
        flowType: undefined,
        dispositionType: '' as never,
        counterpartyType: 'exchange' as never, // valid for address
      }),
    ).toEqual([]);
    expect(getStaleTypeSpecificFields({ type: undefined, flowType: 'sent' as never })).toEqual([]);
  });
});

describe('repairStaleTypeSpecificFields', () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  it('clears only stale fields, keeps shared fields, bumps updatedAt, idempotent', async () => {
    // Address carrying transaction-only leftovers (pre-fix Type switch).
    const addrId = await createRecord({
      type: 'address',
      inputString: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      label: 'addr',
      tags: [],
      source: 'manual',
      flowType: 'sent',
      dispositionType: 'sale',
      acquisitionMethod: 'purchase', // shared — must survive
      costBasisUsd: 12.5, // shared — must survive
      counterpartyType: 'exchange', // valid for address — must survive
      counterpartyName: 'Kraken',
    } as any);
    // Transaction carrying address-only leftovers.
    const txId = await createRecord({
      type: 'transaction',
      inputString: 'a'.repeat(64),
      label: 'tx',
      tags: [],
      source: 'manual',
      flowType: 'sent', // valid — must survive
      counterpartyType: 'exchange',
      counterpartyName: 'Coinbase',
    } as any);
    // 'other' carrying everything.
    const otherId = await createRecord({
      type: 'other',
      inputString: 'note-1',
      label: 'other',
      tags: [],
      source: 'manual',
      flowType: 'received',
      acquisitionMethod: 'gift-received',
      costBasisUsd: 0,
      counterpartyName: 'Alice',
    } as any);
    // Healthy record — must not be touched.
    const healthyId = await createRecord({
      type: 'transaction',
      inputString: 'b'.repeat(64),
      label: 'healthy',
      tags: [],
      source: 'manual',
      flowType: 'received',
    } as any);

    // Backdate updatedAt so the bump is observable.
    const past = Date.now() - 100_000;
    await db.records.toCollection().modify((r) => {
      r.updatedAt = past;
    });

    const res = await repairStaleTypeSpecificFields();
    expect(res.ok).toBe(true);
    expect(res.scanned).toBe(4);
    expect(res.fixed).toBe(3);

    const addr = (await getRecord(addrId))!;
    expect(addr.flowType).toBeUndefined();
    expect(addr.dispositionType).toBeUndefined();
    expect('flowType' in addr).toBe(false);
    expect(addr.acquisitionMethod).toBe('purchase');
    expect(addr.costBasisUsd).toBe(12.5);
    expect(addr.counterpartyType).toBe('exchange');
    expect(addr.counterpartyName).toBe('Kraken');
    expect(addr.updatedAt).toBeGreaterThan(past);

    const tx = (await getRecord(txId))!;
    expect(tx.counterpartyType).toBeUndefined();
    expect(tx.counterpartyName).toBeUndefined();
    expect(tx.flowType).toBe('sent');
    expect(tx.updatedAt).toBeGreaterThan(past);

    const other = (await getRecord(otherId))!;
    expect(other.flowType).toBeUndefined();
    expect(other.acquisitionMethod).toBeUndefined();
    expect(other.costBasisUsd).toBeUndefined();
    expect(other.counterpartyName).toBeUndefined();
    expect(other.updatedAt).toBeGreaterThan(past);

    const healthy = (await getRecord(healthyId))!;
    expect(healthy.flowType).toBe('received');
    expect(healthy.updatedAt).toBe(past);

    // Idempotent: a second run finds nothing to fix.
    const res2 = await repairStaleTypeSpecificFields();
    expect(res2.ok).toBe(true);
    expect(res2.fixed).toBe(0);
  });
});
