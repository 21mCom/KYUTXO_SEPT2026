import type { KYUTXODatabase } from '../database';
import type { ProtectedRepositoryCommandName, ProtectedRepositoryQueryName, RecordDeleteOrArchiveCommand, RestoreVaultCommit, SettingsHistoryCommit, TransactionParticipantsCommit, VaultKey, VaultListOptions, VaultPage, VaultRepository, VaultRows, VaultTableName } from './contracts';

const MAX_PAGE_SIZE = 1000;

/** Browser/development implementation. Dexie is contained in this adapter. */
export class DexieVaultRepository implements VaultRepository {
  readonly kind = 'dexie' as const;

  constructor(private readonly database: KYUTXODatabase) {}

  private table<T extends VaultTableName>(name: T): any {
    // Test/legacy Dexie fixtures commonly expose typed table properties but do
    // not implement Dexie's dynamic `table(name)` helper. Both shapes remain
    // browser-only; packaged builds never construct this adapter.
    return typeof (this.database as any).table === 'function'
      ? (this.database as any).table(name)
      : (this.database as any)[name];
  }

  get<T extends VaultTableName>(table: T, key: VaultKey): Promise<VaultRows[T] | undefined> {
    return this.table(table).get(key);
  }

  async put<T extends VaultTableName>(table: T, row: VaultRows[T], key?: VaultKey): Promise<VaultKey> {
    return key === undefined ? this.table(table).put(row) : this.table(table).put(row, key);
  }

  add<T extends VaultTableName>(table: T, row: VaultRows[T]): Promise<VaultKey> {
    return this.table(table).add(row);
  }

  bulkPut<T extends VaultTableName>(table: T, rows: VaultRows[T][]): Promise<VaultKey[]> {
    return this.table(table).bulkPut(rows, { allKeys: true });
  }

  async update<T extends VaultTableName>(table: T, key: VaultKey, changes: Partial<VaultRows[T]>): Promise<boolean> {
    return (await this.table(table).update(key, changes)) > 0;
  }

  delete<T extends VaultTableName>(table: T, key: VaultKey): Promise<void> {
    return this.table(table).delete(key);
  }

  bulkDelete<T extends VaultTableName>(table: T, keys: VaultKey[]): Promise<void> {
    return this.table(table).bulkDelete(keys);
  }

  clear<T extends VaultTableName>(table: T): Promise<void> {
    return this.table(table).clear();
  }

  count<T extends VaultTableName>(table: T): Promise<number> {
    return this.table(table).count();
  }

  async list<T extends VaultTableName>(table: T, options: VaultListOptions): Promise<VaultPage<VaultRows[T]>> {
    const limit = Math.min(Math.max(1, options.limit), MAX_PAGE_SIZE);
    const after = options.cursor;
    const descending = options.direction === 'desc';
    const rows = after === undefined
      ? await (descending ? this.table(table).orderBy('id').reverse() : this.table(table).orderBy('id')).limit(limit).toArray()
      : await (descending
        ? this.table(table).where('id').below(after).reverse()
        : this.table(table).where('id').above(after)
      ).limit(limit).toArray();
    const last = rows[rows.length - 1] as { id?: VaultKey } | undefined;
    return { rows, cursor: rows.length === limit && last?.id !== undefined ? last.id : undefined };
  }

  async queryRecords(query: import('./contracts').RecordsQuery): Promise<import('../db-types').Record[]> {
    const records = this.table('records');
    const limit = Math.min(Math.max(1, query.limit ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE);
    switch (query.name) {
      case 'records.byInputStringLower':
        return records.where('inputStringLower').equals(query.value.toLowerCase()).limit(limit).toArray();
      case 'records.byRecordType':
        return records.where('type').equals(query.value).limit(limit).toArray();
      case 'records.byRecordId': {
        const row = await records.get(query.value);
        return row ? [row] : [];
      }
      case 'records.filtered': {
        // Dexie remains deliberately contained in the browser/dev adapter.
        // Packaged renderers issue the identical DTO to the native repository.
        const dto = query.value;
        const lower = (value: unknown) => String(value ?? '').toLowerCase();
        const selected = (raw: string) => {
          try { return JSON.parse(raw) as unknown[]; } catch { return []; }
        };
        const matches = (row: any, f: { field: string; operator: string; value: string }) => {
          const value = row[f.field];
          const needle = lower(f.value);
          const values = Array.isArray(value) ? value.map(lower) : [];
          const any = selected(f.value).filter((v): v is string => typeof v === 'string').map(lower);
          switch (f.operator) {
            case 'equals': return lower(value) === needle;
            case 'notEquals': return lower(value) !== needle;
            case 'contains': return lower(value).includes(needle);
            case 'startsWith': return lower(value).startsWith(needle);
            case 'endsWith': return lower(value).endsWith(needle);
            case 'isEmpty': return Array.isArray(value) ? value.length === 0 : !value;
            case 'isNotEmpty': return Array.isArray(value) ? value.length > 0 : !!value;
            case 'isTrue': return value === true;
            case 'isFalse': return value === false;
            case 'includes': return values.includes(needle);
            case 'excludes': return !values.includes(needle);
            case 'isAnyOf': return any.some((v) => Array.isArray(value) ? values.includes(v) : lower(value) === v);
            default: return false;
          }
        };
        let rows = await records.toCollection().toArray();
        rows = rows.filter((row: any) => {
          if (!dto.includeBlockchainDiscovered &&
              (row.addressImportance === 'blockchain-discovered' || row.addressImportance === 'pending-review')) return false;
          if (dto.visibleTiers?.length && !dto.includeBlockchainDiscovered &&
              row.addressImportance && !dto.visibleTiers.includes(row.addressImportance)) return false;
          if (dto.requireCreatedAt && !row.createdAt) return false;
          if (dto.addedSince !== undefined && (!row.createdAt || row.createdAt < dto.addedSince)) return false;
          const q = lower(dto.search).trim();
          if (q && ![row.label, row.inputString, row.owner, row.walletName, row.notes]
            .some((v) => lower(v).includes(q)) && !row.tags?.some((v: string) => lower(v).includes(q))) return false;
          return dto.filters.every((f) => matches(row, f));
        });
        const beforeId = dto.beforeId;
        if (beforeId !== undefined) rows = rows.filter((row: any) => row.id < beforeId);
        rows.sort((a: any, b: any) => dto.order === 'created-asc'
          ? (a.createdAt - b.createdAt) || (a.id - b.id)
          : dto.order === 'created-desc'
            ? (b.createdAt - a.createdAt) || (b.id - a.id)
            : b.id - a.id);
        return rows.slice(0, limit);
      }
    }
  }

  async query<T>(table: VaultTableName, name: ProtectedRepositoryQueryName, value: any, limit = MAX_PAGE_SIZE): Promise<T[]> {
    limit = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
    let collection: any;
    switch (name) {
      case 'records.byInputStringLower': collection = this.table(table).where('inputStringLower').equals(value.toLowerCase()); break;
      case 'records.byRecordType': collection = this.table(table).where('type').equals(value); break;
      case 'records.byRecordId':
      case 'attachments.byRecordId': collection = this.table(table).where('recordId').equals(value); break;
      case 'records.byInputStringAndType':
        collection = this.table(table).where('inputString').equals(value.inputString)
          .and((row: any) => row.type === value.type);
        break;
      case 'records.byIds': collection = this.table(table).where('id').anyOf(value); break;
      case 'records.byInputStrings': collection = this.table(table).where('inputString').anyOf(value); break;
      case 'records.byTypeIdForwardKeyset':
        collection = this.table(table).where('[type+id]').between(
          [value.type, value.afterIdExclusive ?? -Infinity], [value.type, Infinity],
          value.afterIdExclusive == null, true,
        );
        break;
      case 'records.byTypeIdReverseKeyset':
        collection = this.table(table).where('[type+id]').between(
          [value.type, -Infinity], [value.type, value.beforeIdExclusive ?? Infinity],
          true, value.beforeIdExclusive == null,
        ).reverse();
        break;
      case 'records.byTypeAndImportanceTiersKeyset':
        collection = this.table(table).where('[type+id]').between(
          [value.type, -Infinity], [value.type, value.beforeIdExclusive ?? Infinity],
          true, value.beforeIdExclusive == null,
        ).reverse().and((row: any) => value.tiers.includes(row.addressImportance));
        break;
      case 'records.byDiscoveredFromRecordIds': collection = this.table(table).where('discoveredFromRecordId').anyOf(value); break;
      case 'records.countByType':
        return [{ count: await this.table(table).where('type').equals(value).count() }] as T[];
      case 'origins.byRecordIds': collection = this.table(table).where('recordId').anyOf(value); break;
      case 'attachments.byIdentifier': collection = this.table(table).where('identifier').equals(value); break;
      case 'transactions.byTransactionId': collection = this.table(table).where('txid').equals(value); break;
      case 'transactions.byTxid': collection = this.table(table).where('txid').equals(value); break;
      case 'transactions.byTxids': collection = this.table(table).where('txid').anyOf(value); break;
      case 'transactions.byBlockTime': collection = this.table(table).orderBy('blockTime'); break;
      case 'transactions.byCurationState': collection = this.table(table).where('curationState').equals(value); break;
      case 'transactions.afterId': collection = this.table(table).where('id').above(value); break;
      case 'participants.byTxid': collection = this.table(table).where('txid').equals(value); break;
      case 'participants.byTxids': collection = this.table(table).where('txid').anyOf(value); break;
      case 'participants.byTxidsAfterId':
        collection = this.table(table).where('id').above(value.afterId)
          .filter((row: any) => value.txids.includes(row.txid));
        break;
      case 'participants.byAddress': collection = this.table(table).where('address').equals(value); break;
      case 'participants.byAddresses': collection = this.table(table).where('address').anyOf(value); break;
      case 'participants.byAddressesAfterId': {
        const addresses = new Set(value.addresses);
        collection = this.table(table).where('id').above(value.afterId)
          .filter((row: any) => addresses.has(row.address));
        break;
      }
      case 'participants.byRecordId': collection = this.table(table).where('recordId').equals(value); break;
      case 'participants.byRecordIds': collection = this.table(table).where('recordId').anyOf(value); break;
      case 'participants.byPrevout': collection = this.table(table).where('[prevTxid+prevVout]').equals(value); break;
      case 'participants.byPrevouts': collection = this.table(table).where('[prevTxid+prevVout]').anyOf(value); break;
      case 'participants.byRole': collection = this.table(table).where('role').equals(value); break;
      case 'participants.afterId': collection = this.table(table).where('id').above(value); break;
      case 'sync.byLastSyncedAt': collection = this.table(table).orderBy('lastSyncedAt').reverse(); break;
      case 'sync.skippedByRun': collection = this.table(table).where('syncRunTimestamp').equals(value); break;
      case 'sync.activeSkipped': collection = this.table(table).filter((row: any) => !row.dismissed); break;
      case 'sync.dismissAllSkipped': collection = this.table(table).toCollection(); break;
      case 'sync.byAddresses': collection = this.table(table).where('address').anyOf(value); break;
      case 'sync.afterId': collection = this.table(table).where('id').above(value); break;
      case 'price.byDateCurrencyAsset': collection = this.table(table).where('[date+currency+asset]').equals(value); break;
      case 'price.byDateCurrencyAssetKeys': collection = this.table(table).where('[date+currency+asset]').anyOf(value); break;
      case 'price.byAsset':
        collection = this.table(table).where('asset').equals(value.asset);
        if (value.currency) collection = collection.filter((row: any) => row.currency === value.currency);
        break;
      case 'price.latestOnOrBefore':
        collection = this.table(table).where('date').belowOrEqual(value.date)
          .and((row: any) => row.currency === value.currency && row.asset === value.asset).reverse();
        break;
      case 'savedPsbts.byCreatedAt': collection = this.table(table).orderBy('createdAt').reverse(); break;
      case 'sync.byAddress': collection = this.table(table).where('address').equals(value); break;
      case 'lineage.bySpentOutpoint': collection = this.table(table).where('[spentTxid+spentVout]').equals(value); break;
      case 'lineage.byCreatedOutpoint': collection = this.table(table).where('[createdTxid+createdVout]').equals(value); break;
      case 'lineage.byCreatedOutpoints': collection = this.table(table).where('[createdTxid+createdVout]').anyOf(value); break;
      case 'lineage.bySpentAddress': collection = this.table(table).where('spentAddress').equals(value); break;
      case 'lineage.byCreatedAddress': collection = this.table(table).where('createdAddress').equals(value); break;
      case 'lineage.bySegmentId': collection = this.table(table).where('segmentId').equals(value); break;
      case 'lineage.bySnapshotId': collection = this.table(table).where('snapshotId').equals(value); break;
      case 'lineage.byOriginOutpoint': collection = this.table(table).where('[originTxid+originVout]').equals(value); break;
      case 'lineage.byOriginAddress': collection = this.table(table).where('originAddress').equals(value); break;
      case 'lineage.byCurrentAddress': collection = this.table(table).where('currentAddress').equals(value); break;
      case 'evidenceAttachments.byEvidenceId': collection = this.table(table).where('evidenceId').equals(value); break;
      default: throw new Error(`Unsupported vault query: ${name}`);
    }
    return collection.limit(limit).toArray() as Promise<T[]>;
  }

  async command<T>(name: ProtectedRepositoryCommandName, value: any): Promise<T> {
    if (name !== 'cleanup.deleteRecordWithOrigins' || !Number.isSafeInteger(value?.recordId)) {
      throw new Error(`Unsupported vault command: ${name}`);
    }
    const id = value.recordId;
    return this.database.transaction('rw', this.table('records'), this.table('recordOrigins'), async () => {
      const deleted = await this.table('records').delete(id);
      await this.table('recordOrigins').where('recordId').equals(id).delete();
      return { deleted: deleted !== 0 } as T;
    });
  }

  async saveTransactionWithParticipants(command: TransactionParticipantsCommit) {
    return this.database.transaction(
      'rw',
      this.table('blockchainTransactions'),
      this.table('transactionParticipants'),
      async () => {
        const transactionId = await this.table('blockchainTransactions').add(command.transaction);
        if (command.replaceParticipants !== false) {
          await this.table('transactionParticipants').where('txid').equals(command.transaction.txid).delete();
        }
        const participantIds = command.participants.length
          ? await this.table('transactionParticipants').bulkAdd(command.participants, { allKeys: true })
          : [];
        return { transactionId, participantIds };
      },
    );
  }

  async deleteOrArchiveRecords(command: RecordDeleteOrArchiveCommand) {
    return this.database.transaction(
      'rw',
      this.table('records'),
      this.table('recordOrigins'),
      async () => {
        let deleted = 0;
        let archived = 0;
        for (const id of [...new Set(command.recordIds)]) {
          if (command.mode === 'delete') {
            await this.table('recordOrigins').where('recordId').equals(id).delete();
            const exists = await this.table('records').get(id);
            await this.table('records').delete(id);
            if (exists) deleted++;
          } else {
            const row = await this.table('records').get(id);
            if (!row) continue;
            await this.table('records').put({
              ...row,
              archived: true,
              archivedAt: command.archivedAt ?? Date.now(),
              archiveReason: command.archiveReason,
            });
            archived++;
          }
        }
        return { deleted, archived };
      },
    );
  }

  async saveSettingsWithHistory(command: SettingsHistoryCommit) {
    return this.database.transaction(
      'rw',
      this.table('settings'),
      this.table('privacyAuditHistory'),
      async () => {
        const settingsId = await this.table('settings').put(command.settings);
        const historyId = command.historyEntry
          ? await this.table('privacyAuditHistory').add(command.historyEntry)
          : undefined;
        if (command.retainHistory !== undefined) {
          const total = await this.table('privacyAuditHistory').count();
          const excess = Math.max(0, total - command.retainHistory);
          if (excess) {
            const ids = await this.table('privacyAuditHistory')
              .orderBy('timestamp').limit(excess).primaryKeys();
            await this.table('privacyAuditHistory').bulkDelete(ids);
          }
        }
        return {
          settingsId,
          historyId,
          retainedHistory: await this.table('privacyAuditHistory').count(),
        };
      },
    );
  }

  async clearVault() {
    const tables = this.database.tables;
    return this.database.transaction(
      'rw',
      tables,
      async () => {
        let deleted = 0;
        for (const table of tables) {
          deleted += await table.count();
          await table.clear();
        }
        return { deleted };
      },
    );
  }

  async restoreCommit(command: RestoreVaultCommit) {
    const names = Object.keys(command.rows) as VaultTableName[];
    const tables = [...new Set(command.replaceExisting
      ? this.database.tables
      : names.map((name) => this.table(name)))];
    return this.database.transaction('rw', tables, async () => {
      if (command.replaceExisting) {
        for (const table of this.database.tables) await table.clear();
      }
      let saved = 0;
      for (const name of names) {
        const rows = command.rows[name] as any[] | undefined;
        if (!rows?.length) continue;
        await this.table(name).bulkPut(rows);
        saved += rows.length;
      }
      return { saved };
    });
  }

  transaction<T>(tables: VaultTableName[], operation: () => Promise<T>): Promise<T> {
    return this.database.transaction('rw', tables.map((table) => this.table(table)), operation);
  }
}