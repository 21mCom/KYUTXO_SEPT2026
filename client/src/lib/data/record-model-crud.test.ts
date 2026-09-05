import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie, { type Table } from 'dexie';
import type {
  AddressOwnership, BlockchainTransaction, Record, RecordEntity, RecordModelMigrationState,
  RecordWallet, TransactionLegMetadata, TransactionMetadata, TransactionParticipant,
} from '../db-types';

class TestDb extends Dexie {
  records!: Table<Record>;
  transactionParticipants!: Table<TransactionParticipant>;
  entities!: Table<RecordEntity>;
  wallets!: Table<RecordWallet>;
  addressOwnership!: Table<AddressOwnership>;
  transactionMetadata!: Table<TransactionMetadata>;
  transactionLegMetadata!: Table<TransactionLegMetadata>;
  recordModelMigrationState!: Table<RecordModelMigrationState>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records: '++id, type, inputString',
      transactionParticipants: '++id, txid',
      entities: '++id, &naturalKey',
      wallets: '++id, &naturalKey',
      addressOwnership: '++id, &recordId',
      transactionMetadata: '++id, &txid',
      transactionLegMetadata: '++id, &[txid+legKey]',
      recordModelMigrationState: 'id',
    });
  }
}
let testDb: TestDb;
vi.mock('../database', async () => {
  const actual = await vi.importActual<typeof import('../database')>('../database');
  return { ...actual, get db() { return testDb; }, notifyDbChange: vi.fn() };
});
vi.mock('./record-crud', () => ({
  getRecordsAfterId: (after: number, limit: number) =>
    testDb.records.where('id').above(after).limit(limit).toArray(),
  getRecord: (id: number) => testDb.records.get(id),
}));
vi.mock('./transaction-crud', () => ({
  getParticipantsByTxids: (txids: string[]) =>
    testDb.transactionParticipants.where('txid').anyOf(txids).toArray(),
}));
const { runRecordModelMigration } = await import('./record-model-crud');

function record(inputString: string, overrides: Partial<Record> = {}): Record {
  return { type: 'address', inputString, label: '', tags: [], categories: [], createdAt: 1, updatedAt: 1, ...overrides };
}
beforeEach(async () => { testDb = new TestDb(`record-model-${Date.now()}-${Math.random()}`); await testDb.open(); });
afterEach(async () => { testDb.close(); await Dexie.delete(testDb.name); });

describe('v44 record-model migration', () => {
  it('only assigns blank curated rows to Me for a truly single-owner vault', async () => {
    await testDb.records.bulkAdd([
      record('one', { owner: 'Alice', addressImportance: 'manual' }),
      record('blank', { addressImportance: 'manual' }),
      record('discovered', { syncDepth: 1, addressImportance: 'manual' }),
    ]);
    await runRecordModelMigration({ batchSize: 1 });
    const rows = await testDb.addressOwnership.orderBy('recordId').toArray();
    expect(rows.map(r => r.state)).toEqual(['assigned', 'assigned', 'undetermined']);
    const me = await testDb.entities.where('naturalKey').equals('self:me').first();
    expect(rows[1].entityId).toBe(me?.id);

    await testDb.recordModelMigrationState.clear();
    await testDb.records.add(record('bob', { owner: 'Bob', addressImportance: 'manual' }));
    await runRecordModelMigration();
    const blank = await testDb.addressOwnership.where('recordId').equals(2).first();
    expect(blank?.state).toBe('ours-owner-unknown');
  });

  it('resumes after a committed batch and is idempotent', async () => {
    await testDb.records.bulkAdd([record('a', { owner: 'Alice', addressImportance: 'manual' }), record('b', { owner: 'Alice', addressImportance: 'manual' })]);
    await runRecordModelMigration({ batchSize: 1, shouldContinue: () => false });
    expect((await testDb.recordModelMigrationState.get('v44'))?.lastRecordId).toBe(1);
    await runRecordModelMigration({ batchSize: 1 });
    await runRecordModelMigration({ batchSize: 1 });
    expect(await testDb.addressOwnership.count()).toBe(2);
    expect((await testDb.recordModelMigrationState.get('v44'))?.phase).toBe('complete');
  });

  it('retains defaults, category values, flow overrides, and wallet metadata', async () => {
    const addressId = await testDb.records.add(record('addr', {
      walletName: 'Cold', seedName: 'seed words', walletSoftware: 'Sparrow',
      vault: { isVaultXpub: true, vaultName: 'Family', m: 2, n: 3 },
      categories: ['address-category'], flowType: 'sent', addressImportance: 'manual',
      owner: 'Alice',
      counterpartyName: 'Coinbase Prime', counterpartyType: 'exchange',
    }));
    await testDb.records.add(record('tx', {
      type: 'transaction', flowType: 'received', acquisitionMethod: 'purchase',
      categories: ['income'], tags: ['proof'], notes: 'legacy note',
    }));
    await testDb.transactionParticipants.add({ txid: 'tx', role: 'output', address: 'addr', amount: 1, recordId: addressId as number, vout: 0 });
    await runRecordModelMigration();
    expect((await testDb.wallets.toArray())[0]).toMatchObject({ name: 'Cold', seedName: 'seed words', walletSoftware: 'Sparrow', vault: { vaultName: 'Family' } });
    expect(await testDb.transactionMetadata.where('txid').equals('tx').first())
      .toMatchObject({ categories: ['income'], notes: 'legacy note' });
    expect(await testDb.transactionLegMetadata.where('[txid+legKey]').equals(['tx', 'output:0']).first())
      .toMatchObject({ direction: 'incoming', categories: ['address-category'], flowType: 'sent', hasFlowOverride: true });
    const ownership = await testDb.addressOwnership.where('recordId').equals(addressId as number).first();
    const counterparty = await testDb.entities.get(ownership?.counterpartyEntityId!);
    expect(counterparty).toMatchObject({ name: 'Coinbase Prime', kind: 'counterparty', counterpartyType: 'exchange' });
    // The natural key carries entity identity rather than this database's id.
    expect((await testDb.wallets.toArray())[0].naturalKey).toContain('person:alice');
    expect((await testDb.wallets.toArray())[0].naturalKey).not.toContain(`|${ownership?.entityId}|`);
  });

  it('does not let missing-tier or discovery-evidenced owners infer a single owner', async () => {
    await testDb.records.bulkAdd([
      record('old-owner', { owner: 'Alice' }), // missing tier is not affirmative
      record('synced-owner', { owner: 'Bob', addressImportance: 'manual', source: 'blockchain-sync' }),
      record('found-owner', { owner: 'Carol', addressImportance: 'verified', discoveredInTxid: 'source' }),
      record('blank', { addressImportance: 'manual' }),
    ]);
    await runRecordModelMigration();
    const rows = await testDb.addressOwnership.orderBy('recordId').toArray();
    expect(rows.map(row => row.state)).toEqual([
      'undetermined', 'undetermined', 'undetermined', 'ours-owner-unknown',
    ]);
    expect(await testDb.entities.where('naturalKey').equals('self:me').first()).toBeUndefined();
  });
});