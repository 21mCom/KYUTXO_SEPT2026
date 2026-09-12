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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

const provenance = new Set(['provided', 'estimated', 'unknown']);
const matchingMethods = new Set(['fifo', 'lifo', 'hifo', 'specific-identification']);
const transferRules = new Set(['carry-over', 'market-value-step-up']);
function isMember(values: Set<string>, value: unknown): value is string {
  return typeof value === 'string' && values.has(value);
}

/**
 * Parse a persisted derived report without trusting its shape. The protected
 * worker treats any incompatible or corrupt payload as a cache miss and
 * rebuilds it from source rows.
 */
export function parseOwnerCostBasisReport(value: string): OwnerCostBasisReport | null {
  let report: unknown;
  try {
    report = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(report) || report.version !== 1 || typeof report.policyRevision !== 'string' ||
      !Array.isArray(report.batches) || !Array.isArray(report.disposals) ||
      !Array.isArray(report.warnings) || !Array.isArray(report.assumptions) ||
      !Array.isArray(report.byOwner)) return null;
  const validBatch = (row: unknown) => isRecord(row) &&
    typeof row.lotId === 'string' && typeof row.owner === 'string' &&
    typeof row.acquiredTxid === 'string' && isOptionalString(row.acquiredAt) &&
    isFiniteNumber(row.sats) && isFiniteNumber(row.remainingSats) &&
    isOptionalFiniteNumber(row.costUsd) && isMember(provenance, row.costProvenance);
  const validAllocation = (row: unknown) => isRecord(row) &&
    typeof row.lotId === 'string' && isFiniteNumber(row.sats) &&
    isOptionalFiniteNumber(row.costUsd) && isMember(provenance, row.costProvenance);
  const validDisposal = (row: unknown) => isRecord(row) &&
    typeof row.txid === 'string' && isOptionalString(row.date) && typeof row.owner === 'string' &&
    isMember(new Set(['external', 'fee', 'owner-transfer']), row.kind) &&
    isFiniteNumber(row.sats) && Array.isArray(row.allocations) && row.allocations.every(validAllocation) &&
    isOptionalFiniteNumber(row.costUsd) && isMember(provenance, row.costProvenance) &&
    isOptionalFiniteNumber(row.proceedsUsd) && isMember(provenance, row.proceedsProvenance) &&
    isMember(matchingMethods, row.matchingMethod) &&
    (row.transferBasisRule === undefined || isMember(transferRules, row.transferBasisRule)) &&
    isOptionalString(row.sourceLegKey) && isOptionalString(row.recipientLegKey) &&
    isOptionalString(row.recipientOwner);
  const validWarning = (row: unknown) => isRecord(row) &&
    isMember(new Set(['residency-gap', 'missing-disposal-date', 'unknown-owner-policy',
      'specific-identification-unavailable']), row.code) &&
    typeof row.owner === 'string' && isOptionalString(row.date) && typeof row.message === 'string';
  const validAssumption = (row: unknown) => isRecord(row) && typeof row.owner === 'string' &&
    isOptionalString(row.date) && isMember(matchingMethods, row.matchingMethod) &&
    typeof row.fallback === 'boolean' && (row.residency === undefined ||
      (isRecord(row.residency) && typeof row.residency.jurisdiction === 'string' &&
        isOptionalString(row.residency.region) && typeof row.residency.startDate === 'string' &&
        isOptionalString(row.residency.endDate)));
  const validSummary = (row: unknown) => isRecord(row) && typeof row.owner === 'string' &&
    isFiniteNumber(row.disposedSats) && isFiniteNumber(row.feeSats) &&
    isOptionalFiniteNumber(row.proceedsUsd) && isOptionalFiniteNumber(row.costUsd) &&
    isOptionalFiniteNumber(row.gainUsd) && isFiniteNumber(row.openSats) &&
    isFiniteNumber(row.unknownCostSats);
  if (!report.batches.every(validBatch) || !report.disposals.every(validDisposal) ||
      !report.warnings.every(validWarning) || !report.assumptions.every(validAssumption) ||
      !report.byOwner.every(validSummary) || !isOptionalString(report.selectedOwner)) return null;
  return report as unknown as OwnerCostBasisReport;
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
