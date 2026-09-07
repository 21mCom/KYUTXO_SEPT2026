import type {
  AddressOwnership, BlockchainTransaction, Owner, OwnerResidency, Record as VaultRecord,
  RecordEntity, TransactionLegMetadata, TransactionMetadata, TransactionParticipant,
} from './db-types';
import { isUserCuratedImportance } from './db-types';
import { calculateOwnerCostBasis, type OwnerCostBasisReport } from './owner-cost-basis-core';
export { ownerCostBasisEditorRows, pageOwnerCostBasis, selectOwnerCostBasisReport } from './owner-cost-basis-core';

export interface OwnerCostBasisStoredRows {
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
}

export function calculateOwnerCostBasisFromStoredRows(rows: OwnerCostBasisStoredRows): OwnerCostBasisReport {
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
      if (normalized.state !== 'assigned' && normalized.state !== 'ours-owner-unknown') return [];
      return [{ address: row.inputString, owner: normalized.state === 'assigned'
        ? entityName.get(normalized.entityId ?? -1) ?? '' : '' }];
    }
    if (!isUserCuratedImportance(row.addressImportance) || row.syncDepth && row.syncDepth > 0 ||
      row.discoveredInTxid || row.source === 'blockchain-sync') return [];
    return [{ address: row.inputString, owner: row.owner }];
  });
  return calculateOwnerCostBasis({
    owners, residencies, addresses,
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
  });
}
