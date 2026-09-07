import { getElectronAPISafe, type EngineEnvelope, type ProtectedStoreBridge } from '../electron';
import type { OwnerCostBasisPageRequest, OwnerCostBasisProjectionResult, OwnershipReviewCommit, ProtectedRepositoryCommandName, ProtectedRepositoryQueryName, RecordDeleteOrArchiveCommand, RecordsQuery, RestoreVaultCommit, SettingsHistoryCommit, TransactionParticipantsCommit, VaultKey, VaultListOptions, VaultPage, VaultRepository, VaultRows, VaultTableName } from './contracts';
import type { OwnerCostBasisPage } from '../owner-cost-basis-core';
import type { Record } from '../db-types';

const MAX_PAGE_SIZE = 1000;

function unwrap<T>(envelope: EngineEnvelope<T>): T {
  if (!envelope.ok || envelope.result === undefined) {
    throw new Error(envelope.error || 'Protected vault operation failed');
  }
  return envelope.result;
}

/**
 * Packaged implementation.  The renderer only invokes named, typed bridge
 * operations; it never opens IndexedDB or receives a query builder.
 */
export class ProtectedVaultRepository implements VaultRepository {
  readonly kind = 'protected' as const;

  constructor(private readonly bridge: ProtectedStoreBridge = getElectronAPISafe()?.protectedStore as ProtectedStoreBridge) {
    if (!bridge) throw new Error('Protected vault bridge is unavailable');
  }

  async get<T extends VaultTableName>(table: T, key: VaultKey): Promise<VaultRows[T] | undefined> {
    return (unwrap(await this.bridge.repository.find(table, key)) ?? undefined) as VaultRows[T] | undefined;
  }

  async put<T extends VaultTableName>(table: T, row: VaultRows[T], key?: VaultKey): Promise<VaultKey> {
    const id = key ?? (row as { id?: VaultKey }).id;
    return unwrap(await this.bridge.repository.save(table, id === undefined ? row : { ...row, id })).id;
  }

  async add<T extends VaultTableName>(table: T, row: VaultRows[T]): Promise<VaultKey> {
    return this.put(table, row);
  }

  async bulkPut<T extends VaultTableName>(table: T, rows: VaultRows[T][]): Promise<VaultKey[]> {
    if (!rows.length) return [];
    return unwrap(await this.bridge.repository.saveBatch(table, rows)).ids;
  }

  async update<T extends VaultTableName>(table: T, key: VaultKey, changes: Partial<VaultRows[T]>): Promise<boolean> {
    const current = await this.get(table, key);
    if (!current) return false;
    await this.put(table, { ...current, ...changes }, key);
    return true;
  }

  async delete<T extends VaultTableName>(table: T, key: VaultKey): Promise<void> {
    unwrap(await this.bridge.repository.remove(table, key));
  }

  async bulkDelete<T extends VaultTableName>(table: T, keys: VaultKey[]): Promise<void> {
    if (keys.length) unwrap(await this.bridge.repository.removeBatch(table, keys));
  }

  /** One native operation, committed atomically by the protected-store worker. */
  async saveBatch<T extends VaultTableName>(table: T, rows: VaultRows[T][]): Promise<VaultKey[]> {
    if (!rows.length) return [];
    return unwrap(await this.bridge.repository.saveBatch(table, rows)).ids;
  }

  async clear<T extends VaultTableName>(table: T): Promise<void> {
    unwrap(await this.bridge.repository.clear(table));
  }

  async count<T extends VaultTableName>(table: T): Promise<number> {
    return unwrap(await this.bridge.repository.count(table)).count;
  }

  async list<T extends VaultTableName>(table: T, options: VaultListOptions): Promise<VaultPage<VaultRows[T]>> {
    const limit = Math.min(Math.max(1, options.limit), MAX_PAGE_SIZE);
    const page = unwrap(await this.bridge.repository.page(table, options.cursor, limit, options.direction ?? 'asc'));
    return {
      rows: page.items as VaultRows[T][],
      cursor: page.next === null ? undefined : page.next,
    };
  }

  async queryRecords(query: RecordsQuery): Promise<Record[]> {
    return this.query<Record>('records', query.name, query.value, query.limit);
  }

  /** Named native query only; never exposes a Dexie/SQL fluent surface. */
  async query<T>(table: VaultTableName, name: ProtectedRepositoryQueryName, value: unknown, limit?: number): Promise<T[]> {
    return unwrap(await this.bridge.repository.query(table, name, value, limit)).items as T[];
  }

  async command<T>(name: ProtectedRepositoryCommandName, value: unknown): Promise<T> {
    return unwrap(await this.bridge.repository.command(name, value)) as T;
  }

  async deleteOrArchiveRecords(command: RecordDeleteOrArchiveCommand) {
    return unwrap(await this.bridge.repository.deleteOrArchiveRecords(command));
  }

  async saveTransactionWithParticipants(command: TransactionParticipantsCommit) {
    return unwrap(await this.bridge.repository.saveTransactionWithParticipants(command.transaction, command.participants, command.replaceParticipants));
  }

  async saveSettingsWithHistory(command: SettingsHistoryCommit) {
    return unwrap(await this.bridge.repository.saveSettingsWithHistory(command.settings, command.historyEntry, command.retainHistory));
  }

  async clearVault() {
    return unwrap(await this.bridge.repository.clearVault());
  }

  async restoreCommit(command: RestoreVaultCommit) {
    return unwrap(await this.bridge.repository.restoreCommit(command.replaceExisting, command.rows));
  }
  async commitOwnershipReview(command: OwnershipReviewCommit) {
    return unwrap(await this.bridge.repository.commitOwnershipReview(command)) as import('../db-types').OwnershipReviewDecision;
  }

  async ownerCostBasisPage(options: OwnerCostBasisPageRequest): Promise<OwnerCostBasisPage> {
    return unwrap(await this.bridge.repository.ownerCostBasisPage(options));
  }
  async ownerCostBasisProjection(addresses: string[]): Promise<OwnerCostBasisProjectionResult> {
    return unwrap(await this.bridge.repository.ownerCostBasisProjection(addresses));
  }

  async transaction<T>(_tables: VaultTableName[], _operation: () => Promise<T>): Promise<T> {
    // The current bridge intentionally has no batch transaction operation.
    // Running the callback here would falsely claim atomicity.
    throw new Error('Protected vault transactions require a native transaction operation');
  }
}
