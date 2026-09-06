import {
  db, notifyDbChange, isUserCuratedImportance,
  type AddressOwnership, type AddressOwnershipState, type EntityKind, type OwnerMatchingMethod,
  type RecordEntity, type RecordWallet, type TransactionLegDirection,
  type TransactionLegMetadata, type TransactionMetadata,
} from '../database';
import { isValidImportanceTier } from '../db-types';
import { getRecord, getRecordsAfterId } from './record-crud';
import { getParticipantsByTxids } from './transaction-crud';

const OWNERSHIP_STATES = new Set<AddressOwnershipState>([
  'assigned', 'ours-owner-unknown', 'not-ours', 'undetermined',
]);
const LEG_DIRECTIONS = new Set<TransactionLegDirection>([
  'incoming', 'outgoing', 'owner-transfer',
]);

export const OWNER_MATCHING_METHODS = new Set<OwnerMatchingMethod>([
  'fifo', 'lifo', 'hifo', 'specific-identification', 'proportional',
]);
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function key(value: string): string { return value.trim().toLocaleLowerCase(); }
function vaultKey(vault: RecordWallet['vault']): string {
  if (!vault) return '';
  // Explicit fields, rather than JSON.stringify, keep identity stable if a
  // backup/parser changes object property order.
  return [
    vault.isVaultXpub ? '1' : '0',
    key(vault.vaultName ?? ''),
    vault.m ?? '',
    vault.n ?? '',
    vault.vaultNotes ?? '',
  ].join(':');
}
function meaningfulMetadata(value: unknown): boolean {
  return value !== undefined && value !== null &&
    (!(typeof value === 'string') || value.trim() !== '') &&
    (!Array.isArray(value) || value.length > 0);
}

function optionalNonNegativeFinite(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error(`${field} must be a finite nonnegative number`);
  }
}
/**
 * Single-owner inference is deliberately stricter than historical browse
 * visibility. Only a recognized, user-curated tier is affirmative evidence;
 * a missing/unknown tier can be an old discovered row and must not make us
 * guess that blank addresses belong to Me.
 */
function isAffirmativelyCuratedAddress(record: {
  addressImportance?: unknown; syncDepth?: number; source?: string; discoveredInTxid?: string;
}): boolean {
  return isValidImportanceTier(record.addressImportance) &&
    isUserCuratedImportance(record.addressImportance) &&
    !(record.syncDepth !== undefined && record.syncDepth > 0) &&
    record.source !== 'blockchain-sync' &&
    !record.discoveredInTxid;
}

/** Guarded natural-key upsert. Names are display values; naturalKey is identity. */
export async function ensureRecordEntity(
  name: string, kind: EntityKind = 'person', counterpartyType?: RecordEntity['counterpartyType'],
): Promise<RecordEntity> {
  const displayName = text(name);
  if (!displayName) throw new Error('Entity name is required');
  const naturalKey = `${kind}:${key(displayName)}`;
  const existing = await db.entities.where('naturalKey').equals(naturalKey).first();
  if (existing) {
    // Do not replace a user-established classification, but retain a legacy
    // counterparty type if this is the first source to supply it.
    if (kind === 'counterparty' && existing.counterpartyType === undefined && counterpartyType !== undefined) {
      const updated = { ...existing, counterpartyType, updatedAt: Date.now() };
      await db.entities.put(updated);
      return updated;
    }
    return existing;
  }
  const now = Date.now();
  try {
    const id = await db.entities.add({ naturalKey, name: displayName, kind, counterpartyType, createdAt: now, updatedAt: now });
    return { id: id as number, naturalKey, name: displayName, kind, counterpartyType, createdAt: now, updatedAt: now };
  } catch (error) {
    // The unique index is the concurrency guard; return the winner.
    const winner = await db.entities.where('naturalKey').equals(naturalKey).first();
    if (winner) return winner;
    throw error;
  }
}

export async function ensureRecordWallet(input: {
  name: string; entityId?: number; seedName?: string; walletSoftware?: string; vault?: RecordWallet['vault'];
}): Promise<RecordWallet> {
  const name = text(input.name);
  if (!name) throw new Error('Wallet name is required');
  const entity = input.entityId === undefined ? undefined : await db.entities.get(input.entityId);
  if (input.entityId !== undefined && !entity) throw new Error('Wallet entity does not exist');
  // IDs are local implementation details. A wallet key must remain stable when
  // backup/restore or merge assigns the same entity a different surrogate ID.
  const naturalKey = [key(name), entity?.naturalKey ?? '', key(input.seedName ?? ''), key(input.walletSoftware ?? ''),
    vaultKey(input.vault)].join('|');
  const existing = await db.wallets.where('naturalKey').equals(naturalKey).first();
  if (existing) return existing;
  const now = Date.now();
  const wallet = { naturalKey, name, entityId: input.entityId, seedName: text(input.seedName),
    walletSoftware: text(input.walletSoftware), vault: input.vault, createdAt: now, updatedAt: now };
  try {
    const id = await db.wallets.add(wallet);
    return { ...wallet, id: id as number };
  } catch (error) {
    const winner = await db.wallets.where('naturalKey').equals(naturalKey).first();
    if (winner) return winner;
    throw error;
  }
}

export async function putAddressOwnership(input: Omit<AddressOwnership, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
  if (!Number.isSafeInteger(input.recordId) || input.recordId <= 0) throw new Error('A valid address record id is required');
  if (!OWNERSHIP_STATES.has(input.state)) throw new Error('Invalid address ownership state');
  if (input.state === 'assigned' && !input.entityId) throw new Error('Assigned ownership requires an entity');
  if (input.entityId !== undefined && !await db.entities.get(input.entityId)) throw new Error('Ownership entity does not exist');
  if (input.counterpartyEntityId !== undefined) {
    const counterparty = await db.entities.get(input.counterpartyEntityId);
    if (!counterparty || counterparty.kind !== 'counterparty') throw new Error('Counterparty linkage requires a counterparty entity');
  }
  const existing = await db.addressOwnership.where('recordId').equals(input.recordId).first();
  const now = Date.now();
  await db.addressOwnership.put({ ...existing, ...input, id: existing?.id, createdAt: existing?.createdAt ?? now, updatedAt: now });
  notifyDbChange('addressOwnership');
}

export async function putTransactionMetadata(input: Omit<TransactionMetadata, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
  if (!text(input.txid)) throw new Error('Transaction id is required');
  validateCostBasisValues(input);
  if (input.counterpartyEntityId !== undefined) {
    const counterparty = await db.entities.get(input.counterpartyEntityId);
    if (!counterparty || counterparty.kind !== 'counterparty') throw new Error('Transaction counterparty must be a counterparty entity');
  }
  const existing = await db.transactionMetadata.where('txid').equals(input.txid).first();
  const now = Date.now();
  const normalized = { ...sanitizeOwnerCostBasisImport(input), txid: text(input.txid)! };
  await db.transactionMetadata.put({ ...existing, ...normalized, id: existing?.id, createdAt: existing?.createdAt ?? now, updatedAt: now });
  notifyDbChange('transactionMetadata');
}

export async function putTransactionLegMetadata(input: Omit<TransactionLegMetadata, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
  if (!text(input.txid) || !text(input.legKey)) throw new Error('Transaction id and leg key are required');
  if (!LEG_DIRECTIONS.has(input.direction)) throw new Error('Invalid transaction leg direction');
  if (input.transferBasisRule !== undefined && !TRANSFER_BASIS_RULES.has(input.transferBasisRule)) throw new Error('Invalid transfer basis rule');
  validateCostBasisValues(input);
  const existing = await db.transactionLegMetadata.where('[txid+legKey]').equals([input.txid, input.legKey]).first();
  const now = Date.now();
  const normalized = { ...sanitizeOwnerCostBasisImport(input), txid: text(input.txid)!, legKey: text(input.legKey)! };
  await db.transactionLegMetadata.put({ ...existing, ...normalized, id: existing?.id, createdAt: existing?.createdAt ?? now, updatedAt: now });
  notifyDbChange('transactionLegMetadata');
}

/** Normalized metadata reads for curation surfaces; callers must not reach into tables. */
export async function getTransactionMetadataByTxid(txid: string): Promise<TransactionMetadata | undefined> {
  return db.transactionMetadata.where('txid').equals(txid).first();
}

export async function clearTransactionLegMetadata(txid: string, legKey: string): Promise<void> {
  await db.transactionLegMetadata.where('[txid+legKey]').equals([txid, legKey]).delete();
  notifyDbChange('transactionLegMetadata');
}

export async function getAddressOwnership(recordId: number): Promise<AddressOwnership | undefined> {
  return db.addressOwnership.where('recordId').equals(recordId).first();
}

/** Batched ownership read for annotation context construction. */
export async function getAddressOwnershipForRecords(recordIds: number[]): Promise<AddressOwnership[]> {
  if (!recordIds.length) return [];
  return db.addressOwnership.where('recordId').anyOf(recordIds).toArray();
}

export interface RecordModelMigrationProgress { phase: 'addresses' | 'transactions' | 'complete'; processed: number; }
export interface RunRecordModelMigrationOptions {
  batchSize?: number;
  onProgress?: (progress: RecordModelMigrationProgress) => void;
  /** Tests and shutdown handlers may stop cleanly after a committed batch. */
  shouldContinue?: () => boolean;
}

async function createAddressProjection(record: Awaited<ReturnType<typeof getRecordsAfterId>>[number], singleOwner: boolean): Promise<void> {
  if (!record.id || record.type !== 'address') return;
  // Sync-discovered rows are uncertain even in old vaults whose importance
  // tier was missing or incorrectly normalized by a prior release.
  const curated = isAffirmativelyCuratedAddress(record);
  const ownerName = text(record.owner);
  let entityId: number | undefined;
  let state: AddressOwnershipState;
  if (!curated) state = 'undetermined'; // discovered rows are never guessed
  else if (ownerName && ownerName.toLowerCase() !== 'unknown') {
    entityId = (await ensureRecordEntity(ownerName)).id;
    state = 'assigned';
  } else if (singleOwner) {
    entityId = (await ensureRecordEntity('Me', 'self')).id;
    state = 'assigned';
  } else state = 'ours-owner-unknown';

  const counterpartyEntityId = text(record.counterpartyName)
    ? (await ensureRecordEntity(record.counterpartyName!, 'counterparty', record.counterpartyType)).id
    : undefined;
  let walletId: number | undefined;
  if (text(record.walletName)) {
    walletId = (await ensureRecordWallet({ name: record.walletName!, entityId, seedName: record.seedName,
      walletSoftware: record.walletSoftware, vault: record.vault })).id;
  }
  await putAddressOwnership({ recordId: record.id, state, entityId, counterpartyEntityId, walletId, confidence: record.addressImportance });
}

async function createTransactionProjection(record: Awaited<ReturnType<typeof getRecordsAfterId>>[number]): Promise<void> {
  if (record.type !== 'transaction' || !text(record.inputString)) return;
  const txid = record.inputString;
  const hasDefault = [record.flowType, record.acquisitionMethod, record.dispositionType, record.costBasisUsd,
    record.categories, record.tags, record.notes].some(meaningfulMetadata);
  const counterpartyEntityId = text(record.counterpartyName)
    ? (await ensureRecordEntity(record.counterpartyName!, 'counterparty', record.counterpartyType)).id
    : undefined;
  if (hasDefault || counterpartyEntityId) await putTransactionMetadata({ txid, flowType: record.flowType, acquisitionMethod: record.acquisitionMethod,
    dispositionType: record.dispositionType, costBasisUsd: record.costBasisUsd, categories: record.categories,
    tags: record.tags, notes: record.notes, counterpartyEntityId });

  const participants = await getParticipantsByTxids([txid]);
  const own = participants.filter(p => p.recordId !== undefined);
  const hasInput = own.some(p => p.role === 'input');
  for (const participant of own) {
    const address = participant.recordId == null ? undefined : await getRecord(participant.recordId);
    if (!address) continue;
    const hasLegMetadata = [address.flowType, address.acquisitionMethod, address.dispositionType, address.costBasisUsd,
      address.categories, address.tags, address.notes].some(meaningfulMetadata);
    if (!hasLegMetadata) continue;
    const direction: TransactionLegDirection = participant.role === 'input' ? 'outgoing' : hasInput ? 'owner-transfer' : 'incoming';
    const ownership = await getAddressOwnership(address.id!);
    const differingFlow = address.flowType !== undefined && address.flowType !== record.flowType;
    await putTransactionLegMetadata({ txid, legKey: `${participant.role}:${participant.vout ?? participant.id ?? participant.address}`,
      direction, entityId: ownership?.entityId, walletId: ownership?.walletId, flowType: address.flowType,
      acquisitionMethod: address.acquisitionMethod, dispositionType: address.dispositionType, costBasisUsd: address.costBasisUsd,
      categories: address.categories, tags: address.tags, notes: address.notes, hasFlowOverride: differingFlow });
  }
}

/** Post-unlock projection. Each checkpoint is committed after a bounded batch; no legacy row is deleted. */
export async function runRecordModelMigration(options: RunRecordModelMigrationOptions = {}): Promise<RecordModelMigrationProgress> {
  const batchSize = options.batchSize ?? 250;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  let state = await db.recordModelMigrationState.get('v44');
  if (state?.phase === 'complete') return { phase: 'complete', processed: 0 };
  if (!state) {
    const owners = new Set<string>();
    let cursor = 0;
    for (;;) {
      const rows = await getRecordsAfterId(cursor, batchSize);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id ?? cursor;
      rows.filter(r => r.type === 'address' && isAffirmativelyCuratedAddress(r))
        .map(r => text(r.owner)).filter((v): v is string => !!v && v.toLowerCase() !== 'unknown')
        .forEach(v => owners.add(key(v)));
    }
    state = { id: 'v44', phase: 'addresses', lastRecordId: 0, singleOwner: owners.size === 1, updatedAt: Date.now() };
    await db.recordModelMigrationState.put(state);
  }
  let processed = 0;
  while (state.phase !== 'complete') {
    const rows = await getRecordsAfterId(state.lastRecordId, batchSize);
    if (!rows.length) {
      if (state.phase === 'addresses') state = { ...state, phase: 'transactions', lastRecordId: 0, updatedAt: Date.now() };
      else state = { ...state, phase: 'complete', completedAt: Date.now(), updatedAt: Date.now() };
      await db.recordModelMigrationState.put(state);
      options.onProgress?.({ phase: state.phase, processed });
      continue;
    }
    for (const row of rows) {
      if (state.phase === 'addresses') await createAddressProjection(row, !!state.singleOwner);
      else await createTransactionProjection(row);
    }
    state = { ...state, lastRecordId: rows[rows.length - 1].id ?? state.lastRecordId, updatedAt: Date.now() };
    await db.recordModelMigrationState.put(state);
    processed += rows.length;
    options.onProgress?.({ phase: state.phase, processed });
    if (options.shouldContinue && !options.shouldContinue()) break;
  }
  return { phase: state.phase, processed };
}

/** Backup/import sanitizer. Invalid optional accounting values are omitted; IDs
 * are normalized once so restore and user writes share the same constraints. */
export function sanitizeOwnerCostBasisImport<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = { ...input };
  for (const field of ['txid', 'legKey']) {
    if (field in output) {
      const normalized = text(output[field]);
      if (normalized) output[field] = normalized;
      else delete output[field];
    }
  }
  for (const field of ['costBasisUsd', 'estimatedCostBasisUsd', 'proceedsUsd', 'estimatedProceedsUsd', 'marketValueUsd', 'estimatedMarketValueUsd']) {
    if (field in output && (typeof output[field] !== 'number' || !Number.isFinite(output[field]) || output[field] < 0)) delete output[field];
  }
  if ('transferBasisRule' in output && !TRANSFER_BASIS_RULES.has(output.transferBasisRule as NonNullable<TransactionLegMetadata['transferBasisRule']>)) delete output.transferBasisRule;
  if ('specificLotIds' in output) {
    if (!Array.isArray(output.specificLotIds)) delete output.specificLotIds;
    else output.specificLotIds = [...new Set(output.specificLotIds.map(text).filter((id): id is string => !!id))];
  }
  return output as T;
}

function validateCostBasisValues(input: Pick<TransactionMetadata, 'costBasisUsd' | 'estimatedCostBasisUsd' | 'proceedsUsd' | 'estimatedProceedsUsd'> | Pick<TransactionLegMetadata, 'costBasisUsd' | 'estimatedCostBasisUsd' | 'proceedsUsd' | 'estimatedProceedsUsd' | 'marketValueUsd' | 'estimatedMarketValueUsd' | 'specificLotIds'>): void {
  optionalNonNegativeFinite(input.costBasisUsd, 'Cost basis');
  optionalNonNegativeFinite(input.estimatedCostBasisUsd, 'Estimated cost basis');
  optionalNonNegativeFinite(input.proceedsUsd, 'Proceeds');
  optionalNonNegativeFinite(input.estimatedProceedsUsd, 'Estimated proceeds');
  if ('marketValueUsd' in input) {
    optionalNonNegativeFinite(input.marketValueUsd, 'Market value');
    optionalNonNegativeFinite(input.estimatedMarketValueUsd, 'Estimated market value');
    if (input.specificLotIds && (!Array.isArray(input.specificLotIds) || input.specificLotIds.some(id => !text(id)))) throw new Error('Specific lot ids must not be blank');
  }
}

/** Full normalized-model snapshot reads. Callers may invoke these inside a
 * Dexie transaction spanning the source tables to obtain one atomic report
 * revision without bypassing the guarded CRUD boundary. */
export async function getAllTransactionMetadata(): Promise<TransactionMetadata[]> {
  return db.transactionMetadata.toArray();
}

export async function getTransactionLegMetadataByTxid(txid: string): Promise<TransactionLegMetadata[]> {
  return db.transactionLegMetadata.where('txid').equals(txid).toArray();
}

export async function getAllRecordEntities(): Promise<RecordEntity[]> {
  return db.entities.toArray();
}

export const TRANSFER_BASIS_RULES = new Set<NonNullable<TransactionLegMetadata['transferBasisRule']>>([
  'carry-over', 'market-value-step-up',
]);

export async function getAllTransactionLegMetadata(): Promise<TransactionLegMetadata[]> {
  return db.transactionLegMetadata.toArray();
}

export async function getAllAddressOwnership(): Promise<AddressOwnership[]> {
  return db.addressOwnership.toArray();
}
