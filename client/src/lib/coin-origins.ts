import { db, type BlockchainTransaction, type Record as VaultRecord, type TransactionMetadata, type TransactionParticipant } from "./database";
import { getAllRecords } from "./data/record-crud";
import { getAllTransactionParticipants, getAllTransactions } from "./data/transaction-crud";
import {
  getAllRecordEntities,
  getAllAddressOwnership,
  getAllTransactionLegMetadata,
  getAllTransactionMetadata,
} from "./data/record-model-crud";
import { getOwnerPolicySnapshot } from "./data/owner-policy";
import { getVaultRepository } from './repository';
import { calculateOwnerCostBasisFromStoredRows, type OwnerCostBasisStoredRows } from './owner-cost-basis-storage';
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
  ownerCostBasisEditorRows,
  pageOwnerCostBasis,
  selectOwnerCostBasisReport,
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
 * Protected vaults intentionally expose only bounded worker-owned projections;
 * browser fallback may still request the complete report for non-renderer work.
 */
export async function loadOwnerCostBasis(selectedOwner?: string): Promise<OwnerCostBasisReport> {
  if (getVaultRepository().kind === 'protected') {
    throw new Error('The protected vault exposes only bounded owner cost-basis projections');
  }
  return selectOwnerCostBasisReport(calculateOwnerCostBasisFromStoredRows(await readOwnerCostBasisRows()), selectedOwner);
}

export interface OwnerCostBasisSnapshot {
  page: OwnerCostBasisPage;
  checkpointKey: string;
}

/** Normal UI read: an atomic snapshot and bounded renderer DTO. */
export async function loadOwnerCostBasisPage(selectedOwner?: string, limit = 100): Promise<OwnerCostBasisPage> {
  return (await loadOwnerCostBasisSnapshot(selectedOwner, limit)).page;
}

async function readOwnerCostBasisRows(): Promise<OwnerCostBasisStoredRows> {
  return db.transaction('r', [db.records, db.blockchainTransactions, db.transactionParticipants,
    db.transactionMetadata, db.transactionLegMetadata, db.entities, db.addressOwnership, db.recordModelMigrationState, db.owners, db.ownerResidencies],
    async (): Promise<OwnerCostBasisStoredRows> => {
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
    }) as Promise<OwnerCostBasisStoredRows>;
}

const DECLARATION_OWNER_BATCHES_GLOBAL = 1_000;

export async function loadOwnerCostBasisForAddresses(addresses: readonly string[]): Promise<OwnerCostBasisDeclarationProjection> {
  const wanted = new Set(addresses.filter(Boolean));
  if (!wanted.size) return { checkpointKey: '', declaredAddresses: [], batches: [], perAddressLimit: DECLARATION_OWNER_BATCHES_PER_ADDRESS, globalLimit: DECLARATION_OWNER_BATCHES_GLOBAL };
  return getVaultRepository().ownerCostBasisProjection([...wanted]);
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

/** One immutable, atomic source snapshot shared by owner report/detail/editor. */
export async function loadOwnerCostBasisSnapshot(selectedOwner?: string, limit = 100): Promise<OwnerCostBasisSnapshot> {
  const page = await getVaultRepository().ownerCostBasisPage({ selectedOwner, limit });
  return { checkpointKey: page.checkpointKey, page };
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
  await getVaultRepository().ownerCostBasisPage({ selectedOwner, limit: 1, expectedCheckpointKey });
}

export function editorRowsFor(report: OwnerCostBasisReport): OwnerCostBasisEditorRow[] {
  return ownerCostBasisEditorRows(report);
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
