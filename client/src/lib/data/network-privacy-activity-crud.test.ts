// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkPrivacyActivityEntry } from '@/lib/db-types';

class TestDb extends Dexie {
  networkPrivacyActivity!: Table<NetworkPrivacyActivityEntry, number>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      networkPrivacyActivity: '++id, timestamp, providerClass, action',
    });
  }
}

let testDb: TestDb;
const notifyDbChange = vi.fn();

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return {
    ...actual,
    get db() {
      return testDb;
    },
    notifyDbChange,
  };
});

const {
  MAX_NETWORK_PRIVACY_ACTIVITY_ENTRIES,
  addNetworkPrivacyActivity,
  clearNetworkPrivacyActivity,
  getNetworkPrivacyActivity,
  getNetworkPrivacyActivityCount,
} = await import('./network-privacy-activity-crud');

beforeEach(async () => {
  notifyDbChange.mockClear();
  testDb = new TestDb(`network-privacy-activity-${Date.now()}-${Math.random()}`);
  await testDb.open();
});

afterEach(async () => {
  await testDb.delete();
});

describe('network privacy activity storage', () => {
  it('stores only summary fields and returns newest entries first', async () => {
    await addNetworkPrivacyActivity({
      timestamp: 1_000,
      providerClass: 'public-direct',
      action: 'provider-test',
    });
    await addNetworkPrivacyActivity({
      timestamp: 2_000,
      providerClass: 'electrum',
      action: 'address-check',
      addressCount: 3,
    });

    const entries = await getNetworkPrivacyActivity();
    expect(entries.map(({ id: _id, ...entry }) => entry)).toEqual([
      {
        timestamp: 2_000,
        providerClass: 'electrum',
        action: 'address-check',
        addressCount: 3,
      },
      {
        timestamp: 1_000,
        providerClass: 'public-direct',
        action: 'provider-test',
      },
    ]);
    expect(Object.keys(entries[0]).sort()).toEqual([
      'action',
      'addressCount',
      'id',
      'providerClass',
      'timestamp',
    ]);
  });

  it('strips injected addresses, URLs, and response fields at the storage boundary', async () => {
    await addNetworkPrivacyActivity({
      timestamp: 3_000,
      providerClass: 'own-node',
      action: 'sync',
      addressCount: 4.8,
      address: 'bc1q-private-address',
      providerUrl: 'http://private-node.internal:8332',
      response: { transactions: ['secret'] },
    } as Parameters<typeof addNetworkPrivacyActivity>[0]);

    const [entry] = await getNetworkPrivacyActivity();
    expect(entry).toEqual({
      id: expect.any(Number),
      timestamp: 3_000,
      providerClass: 'own-node',
      action: 'sync',
      addressCount: 4,
    });
    expect(JSON.stringify(entry)).not.toContain('private');
    expect(JSON.stringify(entry)).not.toContain('secret');
  });

  it('keeps only the most recent bounded history', async () => {
    for (let index = 0; index <= MAX_NETWORK_PRIVACY_ACTIVITY_ENTRIES; index++) {
      await addNetworkPrivacyActivity({
        timestamp: index,
        providerClass: 'own-node',
        action: 'sync',
        addressCount: index,
      });
    }

    const entries = await getNetworkPrivacyActivity();
    expect(entries).toHaveLength(MAX_NETWORK_PRIVACY_ACTIVITY_ENTRIES);
    expect(entries[0].timestamp).toBe(MAX_NETWORK_PRIVACY_ACTIVITY_ENTRIES);
    expect(entries.at(-1)?.timestamp).toBe(1);
  });

  it('clears activity without touching any provider setting table', async () => {
    await addNetworkPrivacyActivity({
      timestamp: 1_000,
      providerClass: 'public-tor',
      action: 'price-source',
    });
    expect(await getNetworkPrivacyActivityCount()).toBe(1);

    await clearNetworkPrivacyActivity();

    expect(await getNetworkPrivacyActivityCount()).toBe(0);
    expect(notifyDbChange).toHaveBeenLastCalledWith('networkPrivacyActivity');
  });
});