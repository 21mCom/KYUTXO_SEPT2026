import { db, notifyDbChange, USER_CURATED_TIERS, type BlockchainTransaction, type TransactionParticipant, type TransactionCurationState, type Record, type SavedInboxView, type SavedInboxViewFilters } from '../database';
import { getAttachmentsByRecordId } from './attachments-crud';
import { getRecordsByInputStrings } from './record-crud';
import Dexie from 'dexie';

export type CreateTransactionData = Omit<BlockchainTransaction, 'id'>;

export interface TransactionWriteOptions {
  skipNotification?: boolean;
}

export interface TransactionCurationUpdateOptions extends TransactionWriteOptions {
  snoozedUntil?: number;
}

const CURATION_STATES = new Set<TransactionCurationState>([
  'new',
  'snoozed',
  'annotated',
  'ignored',
]);

function isFiniteOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isStringArray(value: unknown): value is string[] | undefined {
  return value === undefined ||
    (Array.isArray(value) && value.every(entry => typeof entry === 'string'));
}

function validateSavedInboxFilters(value: unknown): value is SavedInboxViewFilters {
  if (!value || typeof value !== 'object') return false;
  const filters = value as Partial<SavedInboxViewFilters>;
  if (!['any', 'range', 'exact'].includes(filters.dateMode as string)) return false;
  if (!['any', 'range', 'exact'].includes(filters.amountMode as string)) return false;
  for (const key of ['dateStart', 'dateEnd', 'dateExact', 'entityAddress'] as const) {
    if (filters[key] !== undefined && typeof filters[key] !== 'string') return false;
  }
  return isFiniteOptionalNumber(filters.amountMinBtc) &&
    isFiniteOptionalNumber(filters.amountMaxBtc) &&
    isFiniteOptionalNumber(filters.amountExactBtc) &&
    isStringArray(filters.entityWallet) &&
    isStringArray(filters.entitySeed) &&
    isStringArray(filters.entityOwner) &&
    isStringArray(filters.entityTag) &&
    isStringArray(filters.entityCategory);
}

/**
 * Validate the serializable settings shape before it is loaded or crosses a
 * backup boundary. Malformed views are ignored instead of crashing the inbox.
 */
export function sanitizeSavedInboxViews(value: unknown): SavedInboxView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.filter((candidate): candidate is SavedInboxView => {
    if (!candidate || typeof candidate !== 'object') return false;
    const view = candidate as Partial<SavedInboxView>;
    return typeof view.id === 'string' &&
      view.id.trim().length > 0 &&
      typeof view.name === 'string' &&
      view.name.trim().length > 0 &&
      view.name.length <= 100 &&
      typeof view.tab === 'string' &&
      CURATION_STATES.has(view.tab as TransactionCurationState) &&
      typeof view.search === 'string' &&
      typeof view.createdAt === 'number' &&
      Number.isFinite(view.createdAt) &&
      validateSavedInboxFilters(view.filters);
  });
  return valid.length === value.length ? valid : (valid.length > 0 ? valid : undefined);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

/** Shared definition used by migration, sync backfill, and the inbox. */
export function transactionRecordHasUserMetadata(record: Partial<Record>): boolean {
  return [
    record.label,
    record.notes,
    record.tags,
    record.categories,
    record.owner,
    record.walletName,
    record.seedName,
    record.walletSoftware,
    record.privateKeyStatus,
    record.customFields,
    record.flowType,
    record.acquisitionMethod,
    record.dispositionType,
    record.costBasisUsd,
    record.counterpartyType,
    record.counterpartyName,
    record.conflictResolutions,
  ].some(hasMeaningfulValue);
}

export async function addTransaction(
  data: CreateTransactionData,
  options?: TransactionWriteOptions
): Promise<number> {
  const id = await db.blockchainTransactions.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }

  return id as number;
}

export async function updateTransaction(
  id: number,
  changes: Partial<CreateTransactionData>,
  options?: TransactionWriteOptions
): Promise<void> {
  await db.blockchainTransactions.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }
}

/**
 * Set the local review state without ever deleting the transaction. The
 * txid-unique transaction row is the inbox identity, so repeat calls are
 * idempotent and undo can restore the previous state exactly.
 */
export async function updateTransactionCuration(
  txid: string,
  state: TransactionCurationState,
  options?: TransactionCurationUpdateOptions,
): Promise<boolean> {
  const tx = await getTransactionByTxid(txid);
  if (!tx?.id) return false;
  await updateTransaction(tx.id, {
    curationState: state,
    curationUpdatedAt: Date.now(),
    snoozedUntil: state === 'snoozed' ? options?.snoozedUntil : undefined,
  }, options);
  return true;
}

export async function getTransactionCurationState(
  txid: string,
): Promise<Pick<BlockchainTransaction, 'curationState' | 'curationUpdatedAt' | 'snoozedUntil'> | undefined> {
  const tx = await getTransactionByTxid(txid);
  if (!tx) return undefined;
  return {
    curationState: tx.curationState,
    curationUpdatedAt: tx.curationUpdatedAt,
    snoozedUntil: tx.snoozedUntil,
  };
}

/** Count actionable rows; future snoozes remain persisted but are not due. */
export async function countActionableTransactionCurations(now = Date.now()): Promise<number> {
  return db.blockchainTransactions
    .where('curationState')
    .anyOf(['new', 'snoozed'])
    .filter(tx => tx.curationState === 'new' || (tx.snoozedUntil ?? 0) <= now)
    .count();
}

export async function countTransactionCurations(
  states?: TransactionCurationState[],
): Promise<number> {
  if (!states || states.length === 0) {
    return db.blockchainTransactions.where('curationState').above('').count();
  }
  return db.blockchainTransactions
    .where('curationState')
    .anyOf(states)
    .count();
}

/**
 * Queue a transaction only when one of its participants belongs to a
 * user-curated address. Unresolved Electrum inputs are attributed through
 * their previous output, so deeper sync cannot miss spends with blank input
 * addresses.
 */
export async function queueTransactionForReview(
  txid: string,
  options?: TransactionWriteOptions,
): Promise<boolean> {
  const tx = await getTransactionByTxid(txid);
  if (!tx || tx.curationState) return false;

  const participants = await db.transactionParticipants.where('txid').equals(txid).toArray();
  const recordIds = participants
    .map(p => p.recordId)
    .filter((id): id is number => typeof id === 'number');
  let owned = false;
  if (recordIds.length > 0) {
    const records = await db.records.bulkGet(recordIds);
    owned = records.some(record =>
      record?.type === 'address' &&
      (!record.addressImportance || USER_CURATED_TIERS.includes(record.addressImportance)),
    );
  }

  if (!owned) {
    const prevouts = participants
      .filter(p => p.role === 'input' && p.prevTxid && p.prevVout !== undefined)
      .map(p => [p.prevTxid as string, p.prevVout as number] as [string, number]);
    if (prevouts.length > 0) {
      // Some isolated unit-test databases intentionally carry an older minimal
      // schema. Production v42 always takes the batched compound-index path.
      const hasOutputIndex = db.transactionParticipants.schema.indexes
        .some(index => index.name === '[txid+role+vout]');
      const outputs = hasOutputIndex
        ? await db.transactionParticipants
            .where('[txid+role+vout]')
            .anyOf(prevouts.map(([prevTxid, prevVout]) => [prevTxid, 'output', prevVout]))
            .toArray()
        : (await Promise.all(prevouts.map(([prevTxid]) =>
            db.transactionParticipants.where('txid').equals(prevTxid).toArray(),
          ))).flat().filter(participant =>
            participant.role === 'output' &&
            prevouts.some(([prevTxid, prevVout]) =>
              participant.txid === prevTxid && participant.vout === prevVout),
          );
      const outputIds = outputs
        .map(p => p.recordId)
        .filter((id): id is number => typeof id === 'number');
      const records = await db.records.bulkGet(outputIds);
      owned = records.some(record =>
        record?.type === 'address' &&
        (!record.addressImportance || USER_CURATED_TIERS.includes(record.addressImportance)),
      );
    }
  }

  if (!owned) return false;

  const matchingRecords = (await getRecordsByInputStrings([txid]))
    .filter(record => record.type === 'transaction');
  let annotated = matchingRecords.some(transactionRecordHasUserMetadata);
  if (!annotated) {
    const attachmentGroups = await Promise.all(
      matchingRecords
        .filter(record => typeof record.id === 'number')
        .map(record => getAttachmentsByRecordId(record.id as number)),
    );
    annotated = attachmentGroups.some(group => group.length > 0);
  }
  await updateTransaction(tx.id as number, {
    curationState: annotated ? 'annotated' : 'new',
    curationUpdatedAt: Date.now(),
    snoozedUntil: undefined,
  }, options);
  return !annotated;
}

export async function getTransactionsByCurationState(
  state: TransactionCurationState,
  limit = 100,
  beforeId?: number,
): Promise<BlockchainTransaction[]> {
  const upperId = beforeId ?? Dexie.maxKey;
  return db.blockchainTransactions
    .where('[curationState+id]')
    .between([state, Dexie.minKey], [state, upperId], true, beforeId === undefined)
    .reverse()
    .limit(limit)
    .toArray();
}

export async function bulkAddTransactions(
  transactions: CreateTransactionData[],
  options?: TransactionWriteOptions
): Promise<number[]> {
  if (transactions.length === 0) return [];

  const ids = await db.blockchainTransactions.bulkAdd(transactions, { allKeys: true });

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }

  return ids as number[];
}

export async function bulkAddParticipants(
  participants: TransactionParticipant[],
  options?: TransactionWriteOptions
): Promise<number[]> {
  if (participants.length === 0) return [];

  const ids = await db.transactionParticipants.bulkAdd(participants, { allKeys: true });

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }

  return ids as number[];
}

// Bulk delete by primary key. Used by the merge-cancel undo pass in the v3
// restore to remove exactly the rows that merge inserted — never touches any
// other row.
export async function bulkDeleteTransactions(
  ids: number[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (ids.length === 0) return;

  await db.blockchainTransactions.bulkDelete(ids);

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }
}

export async function bulkDeleteParticipants(
  ids: number[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (ids.length === 0) return;

  await db.transactionParticipants.bulkDelete(ids);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function addParticipant(
  data: TransactionParticipant,
  options?: TransactionWriteOptions
): Promise<number> {
  const id = await db.transactionParticipants.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }

  return id as number;
}

export async function putParticipant(
  data: TransactionParticipant,
  options?: TransactionWriteOptions
): Promise<void> {
  if (!data.id) throw new Error('Cannot put participant without an id');

  await db.transactionParticipants.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function bulkPutParticipants(
  participants: TransactionParticipant[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (participants.length === 0) return;

  await db.transaction('rw', db.transactionParticipants, async () => {
    for (const p of participants) {
      if (p.id) await db.transactionParticipants.put(p);
    }
  });

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function clearTransactions(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.blockchainTransactions.clear();

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }
}

export async function clearParticipants(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.transactionParticipants.clear();

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function clearAllTransactionData(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();

  if (!options?.skipNotification) {
    notifyDbChange(['blockchainTransactions', 'transactionParticipants']);
  }
}

// =============================================================================
// READ HELPERS — blockchainTransactions
// =============================================================================

export async function getAllTransactions(): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// transaction table is never materialised at once: callers walk the table by
// repeatedly passing the last id they saw.
export async function getTransactionsAfterId(
  afterId: number,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions.where('id').above(afterId).limit(limit).toArray();
}

export async function getTransactionByTxid(
  txid: string
): Promise<BlockchainTransaction | undefined> {
  return db.blockchainTransactions.where('txid').equals(txid).first();
}

export async function getTransactionsByTxids(
  txids: string[]
): Promise<BlockchainTransaction[]> {
  if (txids.length === 0) return [];
  return db.blockchainTransactions.where('txid').anyOf(txids).toArray();
}

export async function bulkGetTransactionsByPrimaryKeys(
  keys: string[]
): Promise<(BlockchainTransaction | undefined)[]> {
  if (keys.length === 0) return [];
  return db.blockchainTransactions.bulkGet(keys);
}

export async function countTransactions(): Promise<number> {
  return db.blockchainTransactions.count();
}

export async function countTransactionsWithOpReturn(): Promise<number> {
  // NOTE: hasOpReturn is stored as a boolean, which is not a valid IndexedDB
  // key — where('hasOpReturn').equals(true) throws DataError at query time.
  // Scan-and-filter like the OP_RETURN page readers instead.
  return db.blockchainTransactions.filter(tx => tx.hasOpReturn === true).count();
}

export async function getTransactionsPageByBlockTime(
  offset: number,
  limit: number,
  ascending = false,
): Promise<BlockchainTransaction[]> {
  // Dexie's natural orderBy('blockTime') is already ascending — .reverse()
  // only for the default newest-first view.
  const query = db.blockchainTransactions.orderBy('blockTime');
  return (ascending ? query : query.reverse())
    .offset(offset)
    .limit(limit)
    .toArray();
}

export async function getOpReturnTransactionsPageByBlockTime(
  offset: number,
  limit: number,
  ascending = false,
): Promise<BlockchainTransaction[]> {
  const query = db.blockchainTransactions.orderBy('blockTime');
  return (ascending ? query : query.reverse())
    .filter(tx => tx.hasOpReturn === true)
    .offset(offset)
    .limit(limit)
    .toArray();
}

export async function getTransactionsByTxidStartsWith(
  prefix: string,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions
    .where('txid')
    .startsWithIgnoreCase(prefix)
    .limit(limit)
    .toArray();
}

export async function getOrderedTransactionPrimaryKeysByBlockTime(ascending = false): Promise<string[]> {
  const query = db.blockchainTransactions.orderBy('blockTime');
  return (await (ascending ? query : query.reverse())
    .primaryKeys()) as unknown as string[];
}

export async function getOpReturnTransactionPrimaryKeys(): Promise<string[]> {
  // Boolean hasOpReturn is not an indexable IndexedDB key (see
  // countTransactionsWithOpReturn) — collect keys via a scan instead.
  return (await db.blockchainTransactions
    .filter(tx => tx.hasOpReturn === true)
    .primaryKeys()) as unknown as string[];
}

// =============================================================================
// Entity-filtered transaction lookups (Dexie fallback for the engine's
// TransactionEntityFilter). Semantics mirror the engine SQL exactly: each active
// dimension is an independent "some participant satisfies this" predicate and
// dimensions compose with AND — the matching participants may differ per
// dimension. Slower than the engine (per-dimension participant walks) but
// correct; used when the engine mirror is stale or unavailable.
// =============================================================================

export interface TxEntityFilter {
  /** A participant with exactly this address (linked or not). */
  address?: string;
  /**
   * A participant linked (via recordId) to a record whose walletName matches
   * ANY of these values (OR within the dimension). A bare string is treated
   * as a single-value array.
   */
  wallet?: string | string[];
  /** A participant linked to a record whose seedName matches any of these. */
  seed?: string | string[];
  /** A participant linked to a record whose owner matches any of these. */
  owner?: string | string[];
  /** A participant linked to a record whose tags array contains any of these. */
  tag?: string | string[];
  /** A participant linked to a record whose categories array contains any of these. */
  category?: string | string[];
  /**
   * A participant linked to a user-curated address record (type='address',
   * addressImportance in USER_CURATED_TIERS). Matches the engine's curatedOnly.
   */
  curatedOnly?: boolean;
}

/** Normalizes a single-value-or-array filter field to a non-empty array, or undefined. */
function toValueArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.length > 0 ? arr : undefined;
}

/** True when any per-value entity dimension (not curatedOnly) is set. */
export function hasTxEntityDimensions(f: TxEntityFilter): boolean {
  return !!(
    f.address ||
    toValueArray(f.wallet) ||
    toValueArray(f.seed) ||
    toValueArray(f.owner) ||
    toValueArray(f.tag) ||
    toValueArray(f.category)
  );
}

const ENTITY_BATCH = 500;

/** Called between batches so long walks can yield to the UI / abort. */
type BatchPause = () => void | Promise<void>;

async function txidsForRecordIds(
  recordIds: number[],
  pause?: BatchPause,
): Promise<Set<string>> {
  const txids = new Set<string>();
  for (let i = 0; i < recordIds.length; i += ENTITY_BATCH) {
    const batch = recordIds.slice(i, i + ENTITY_BATCH);
    const parts = await db.transactionParticipants.where('recordId').anyOf(batch).toArray();
    for (const p of parts) txids.add(p.txid);
    if (pause && i + ENTITY_BATCH < recordIds.length) await pause();
  }
  return txids;
}

function intersect(a: Set<string> | null, b: Set<string>): Set<string> {
  if (a === null) return b;
  const out = new Set<string>();
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) out.add(t);
  return out;
}

/**
 * Per-record-dimension loaders for an entity filter: each returns the record
 * ids matching that dimension via an indexed lookup. Shared by the full-set
 * resolver and the bounded newest-first prefix walk so semantics stay in sync.
 */
function entityFilterRecordIdLoaders(filter: TxEntityFilter): Array<() => Promise<number[]>> {
  const recordDims: Array<() => Promise<number[]>> = [];
  const wallet = toValueArray(filter.wallet);
  if (wallet) {
    recordDims.push(async () => (await db.records.where('walletName').anyOf(wallet).primaryKeys()) as number[]);
  }
  const seed = toValueArray(filter.seed);
  if (seed) {
    recordDims.push(async () => (await db.records.where('seedName').anyOf(seed).primaryKeys()) as number[]);
  }
  const owner = toValueArray(filter.owner);
  if (owner) {
    recordDims.push(async () => (await db.records.where('owner').anyOf(owner).primaryKeys()) as number[]);
  }
  const tag = toValueArray(filter.tag);
  if (tag) {
    recordDims.push(async () => (await db.records.where('tags').anyOf(tag).primaryKeys()) as number[]);
  }
  const category = toValueArray(filter.category);
  if (category) {
    recordDims.push(async () => (await db.records.where('categories').anyOf(category).primaryKeys()) as number[]);
  }
  if (filter.curatedOnly) {
    recordDims.push(async () =>
      (await db.records
        .where('[type+addressImportance]')
        .anyOf(USER_CURATED_TIERS.map(t => ['address', t]))
        .primaryKeys()) as number[],
    );
  }
  return recordDims;
}

/**
 * Resolve the set of txids matching an entity filter on the Dexie path. Each
 * dimension resolves independently (indexed record lookup → participants by
 * recordId; address goes straight to the participants address index) and the
 * per-dimension txid sets are intersected, mirroring the engine's AND-of-EXISTS.
 */
export async function getTxidsForTxEntityFilter(
  filter: TxEntityFilter,
  pause?: BatchPause,
): Promise<Set<string>> {
  let result: Set<string> | null = null;

  if (filter.address) {
    const txids = new Set<string>();
    await db.transactionParticipants
      .where('address')
      .equals(filter.address)
      .each(p => { txids.add(p.txid); });
    result = intersect(result, txids);
    if (result.size === 0) return result;
    if (pause) await pause();
  }

  const recordDims = entityFilterRecordIdLoaders(filter);

  for (const getIds of recordDims) {
    const ids = await getIds();
    const txids = await txidsForRecordIds(ids, pause);
    result = intersect(result, txids);
    if (result.size === 0) return result;
    if (pause) await pause();
  }

  return result ?? new Set<string>();
}

/**
 * Opaque resume position for getOrderedTxidsForTxEntityFilterPrefix: the
 * blockTime keyset cursor plus the ids already processed AT that blockTime
 * (blockTime is not unique). Feed a prior result back via `resumeFrom` to
 * extend its prefix without re-scanning rows already walked.
 */
export interface TxEntityFilterPrefixCursor {
  cursorBlockTime: number;
  seenAtCursorIds: number[];
}

export interface TxEntityFilterPrefix {
  /** Matching txids in blockTime-descending (newest-first) order. */
  orderedTxids: string[];
  /**
   * True when the whole transactions table was walked: orderedTxids is the
   * COMPLETE ordered match list (its length is the exact filtered count).
   * False means the walk stopped early after collecting `neededCount` matches,
   * so orderedTxids is only a prefix and its length a lower bound.
   */
  exhausted: boolean;
  /**
   * Walk position after the last scanned row; pass the whole result back as
   * `resumeFrom` to continue the walk. null when nothing was scanned yet or
   * the table was exhausted (no further scanning possible).
   */
  cursor: TxEntityFilterPrefixCursor | null;
}

/**
 * Bounded newest-first fallback for huge vaults: walk transactions in
 * blockTime-descending order and collect txids matching the entity filter,
 * stopping as soon as `neededCount` matches are found. This lets the first
 * page of the curated default view (or an entity-filtered view) render in
 * time proportional to the page position instead of the vault size, while the
 * exact full set from getTxidsForTxEntityFilter resolves in the background.
 *
 * Semantics match getTxidsForTxEntityFilter / the engine SQL exactly: each
 * active dimension is an independent "some participant satisfies this"
 * predicate and dimensions compose with AND (the matching participants may
 * differ per dimension).
 *
 * Pass a prior result as `resumeFrom` to extend its prefix incrementally: the
 * walk restarts from the saved cursor and only scans rows not already scanned,
 * so paging forward is O(new rows) instead of restarting from the newest
 * transaction. `resumeFrom` must come from the same filter over unchanged data.
 */
export async function getOrderedTxidsForTxEntityFilterPrefix(
  filter: TxEntityFilter,
  neededCount: number,
  pause?: BatchPause,
  batchSize: number = ENTITY_BATCH,
  resumeFrom?: TxEntityFilterPrefix,
): Promise<TxEntityFilterPrefix> {
  // A resumable prior result that already covers the request (or finished the
  // table) is returned as-is — no scanning at all.
  if (resumeFrom && (resumeFrom.exhausted || resumeFrom.orderedTxids.length >= neededCount)) {
    return resumeFrom;
  }

  // Resolve every record-backed dimension to its record-id set up front (fast
  // indexed key scans). An empty dimension means nothing can match.
  const recordIdSets: Set<number>[] = [];
  for (const getIds of entityFilterRecordIdLoaders(filter)) {
    const ids = new Set(await getIds());
    if (ids.size === 0) return { orderedTxids: [], exhausted: true, cursor: null };
    recordIdSets.push(ids);
    if (pause) await pause();
  }
  const address = filter.address;
  const orderedTxids: string[] = resumeFrom ? [...resumeFrom.orderedTxids] : [];

  // Keyset paging down the blockTime index (newest-first). blockTime is not
  // unique, so the cursor is (blockTime, ids already processed AT that
  // blockTime): each round fetches belowOrEqual(cursor) with enough slack to
  // skip the boundary rows it has already seen. Within equal blockTime Dexie's
  // reverse index iteration yields descending primary key, matching the
  // engine's blockTime DESC, id DESC order. Crucially, no round ever touches
  // more than ~batchSize unseen rows, so work stops as soon as neededCount
  // matches are found — never proportional to the whole table.
  let cursorBlockTime: number | null = resumeFrom?.cursor ? resumeFrom.cursor.cursorBlockTime : null;
  let seenAtCursor = new Set<number>(resumeFrom?.cursor ? resumeFrom.cursor.seenAtCursorIds : []);

  while (true) {
    let batch: BlockchainTransaction[];
    let fetchLimit: number;
    if (cursorBlockTime === null) {
      fetchLimit = batchSize;
      batch = await db.blockchainTransactions
        .orderBy('blockTime')
        .reverse()
        .limit(fetchLimit)
        .toArray();
    } else {
      fetchLimit = batchSize + seenAtCursor.size;
      batch = await db.blockchainTransactions
        .where('blockTime')
        .belowOrEqual(cursorBlockTime)
        .reverse()
        .limit(fetchLimit)
        .toArray();
    }
    const exhaustedTable = batch.length < fetchLimit;

    const fresh = batch.filter(
      t => !(t.blockTime === cursorBlockTime && t.id != null && seenAtCursor.has(t.id as number)),
    );

    if (fresh.length > 0) {
      const txids = fresh.map(t => t.txid);
      const parts = await db.transactionParticipants.where('txid').anyOf(txids).toArray();
      const byTxid = new Map<string, TransactionParticipant[]>();
      for (const p of parts) {
        const arr = byTxid.get(p.txid);
        if (arr) arr.push(p);
        else byTxid.set(p.txid, [p]);
      }

      for (const t of fresh) {
        // Advance the cursor past THIS row before deciding it, so an early
        // return's cursor never claims unprocessed rows as seen (resume would
        // otherwise skip them).
        if (t.blockTime !== cursorBlockTime) {
          cursorBlockTime = t.blockTime;
          seenAtCursor = new Set<number>();
        }
        if (t.id != null) seenAtCursor.add(t.id as number);

        const txParts = byTxid.get(t.txid) ?? [];
        let matches = !address || txParts.some(p => p.address === address);
        if (matches) {
          for (const idSet of recordIdSets) {
            if (!txParts.some(p => p.recordId != null && idSet.has(p.recordId))) {
              matches = false;
              break;
            }
          }
        }
        if (matches) {
          orderedTxids.push(t.txid);
          if (orderedTxids.length >= neededCount) {
            return {
              orderedTxids,
              exhausted: false,
              cursor: cursorBlockTime === null
                ? null
                : { cursorBlockTime, seenAtCursorIds: Array.from(seenAtCursor) },
            };
          }
        }
      }
    }

    if (exhaustedTable) return { orderedTxids, exhausted: true, cursor: null };
    if (pause) await pause();
  }
}

// =============================================================================
// READ HELPERS — transactionParticipants
// =============================================================================

export async function countTransactionParticipants(): Promise<number> {
  return db.transactionParticipants.count();
}

export async function getAllTransactionParticipants(): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// participant table is never materialised at once.
export async function getTransactionParticipantsAfterId(
  afterId: number,
  limit: number
): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('id').above(afterId).limit(limit).toArray();
}

export async function getInputParticipants(): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('role').equals('input').toArray();
}

export async function getParticipantsByPrevOutKeys(
  keys: Array<[string, number]>
): Promise<TransactionParticipant[]> {
  if (keys.length === 0) return [];
  return db.transactionParticipants
    .where('[prevTxid+prevVout]')
    .anyOf(keys)
    .toArray();
}

export async function getParticipantsByRecordIds(
  recordIds: number[]
): Promise<TransactionParticipant[]> {
  if (recordIds.length === 0) return [];
  return db.transactionParticipants.where('recordId').anyOf(recordIds).toArray();
}

export async function getParticipantsByTxids(
  txids: string[]
): Promise<TransactionParticipant[]> {
  if (txids.length === 0) return [];
  return db.transactionParticipants.where('txid').anyOf(txids).toArray();
}

/**
 * Count transactionParticipants that have no address (blank, null, or
 * undefined). These rows are created by blockchain sync when it encounters
 * inputs that resolve to an OP_RETURN output or other non-standard scripts.
 * On vaults that ran deep multi-hop sync this count can be very large; it is
 * surfaced in the Data Stats audit so users can see the true nature of the
 * millions of rows rather than assuming data loss.
 */
export async function countAddresslessParticipants(): Promise<number> {
  return db.transactionParticipants
    .filter(p => !p.address || p.address.trim() === '')
    .count();
}

/**
 * Count input participant rows that are unresolved: they have a blank/empty
 * address but DO have prevTxid and prevVout populated. These represent spends
 * whose source address is not yet known. Until they are resolved the spending
 * amount is never subtracted from any address's balance, causing overstated
 * balances. Running prevout resolution can attribute them to the correct address.
 */
export async function countUnresolvedPrevoutInputs(): Promise<number> {
  return db.transactionParticipants
    .where('role').equals('input')
    .filter(p => (!p.address || p.address.trim() === '') && p.prevTxid !== undefined && p.prevVout !== undefined)
    .count();
}

/**
 * Attribute unresolved spend inputs (blank-address inputs with prevTxid/prevVout)
 * to the source address record they will deduct from once resolved. Each such
 * input's prevout (prevTxid:prevVout) points at a previous OUTPUT; when that
 * output belongs to one of our tracked addresses, the spend will eventually be
 * subtracted from that address's balance — so until it is resolved that wallet's
 * balance is overstated. We resolve prevouts against LOCAL output participants
 * only (never the network, KYUTXO stays offline) and return a map of
 * recordId -> number of unresolved spends pending attribution to that record.
 * Inputs whose prevout output is not locally known (or maps to no tracked
 * record) are simply omitted from the per-record map — they cannot be tied to a
 * specific wallet — but they ARE tallied separately as `unattributable` so the
 * UI can surface pending work that no single wallet card reflects.
 */
export interface UnresolvedSpendBreakdown {
  /** recordId -> number of unresolved spends pending attribution to that record. */
  byRecordId: Map<number, number>;
  /**
   * Unresolved spends whose prevout output is not locally known, or maps to no
   * tracked record. These overstate the overall balance picture but cannot be
   * attributed to any single wallet group.
   */
  unattributable: number;
}

export async function getUnresolvedSpendBreakdown(): Promise<UnresolvedSpendBreakdown> {
  const result = new Map<number, number>();

  const unresolvedInputs = await db.transactionParticipants
    .where('role').equals('input')
    .filter(p => (!p.address || p.address.trim() === '') && p.prevTxid !== undefined && p.prevVout !== undefined)
    .toArray();
  if (unresolvedInputs.length === 0) return { byRecordId: result, unattributable: 0 };

  // Batch-load the local OUTPUT participants for every referenced prevTxid so we
  // can map each unresolved input's (prevTxid, prevVout) to its source output.
  const prevTxids = new Set<string>();
  for (const inp of unresolvedInputs) {
    if (inp.prevTxid) prevTxids.add(inp.prevTxid);
  }
  const prevTxidArr = Array.from(prevTxids);
  const outputCache = new Map<string, { recordId?: number; address: string }>();
  for (let i = 0; i < prevTxidArr.length; i += 500) {
    const batch = prevTxidArr.slice(i, i + 500);
    const outputs = await db.transactionParticipants
      .where('txid').anyOf(batch)
      .and(p => p.role === 'output')
      .toArray();
    for (const o of outputs) {
      if (o.vout !== undefined) {
        outputCache.set(`${o.txid}:${o.vout}`, { recordId: o.recordId, address: o.address });
      }
    }
  }

  // Some source outputs carry an address but no recordId (e.g. created before the
  // address was tracked); resolve those addresses to a record via inputString.
  const addrsNeedingLookup = new Set<string>();
  for (const inp of unresolvedInputs) {
    const out = outputCache.get(`${inp.prevTxid}:${inp.prevVout}`);
    if (out && out.recordId === undefined && out.address) addrsNeedingLookup.add(out.address);
  }
  const addrToRecordId = new Map<string, number>();
  const addrArr = Array.from(addrsNeedingLookup);
  for (let i = 0; i < addrArr.length; i += 500) {
    const batch = addrArr.slice(i, i + 500);
    const records = await db.records.where('inputString').anyOf(batch).toArray();
    for (const r of records) {
      if (r.id != null && r.inputString) addrToRecordId.set(r.inputString, r.id);
    }
  }

  let unattributable = 0;
  for (const inp of unresolvedInputs) {
    const out = outputCache.get(`${inp.prevTxid}:${inp.prevVout}`);
    if (!out) {
      unattributable++;
      continue;
    }
    const recordId = out.recordId ?? (out.address ? addrToRecordId.get(out.address) : undefined);
    if (recordId === undefined) {
      unattributable++;
      continue;
    }
    result.set(recordId, (result.get(recordId) ?? 0) + 1);
  }

  return { byRecordId: result, unattributable };
}

/**
 * Backward-compatible accessor returning only the per-record attribution map.
 * Prefer {@link getUnresolvedSpendBreakdown} when the unattributable count is
 * also needed.
 */
export async function getUnresolvedSpendsByRecordId(): Promise<Map<number, number>> {
  const { byRecordId } = await getUnresolvedSpendBreakdown();
  return byRecordId;
}

/**
 * Distinct source transaction ids (prevTxids) behind unattributable spends whose
 * prevout OUTPUT is not stored locally. These are exactly the transactions that,
 * once fetched and imported, make the spend's source address known — turning an
 * unattributable spend into an attributable one so balances can self-correct.
 *
 * Spends whose source output IS locally known but maps to no tracked record are
 * deliberately excluded: importing more history cannot help them (the source
 * address simply isn't one we track), so there is nothing to fetch.
 */
export async function getMissingSourceTxids(): Promise<string[]> {
  const unresolvedInputs = await db.transactionParticipants
    .where('role').equals('input')
    .filter(p => (!p.address || p.address.trim() === '') && p.prevTxid !== undefined && p.prevVout !== undefined)
    .toArray();
  if (unresolvedInputs.length === 0) return [];

  // Batch-load the local OUTPUT participants for every referenced prevTxid so we
  // can tell which prevouts are already stored locally and which are missing.
  const prevTxids = new Set<string>();
  for (const inp of unresolvedInputs) {
    if (inp.prevTxid) prevTxids.add(inp.prevTxid);
  }
  const prevTxidArr = Array.from(prevTxids);
  const localOutputKeys = new Set<string>();
  for (let i = 0; i < prevTxidArr.length; i += 500) {
    const batch = prevTxidArr.slice(i, i + 500);
    const outputs = await db.transactionParticipants
      .where('txid').anyOf(batch)
      .and(p => p.role === 'output')
      .toArray();
    for (const o of outputs) {
      if (o.vout !== undefined) localOutputKeys.add(`${o.txid}:${o.vout}`);
    }
  }

  const missing = new Set<string>();
  for (const inp of unresolvedInputs) {
    const key = `${inp.prevTxid}:${inp.prevVout}`;
    if (inp.prevTxid && !localOutputKeys.has(key)) missing.add(inp.prevTxid);
  }
  return Array.from(missing);
}

/**
 * A single missing source transaction together with the spending transactions in
 * the vault that reference it. This is the offline-user equivalent of
 * {@link getMissingSourceTxids}: rather than fetching the missing history from a
 * provider, the user is given the exact list of source txids to import manually
 * (e.g. from a wallet export), along with the spending txids that depend on each
 * one so they can locate the right transactions.
 */
export interface MissingSourceDetail {
  /** The source transaction id whose output is not stored locally. */
  sourceTxid: string;
  /** Distinct spending transaction ids that reference this source output. */
  spendingTxids: string[];
}

/**
 * Like {@link getMissingSourceTxids} but also returns, for each missing source
 * transaction, the spending txids in the vault that reference it. Useful for the
 * offline path where the user imports the missing history manually and needs a
 * concrete, copyable list of which transactions to find. Results are sorted by
 * source txid for stable display.
 */
export async function getMissingSourceTxidDetails(): Promise<MissingSourceDetail[]> {
  const unresolvedInputs = await db.transactionParticipants
    .where('role').equals('input')
    .filter(p => (!p.address || p.address.trim() === '') && p.prevTxid !== undefined && p.prevVout !== undefined)
    .toArray();
  if (unresolvedInputs.length === 0) return [];

  const prevTxids = new Set<string>();
  for (const inp of unresolvedInputs) {
    if (inp.prevTxid) prevTxids.add(inp.prevTxid);
  }
  const prevTxidArr = Array.from(prevTxids);
  const localOutputKeys = new Set<string>();
  for (let i = 0; i < prevTxidArr.length; i += 500) {
    const batch = prevTxidArr.slice(i, i + 500);
    const outputs = await db.transactionParticipants
      .where('txid').anyOf(batch)
      .and(p => p.role === 'output')
      .toArray();
    for (const o of outputs) {
      if (o.vout !== undefined) localOutputKeys.add(`${o.txid}:${o.vout}`);
    }
  }

  const spendingBySource = new Map<string, Set<string>>();
  for (const inp of unresolvedInputs) {
    if (!inp.prevTxid) continue;
    const key = `${inp.prevTxid}:${inp.prevVout}`;
    if (localOutputKeys.has(key)) continue;
    let set = spendingBySource.get(inp.prevTxid);
    if (!set) {
      set = new Set<string>();
      spendingBySource.set(inp.prevTxid, set);
    }
    if (inp.txid) set.add(inp.txid);
  }

  return Array.from(spendingBySource.entries())
    .map(([sourceTxid, spending]) => ({
      sourceTxid,
      spendingTxids: Array.from(spending).sort(),
    }))
    .sort((a, b) => (a.sourceTxid < b.sourceTxid ? -1 : a.sourceTxid > b.sourceTxid ? 1 : 0));
}

/**
 * Serialise missing source details to a pretty-printed JSON string. Pure (no DOM,
 * no DB) so it can be unit-tested and reused by the offline download action in the
 * Balance page. Shape: `{ sourceTxid, spendingTxids }[]`, identical to the
 * in-memory detail list.
 */
export function buildMissingSourceJson(details: MissingSourceDetail[]): string {
  return JSON.stringify(
    details.map((d) => ({ sourceTxid: d.sourceTxid, spendingTxids: d.spendingTxids })),
    null,
    2,
  );
}

/** Quote a CSV field if it contains a comma, quote, or newline (RFC 4180). */
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialise missing source details to a CSV string with a header row. One row per
 * source transaction: the source txid plus its referencing spend txids joined by
 * a space inside a single quoted cell, so the file opens cleanly in a spreadsheet.
 * Pure (no DOM, no DB) for testability and offline reuse.
 */
export function buildMissingSourceCsv(details: MissingSourceDetail[]): string {
  const lines = ["source_txid,referencing_spend_txids"];
  for (const d of details) {
    lines.push(`${csvEscape(d.sourceTxid)},${csvEscape(d.spendingTxids.join(" "))}`);
  }
  return lines.join("\r\n");
}

// =============================================================================
// FRESHNESS FINGERPRINTS — compared against the native engine mirror before a
// read is served from the engine. All reads below are index-only (count + the
// last row of an ordered index), never full table scans, so the gate stays cheap
// even on multi-million-row vaults.
// =============================================================================

/**
 * Freshness fingerprint for the live `blockchainTransactions` table — total
 * count, max id, and max blockTime. Owned-UTXO reads JOIN this table and exclude
 * blockTime <= 0, so a mismatch in any field means the mirror cannot be trusted:
 * count/maxId catch inserts and deletes; maxBlockTime catches an unconfirmed tx
 * confirming in place (its new block time becomes the max).
 */
export async function getTransactionsFingerprint(): Promise<{
  count: number;
  maxId: number;
  maxBlockTime: number;
}> {
  const [count, newestById, newestByBlockTime] = await Promise.all([
    db.blockchainTransactions.count(),
    db.blockchainTransactions.orderBy('id').last(),
    db.blockchainTransactions.orderBy('blockTime').last(),
  ]);
  return {
    count,
    maxId: newestById?.id ?? 0,
    maxBlockTime: newestByBlockTime?.blockTime ?? 0,
  };
}

/**
 * Freshness fingerprint for the live `transactionParticipants` table — total
 * count, max id, and the count of inputs with a resolved prevout. The owned-UTXO
 * anti-join detects spends via (prevTxid, prevVout), which prevout backfill fills
 * IN PLACE — so count/maxId alone miss it. The `[prevTxid+prevVout]` compound
 * index only contains rows where both keys are defined, so counting it yields the
 * resolved-input count, matching the engine's `prevTxid IS NOT NULL AND prevVout
 * IS NOT NULL` count, and moves whenever backfill resolves more inputs.
 */
export async function getParticipantsFingerprint(): Promise<{
  count: number;
  maxId: number;
  resolvedPrevoutCount: number;
}> {
  const [count, newestById, resolvedPrevoutCount] = await Promise.all([
    db.transactionParticipants.count(),
    db.transactionParticipants.orderBy('id').last(),
    db.transactionParticipants.orderBy('[prevTxid+prevVout]').count(),
  ]);
  return {
    count,
    maxId: newestById?.id ?? 0,
    resolvedPrevoutCount,
  };
}
