import { db, type AddressOwnership, type BlockchainTransaction, type Owner, type OwnerResidency, type Record as VaultRecord, type RecordEntity, type TransactionLegMetadata, type TransactionMetadata, type TransactionParticipant } from "./database";
import { getAllRecords } from "./data/record-crud";
import { getAllTransactionParticipants, getAllTransactions } from "./data/transaction-crud";
import {
  getAllRecordEntities,
  getAllAddressOwnership,
  getAllTransactionLegMetadata,
  getAllTransactionMetadata,
} from "./data/record-model-crud";
import { getOwnerPolicySnapshot } from "./data/owner-policy";
import { isUserCuratedImportance } from './db-types';
import {
  calculateCoinOrigins,
  filterCoinOrigins,
  filterCoinOriginsByOwner,
  pageCoinOriginsLedger,
  type CoinOriginsInput,
  type CoinOriginsLedger,
  type CoinOriginsPage,
  type CoinOriginsPageOptions,
} from "./coin-origins-core";
import {
  calculateOwnerCostBasis,
  pageOwnerCostBasis,
  UNASSIGNED_COST_BASIS_OWNER,
  type OwnerCostBatch,
  type OwnerCostBasisReport,
  type OwnerCostBasisPage,
  type OwnerCostBasisEditorRow,
} from './owner-cost-basis-core';

export * from "./coin-origins-core";
export * from './owner-cost-basis-core';

function snapshotInput(
  records: VaultRecord[],
  transactions: BlockchainTransaction[],
  participants: TransactionParticipant[],
  metadata: TransactionMetadata[] = [],
): CoinOriginsInput {
  const metadataByTxid = new Map(metadata.map((row) => [row.txid, row]));
  return {
    transactions: transactions.map((tx) => {
      const meta = metadataByTxid.get(tx.txid);
      return {
        txid: tx.txid,
        blockHeight: tx.blockHeight,
        blockTime: tx.blockTime,
        fee: tx.fee,
        acquisitionMethod: meta?.acquisitionMethod,
        costBasisUsd: meta?.costBasisUsd,
        estimatedCostBasisUsd: meta?.estimatedCostBasisUsd,
      };
    }),
    participants: participants.map((p) => ({
      id: p.id,
      txid: p.txid,
      role: p.role,
      address: p.address,
      amount: p.amount,
      vout: p.vout,
      prevTxid: p.prevTxid,
      prevVout: p.prevVout,
    })),
    addresses: records
      .filter((record) => record.type === "address" && !!record.inputString)
      .map((record) => ({
        inputString: record.inputString,
        type: record.type,
        addressImportance: record.addressImportance,
        walletName: record.walletName,
        owner: record.owner,
        seedName: record.seedName,
        label: record.label,
      })),
  };
}

export async function loadCoinOrigins(walletName?: string, owners?: string[]): Promise<CoinOriginsLedger> {
  const [records, transactions, participants, metadata] = await Promise.all([
    getAllRecords(),
    getAllTransactions(),
    getAllTransactionParticipants(),
    getAllTransactionMetadata(),
  ]);
  const ledger = calculateCoinOrigins(snapshotInput(records, transactions, participants, metadata));
  return filterCoinOriginsByOwner(filterCoinOrigins(ledger, { walletName }), owners);
}

export async function loadCoinOriginsPage(
  opts: Omit<CoinOriginsPageOptions, "owner"> & {
    owners?: string[];
    expectedCheckpointKey?: string;
  } = {},
): Promise<{ ledger: CoinOriginsLedger; page: CoinOriginsPage }> {
  const ledger = await loadCoinOrigins(opts.walletName, opts.owners);
  // The fallback checkpoint fingerprints the actual immutable calculation, not
  // merely row counts, so a metadata edit cannot masquerade as the same page.
  const checkpointKey = `fallback:v1:${stableFingerprint(ledger)}`;
  if (opts.expectedCheckpointKey && opts.expectedCheckpointKey !== checkpointKey) {
    throw new Error("Coin Origins checkpoint changed; reload the active window");
  }
  return { ledger, page: pageCoinOriginsLedger(ledger, checkpointKey, opts) };
}

export function calculateCoinOriginsFromRows(
  records: VaultRecord[],
  transactions: BlockchainTransaction[],
  participants: TransactionParticipant[],
  walletName?: string,
  metadata: TransactionMetadata[] = [],
  owners?: string[],
): CoinOriginsLedger {
  const ledger = calculateCoinOrigins(snapshotInput(records, transactions, participants, metadata));
  return filterCoinOriginsByOwner(filterCoinOrigins(ledger, { walletName }), owners);
}

/**
 * Load the owner tax book from the live normalized policy and leg tables.  It is
 * intentionally a sibling of Coin Origins, not an input to that physical recipe.
 * The native mirror does not include private policy rows, so callers should use
 * this shared calculator after the normal freshness gate selects the source rows.
 */
export async function loadOwnerCostBasis(selectedOwner?: string): Promise<OwnerCostBasisReport> {
  return calculateOwnerCostBasisRows(await readOwnerCostBasisRows(), selectedOwner);
}

export interface OwnerCostBasisSnapshot {
  page: OwnerCostBasisPage;
  checkpointKey: string;
}

/** Normal UI read: an atomic snapshot and bounded renderer DTO. */
export async function loadOwnerCostBasisPage(selectedOwner?: string, limit = 100): Promise<OwnerCostBasisPage> {
  return (await loadOwnerCostBasisSnapshot(selectedOwner, limit)).page;
}

async function readOwnerCostBasisRows(): Promise<OwnerCostBasisRows> {
  return db.transaction('r', [db.records, db.blockchainTransactions, db.transactionParticipants,
    db.transactionMetadata, db.transactionLegMetadata, db.entities, db.addressOwnership, db.recordModelMigrationState, db.owners, db.ownerResidencies],
    async (): Promise<OwnerCostBasisRows> => {
      const [records, transactions, participants, metadata, legMetadata, entities, ownership, migration, policy] = await Promise.all([
        getAllRecords(), getAllTransactions(), getAllTransactionParticipants(),
        getAllTransactionMetadata(), getAllTransactionLegMetadata(), getAllRecordEntities(), getAllAddressOwnership(),
        db.recordModelMigrationState.get('v44'),
        getOwnerPolicySnapshot(),
      ]);
      return {
        records, transactions, participants, metadata, legMetadata, entities,
        owners: policy.owners, residencies: policy.residencies, ownership,
        migrationComplete: migration?.phase === 'complete',
      };
    }) as Promise<OwnerCostBasisRows>;
}

const DECLARATION_OWNER_BATCHES_GLOBAL = 1_000;

export async function loadOwnerCostBasisForAddresses(addresses: readonly string[]): Promise<OwnerCostBasisDeclarationProjection> {
  const wanted = new Set(addresses.filter(Boolean));
  if (!wanted.size) return { checkpointKey: '', declaredAddresses: [], batches: [], perAddressLimit: DECLARATION_OWNER_BATCHES_PER_ADDRESS, globalLimit: DECLARATION_OWNER_BATCHES_GLOBAL };
  const rows = await readOwnerCostBasisRows();
  const report = calculateOwnerCostBasisRows(rows);
  const { participants } = rows;
  const addressByOutpoint = new Map<string, string>();
  for (const participant of participants) {
    if (
      participant.role === 'output' &&
      participant.vout !== undefined &&
      participant.vout !== null &&
      participant.address &&
      wanted.has(participant.address)
    ) {
      addressByOutpoint.set(`${participant.txid}:${participant.vout}`, participant.address);
    }
  }
  const batches = report.batches.flatMap(batch => {
    if (batch.remainingSats <= 0) return [];
    const address = addressByOutpoint.get(`${batch.acquiredTxid}:${batch.lotId.split(':').at(-1)}`);
    return address ? [{ address, batch }] : [];
  }).sort((a, b) => a.address.localeCompare(b.address) || a.batch.lotId.localeCompare(b.batch.lotId));
  for (const address of wanted) {
    const count = batches.filter(row => row.address === address).length;
    if (count > DECLARATION_OWNER_BATCHES_PER_ADDRESS) {
      throw new Error(`Declaration owner-book projection exceeds the ${DECLARATION_OWNER_BATCHES_PER_ADDRESS}-batch limit for ${address}; narrow or reconcile the declaration before generating it.`);
    }
  }
  if (batches.length > DECLARATION_OWNER_BATCHES_GLOBAL) {
    throw new Error(`Declaration owner-book projection exceeds the ${DECLARATION_OWNER_BATCHES_GLOBAL}-batch global limit; narrow or reconcile the declaration before generating it.`);
  }
  return {
    checkpointKey: ownerCheckpoint(rows),
    declaredAddresses: [...wanted].sort(),
    batches,
    perAddressLimit: DECLARATION_OWNER_BATCHES_PER_ADDRESS,
    globalLimit: DECLARATION_OWNER_BATCHES_GLOBAL,
  };
}

/** Stable, content-sensitive fingerprint.  IDs and revision fields alone are not
 * sufficient: a legacy import may replace values while preserving both. */
function stableFingerprint(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    const row = item as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  };
  let hash = 2166136261;
  for (const char of canonical(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function calculateOwnerCostBasisRows(rows: OwnerCostBasisRows, selectedOwner?: string): OwnerCostBasisReport {
  const { records, transactions, participants, metadata, owners, residencies, legMetadata, entities, ownership } = rows;
  const metaByTxid = new Map(metadata.map(row => [row.txid, row]));
  const entityName = new Map(entities.filter(row => row.id !== undefined).map(row => [row.id!, row.name]));
  const ownershipByRecord = new Map(ownership.map(row => [row.recordId, row]));
  const legacyDefaultOwner = !rows.migrationComplete && ownership.length === 0 && owners.length === 1
    ? owners[0].name : undefined;
  const addresses = records.filter((row): row is VaultRecord & { id: number } =>
    row.type === 'address' && row.id !== undefined && !!row.inputString).flatMap(row => {
    const normalized = ownershipByRecord.get(row.id);
    if (normalized) {
      // A normalized ownership row is authoritative. External/undetermined
      // counterparties never enter an owner book; a controlled blank remains
      // explicitly Unassigned instead of inheriting a legacy default.
      if (normalized.state !== 'assigned' && normalized.state !== 'ours-owner-unknown') return [];
      return [{ address: row.inputString, owner: normalized.state === 'assigned'
        ? entityName.get(normalized.entityId ?? -1) ?? '' : '' }];
    }
    // Match Coin Origins' curated universe, while rejecting known sync shells
    // even if an older import omitted its discovery tier.
    if (!isUserCuratedImportance(row.addressImportance) || row.syncDepth && row.syncDepth > 0 ||
      row.discoveredInTxid || row.source === 'blockchain-sync') return [];
    return [{ address: row.inputString, owner: row.owner }];
  });
  return calculateOwnerCostBasis({
    owners, residencies,
    addresses,
    transactions: transactions.map(tx => {
      const meta = metaByTxid.get(tx.txid);
      return { txid: tx.txid, date: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString().slice(0, 10) : undefined,
        feeSats: tx.fee, costBasisUsd: meta?.costBasisUsd, estimatedCostBasisUsd: meta?.estimatedCostBasisUsd,
        proceedsUsd: meta?.proceedsUsd, estimatedProceedsUsd: meta?.estimatedProceedsUsd };
    }),
    participants: participants.map(row => ({ id: row.id, txid: row.txid, role: row.role, address: row.address, amount: row.amount, vout: row.vout, prevTxid: row.prevTxid, prevVout: row.prevVout })),
    legs: legMetadata.map(row => ({
      txid: row.txid, legKey: row.legKey, direction: row.direction,
      owner: row.entityId === undefined ? undefined : entityName.get(row.entityId),
      costBasisUsd: row.costBasisUsd, estimatedCostBasisUsd: row.estimatedCostBasisUsd,
      proceedsUsd: row.proceedsUsd, estimatedProceedsUsd: row.estimatedProceedsUsd,
      transferBasisRule: row.transferBasisRule, marketValueUsd: row.marketValueUsd,
      estimatedMarketValueUsd: row.estimatedMarketValueUsd, specificLotIds: row.specificLotIds,
    })),
    legacyDefaultOwner,
  }, selectedOwner);
}

/** One immutable, atomic source snapshot shared by owner report/detail/editor. */
export async function loadOwnerCostBasisSnapshot(selectedOwner?: string, limit = 100): Promise<OwnerCostBasisSnapshot> {
  const rows = await readOwnerCostBasisRows();
  const report = calculateOwnerCostBasisRows(rows, selectedOwner);
  const checkpointKey = ownerCheckpoint(rows, selectedOwner);
  return { checkpointKey, page: pageOwnerCostBasis(report, checkpointKey, limit, editorRowsFor(report)) };
}

/** Bounded, checkpoint-bearing projection safe to incorporate into a declaration. */
export interface OwnerCostBasisDeclarationProjection {
  checkpointKey: string;
  declaredAddresses: string[];
  batches: OwnerCostBasisAddressBatch[];
  perAddressLimit: number;
  globalLimit: number;
}

const DECLARATION_OWNER_BATCHES_PER_ADDRESS = 250;

/** Reject actions based on a report whose atomic source snapshot has changed. */
export async function assertOwnerCostBasisCheckpoint(expectedCheckpointKey: string, selectedOwner?: string): Promise<void> {
  const current = await loadOwnerCostBasisSnapshot(selectedOwner, 1);
  if (current.checkpointKey !== expectedCheckpointKey) {
    throw new Error('Cost-basis data changed. Reload the report before saving or exporting.');
  }
}

function ownerCheckpoint(rows: OwnerCostBasisRows, selectedOwner?: string): string {
  const source = {
    selectedOwner: selectedOwner ?? null,
    records: rows.records,
    blockchainTransactions: rows.transactions,
    transactionParticipants: rows.participants,
    transactionMetadata: rows.metadata,
    // Policy and leg rows deliberately include their updatedAt revisions.
    transactionLegMetadata: rows.legMetadata,
    entities: rows.entities,
    addressOwnership: rows.ownership,
    migrationComplete: rows.migrationComplete,
    owners: rows.owners,
    ownerResidencies: rows.residencies,
  };
  return `owner-book:v1:${stableFingerprint(source)}`;
}

type OwnerCostBasisRows = {
  records: VaultRecord[];
  transactions: BlockchainTransaction[];
  participants: TransactionParticipant[];
  metadata: TransactionMetadata[];
  owners: Owner[];
  residencies: OwnerResidency[];
  legMetadata: TransactionLegMetadata[];
  entities: RecordEntity[];
  ownership: AddressOwnership[];
  migrationComplete: boolean;
};

export function editorRowsFor(report: OwnerCostBasisReport): OwnerCostBasisEditorRow[] {
  const rows: OwnerCostBasisEditorRow[] = [];
  for (const disposal of report.disposals) {
    if (disposal.kind === 'fee') continue;
    // The report has already identified the exact leg(s) used by this disposal.
    // Never infer them by iterating all transaction participants: that turns one
    // disposal into a misleading Cartesian product and can save to another leg.
    const legKey = disposal.kind === 'external' ? disposal.sourceLegKey : disposal.recipientLegKey;
    if (!legKey) continue;
    rows.push({ txid: disposal.txid,
      owner: disposal.kind === 'owner-transfer' ? disposal.recipientOwner ?? UNASSIGNED_COST_BASIS_OWNER : disposal.owner,
      sourceOwner: disposal.kind === 'owner-transfer' ? disposal.owner : undefined,
      kind: disposal.kind, sats: disposal.sats,
      legKey, direction: disposal.kind === 'external' ? 'outgoing' : 'owner-transfer',
      sourceLegKey: disposal.sourceLegKey, recipientLegKey: disposal.recipientLegKey });
  }
  return [...new Map(rows.map(row => [`${row.txid}|${row.legKey}`, row])).values()];
}

/** Re-read immediately before a declaration uses its owner-book projection. */
export async function assertOwnerCostBasisDeclarationProjection(projection: OwnerCostBasisDeclarationProjection): Promise<void> {
  if (!projection.checkpointKey) return;
  await assertOwnerCostBasisCheckpoint(projection.checkpointKey);
}

/** The small, declaration-safe portion of the owner book for selected addresses.
 * The complete tax book is intentionally not passed to a document renderer. */
export interface OwnerCostBasisAddressBatch {
  address: string;
  batch: OwnerCostBatch;
}
