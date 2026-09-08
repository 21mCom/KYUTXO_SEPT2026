import type {
  AddressOwnership, AddressOwnershipState, OwnershipReviewAction, OwnershipReviewDecision,
  OwnershipReviewDecisionState, Record, RecordEntity, TransactionParticipant,
} from './db-types';
import { getVaultRepository, type VaultRepository } from './repository';
import { notifyDbChange } from './database';

/** Deliberately small ceilings: review evidence must not turn a large vault scan into an unbounded graph walk. */
export const OWNERSHIP_REVIEW_LIMITS = { records: 2_000, participants: 8_000, suggestions: 500 } as const;
export type OwnershipEvidenceKind = 'propagation' | 'common-input-cluster' | 'address-reuse' | 'elimination';
export interface OwnershipSuggestion {
  fingerprint: string;
  kind: OwnershipEvidenceKind;
  recordId: number;
  recordIds: number[];
  entityId?: number;
  suggestedState: 'assigned' | 'not-ours';
  confidence: 'low' | 'medium';
  /** Locally observed sats associated with the proposed records/evidence. */
  valueSats: number;
  explanation: string;
  transactionIds: string[];
}
export interface OwnershipWalletCascade {
  walletId: number;
  recordIds: number[];
}

const fnv1a = (value: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const uniqueSorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const fingerprint = (kind: OwnershipEvidenceKind, target: string, entity: string, records: string[], txids: string[]) =>
  `ownership-v1:${fnv1a([kind, target, entity, [...new Set(records)].sort().join(','), [...new Set(txids)].sort().join(',')].join('|'))}`;
const unresolved = (row?: AddressOwnership) => !row || row.state === 'undetermined' || row.state === 'ours-owner-unknown';

/**
 * Deterministically derives suggestions from supplied local rows. It makes no
 * network call and intentionally returns evidence rather than writing ownership.
 * A caller can page/load inputs under the documented limits before invoking it.
 */
export function generateOwnershipSuggestions(input: {
  records: Record[]; ownership: AddressOwnership[]; participants: TransactionParticipant[]; entities?: RecordEntity[];
  limit?: number;
  offset?: number;
  participantLimit?: number;
}): OwnershipSuggestion[] {
  const ownership = new Map(input.ownership.map(row => [row.recordId, row]));
  const addresses = input.records.filter((row): row is Record & { id: number } => row.type === 'address' && Number.isSafeInteger(row.id));
  const byId = new Map(addresses.map(row => [row.id, row]));
  const entityById = new Map((input.entities ?? []).filter(entity => entity.id !== undefined).map(entity => [entity.id!, entity]));
  const participantAmounts = new Map<number, Map<string, number>>();
  for (const participant of input.participants.slice(0, input.participantLimit ?? OWNERSHIP_REVIEW_LIMITS.participants)) {
    if (participant.recordId === undefined) continue;
    const byTx = participantAmounts.get(participant.recordId) ?? new Map<string, number>();
    byTx.set(participant.txid, (byTx.get(participant.txid) ?? 0) + Math.max(0, participant.amount));
    participantAmounts.set(participant.recordId, byTx);
  }
  const recordKey = (id: number) => {
    const row = byId.get(id);
    return row?.inputStringLower || row?.inputString.trim() || `missing-record:${id}`;
  };
  const entityKey = (id: number | undefined) => {
    if (id === undefined) return "";
    const entity = entityById.get(id);
    return entity?.naturalKey || (entity ? `${entity.kind}:${entity.name.trim().toLocaleLowerCase()}` : `missing-entity:${id}`);
  };
  const results = new Map<string, OwnershipSuggestion>();
  const add = (kind: OwnershipEvidenceKind, recordId: number, entityId: number | undefined, suggestedState: 'assigned' | 'not-ours',
    recordIds: number[], txids: string[], explanation: string, confidence: 'low' | 'medium' = 'low') => {
    if (!unresolved(ownership.get(recordId))) return;
    if (suggestedState === 'assigned' && !entityId) return;
    const ids = uniqueSorted(recordIds.filter(id => byId.has(id)));
    const tx = [...new Set(txids)].sort();
    const evidenceEntityId = entityId ?? ownership.get(recordId)?.counterpartyEntityId;
    const key = fingerprint(kind, recordKey(recordId), entityKey(evidenceEntityId), ids.map(recordKey), tx);
    const cached = ids.reduce((total, id) => total + Math.max(0, byId.get(id)?.cachedBalanceSats ?? 0), 0);
    const observed = ids.reduce((total, id) => {
      const byTx = participantAmounts.get(id);
      if (!byTx) return total;
      return total + (tx.length === 0
        ? [...byTx.values()].reduce((sum, amount) => sum + amount, 0)
        : tx.reduce((sum, txid) => sum + (byTx.get(txid) ?? 0), 0));
    }, 0);
    results.set(key, { fingerprint: key, kind, recordId, recordIds: ids, entityId, suggestedState, confidence,
      valueSats: Math.max(cached, observed), explanation, transactionIds: tx });
  };

  // Transparent one-hop discovery propagation. Never follows a chain recursively.
  for (const row of addresses) {
    if (!unresolved(ownership.get(row.id)) || !row.discoveredFromRecordId) continue;
    const source = ownership.get(row.discoveredFromRecordId);
    if (source?.state === 'assigned' && source.entityId) {
      add('propagation', row.id, source.entityId, 'assigned', [row.id, source.recordId],
        row.discoveredInTxid ? [row.discoveredInTxid] : [], 'This address was discovered directly from an address assigned to this owner.');
    }
  }

  const inputsByTx = new Map<string, TransactionParticipant[]>();
  for (const participant of input.participants.slice(0, input.participantLimit ?? OWNERSHIP_REVIEW_LIMITS.participants)) {
    if (participant.role !== 'input' || !participant.txid || participant.recordId === undefined) continue;
    const group = inputsByTx.get(participant.txid) ?? []; group.push(participant); inputsByTx.set(participant.txid, group);
  }
  for (const [txid, participants] of inputsByTx) {
    const ids = uniqueSorted(participants.map(p => p.recordId!).filter(id => byId.has(id)));
    const owners = uniqueSorted(ids.map(id => ownership.get(id)).filter((row): row is AddressOwnership =>
      row?.state === 'assigned' && row.entityId !== undefined).map(row => row.entityId!));
    if (owners.length !== 1) continue; // commingled known owners are evidence of risk, never an ownership guess.
    for (const id of ids) add('common-input-cluster', id, owners[0], 'assigned', ids, [txid],
      'This input was co-spent with addresses assigned to one owner in this transaction.', 'medium');
  }

  const byAddress = new Map<string, number[]>();
  for (const row of addresses) {
    const address = row.inputString.trim().toLowerCase(); if (!address) continue;
    const ids = byAddress.get(address) ?? []; ids.push(row.id); byAddress.set(address, ids);
  }
  for (const ids of byAddress.values()) {
    const owners = uniqueSorted(ids.map(id => ownership.get(id)).filter((row): row is AddressOwnership =>
      row?.state === 'assigned' && row.entityId !== undefined).map(row => row.entityId!));
    if (owners.length !== 1) continue;
    for (const id of ids) add('address-reuse', id, owners[0], 'assigned', ids, [],
      'The same normalized address has another local record assigned to this owner.');
  }

  // Elimination is deliberately narrow: explicit counterparty linkage supports
  // a reviewable "not ours" proposal, never an automatic exclusion.
  for (const row of input.ownership) {
    if (!unresolved(row) || !row.counterpartyEntityId || !byId.has(row.recordId)) continue;
    add('elimination', row.recordId, undefined, 'not-ours', [row.recordId], [],
      'This address has an explicit counterparty linkage; confirm it is not yours.');
  }
  const offset = Math.max(0, input.offset ?? 0);
  return [...results.values()].sort((a, b) => b.valueSats - a.valueSats || a.fingerprint.localeCompare(b.fingerprint))
    .slice(offset, offset + (input.limit ?? OWNERSHIP_REVIEW_LIMITS.suggestions));
}

export function visibleOwnershipSuggestions(suggestions: OwnershipSuggestion[], decisions: OwnershipReviewDecision[]): OwnershipSuggestion[] {
  const resolved = new Set(decisions.filter(d => d.state === 'rejected' || d.state === 'accepted' || d.state === 'not-ours')
    .map(d => d.evidenceFingerprint));
  return suggestions.filter(s => !resolved.has(s.fingerprint));
}

export interface OwnershipDecisionInput {
  suggestion: OwnershipSuggestion;
  action: OwnershipReviewAction;
  entityId?: number;
  now?: number;
}

/** Persists an explicit review result. Only accepted assign/not-ours actions write AddressOwnership rows. */
export async function decideOwnership(input: OwnershipDecisionInput, repository: VaultRepository = getVaultRepository()): Promise<OwnershipReviewDecision> {
  const { suggestion } = input;
  const now = input.now ?? Date.now();
  const accepted = input.action === 'assign' || input.action === 'assign-manual' || input.action === 'assign-cluster' || input.action === 'assign-wallet' || input.action === 'not-ours';
  const entityId = input.entityId ?? suggestion.entityId;
  if ((input.action === 'assign' || input.action === 'assign-manual' || input.action === 'assign-cluster' || input.action === 'assign-wallet') && !Number.isSafeInteger(entityId)) throw new Error('An owner is required to assign ownership');
  const ids = input.action === 'assign-cluster' ? suggestion.recordIds : [suggestion.recordId];
  if (ids.length === 0 || ids.length > OWNERSHIP_REVIEW_LIMITS.suggestions) throw new Error('Invalid ownership review target');
  // AddressOwnership is keyed by auto id, so find rows through bounded paging.
  const ownershipRows = await listRows<AddressOwnership>(repository, 'addressOwnership', OWNERSHIP_REVIEW_LIMITS.records);
  const old = ids.map(id => ownershipRows.find(row => row.recordId === id)).filter((row): row is AddressOwnership => !!row);
  if (accepted) {
    const state: AddressOwnershipState = input.action === 'not-ours' ? 'not-ours' : 'assigned';
    const rows = ids.map(recordId => {
      const existing = ownershipRows.find(row => row.recordId === recordId);
      return { ...existing, id: existing?.id, recordId, state, entityId: state === 'assigned' ? entityId : undefined,
        createdAt: existing?.createdAt ?? now, updatedAt: now };
    });
    const decision: OwnershipReviewDecision = { id: suggestion.fingerprint, evidenceFingerprint: suggestion.fingerprint, state: input.action === 'not-ours' ? 'not-ours' : 'accepted', action: input.action,
      recordIds: ids, entityId: input.action === 'not-ours' ? undefined : entityId, previousOwnership: old,
      undoToken: `${suggestion.fingerprint}:${now}`, createdAt: now, updatedAt: now };
    const prior = await repository.get('ownershipReviewDecisions', decision.id);
    const saved = await repository.commitOwnershipReview({ decision: { ...decision, createdAt: prior?.createdAt ?? now }, ownershipRows: rows });
    notifyDbChange('addressOwnership'); notifyDbChange('ownershipReviewDecisions');
    return saved;
  }
  const state: OwnershipReviewDecisionState = input.action === 'reject' ? 'rejected' : input.action === 'undecided' ? 'undecided' :
    input.action === 'not-ours' ? 'not-ours' : 'accepted';
  const decision: OwnershipReviewDecision = { id: suggestion.fingerprint, evidenceFingerprint: suggestion.fingerprint, state, action: input.action,
    recordIds: ids, entityId: state === 'accepted' ? entityId : undefined, previousOwnership: accepted ? old : undefined,
    undoToken: accepted ? `${suggestion.fingerprint}:${now}` : undefined, createdAt: now, updatedAt: now };
  const prior = await repository.get('ownershipReviewDecisions', decision.id);
  const saved = await repository.commitOwnershipReview({ decision: { ...decision, createdAt: prior?.createdAt ?? now }, ownershipRows: [] });
  notifyDbChange('ownershipReviewDecisions');
  return saved;
}

/** Enumerates only explicit normalized-wallet ownership rows in the review scope. */
export async function getOwnershipWalletCascade(recordId: number, repository: VaultRepository = getVaultRepository()): Promise<OwnershipWalletCascade | undefined> {
  const rows = await listRows<AddressOwnership>(repository, 'addressOwnership', OWNERSHIP_REVIEW_LIMITS.records);
  const source = rows.find(row => row.recordId === recordId);
  if (!Number.isSafeInteger(source?.walletId)) return undefined;
  return {
    walletId: source!.walletId!,
    recordIds: rows.filter(row => row.walletId === source!.walletId && unresolved(row)).map(row => row.recordId),
  };
}

/** Commits a confirmed wallet cascade in the repository's atomic ownership command. */
export async function decideWalletOwnership(input: OwnershipDecisionInput & { recordIds: number[] }, repository: VaultRepository = getVaultRepository()): Promise<OwnershipReviewDecision> {
  const entityId = input.entityId ?? input.suggestion.entityId;
  const ids = uniqueSorted(input.recordIds);
  if (!Number.isSafeInteger(entityId)) throw new Error('An owner is required to assign ownership');
  if (!ids.length || ids.length > OWNERSHIP_REVIEW_LIMITS.records) throw new Error('Invalid wallet ownership review target');
  const now = input.now ?? Date.now();
  const ownershipRows = await listRows<AddressOwnership>(repository, 'addressOwnership', OWNERSHIP_REVIEW_LIMITS.records);
  const previousOwnership = ownershipRows.filter(row => ids.includes(row.recordId));
  const ownershipRowsToSave = ids.map(recordId => {
    const existing = ownershipRows.find(row => row.recordId === recordId);
    return { ...existing, id: existing?.id, recordId, state: 'assigned' as const, entityId,
      createdAt: existing?.createdAt ?? now, updatedAt: now };
  });
  const decision: OwnershipReviewDecision = {
    id: input.suggestion.fingerprint, evidenceFingerprint: input.suggestion.fingerprint, state: 'accepted',
    action: 'assign-wallet', recordIds: ids, entityId, previousOwnership,
    undoToken: `${input.suggestion.fingerprint}:${now}`, createdAt: now, updatedAt: now,
  };
  const prior = await repository.get('ownershipReviewDecisions', decision.id);
  const saved = await repository.commitOwnershipReview({ decision: { ...decision, createdAt: prior?.createdAt ?? now }, ownershipRows: ownershipRowsToSave });
  notifyDbChange('addressOwnership'); notifyDbChange('ownershipReviewDecisions');
  return saved;
}

export async function undoOwnershipDecision(token: string, repository: VaultRepository = getVaultRepository()): Promise<boolean> {
  const separator = token.lastIndexOf(':');
  if (separator <= 0) return false;
  const decisionId = token.slice(0, separator);
  const decision = await repository.get('ownershipReviewDecisions', decisionId);
  if (!decision || decision.undoToken !== token || !decision.previousOwnership) return false;
  const ownership = await listRows<AddressOwnership>(repository, 'addressOwnership', OWNERSHIP_REVIEW_LIMITS.records);
  const deleteOwnershipIds = ownership.filter(row => decision.createdOwnershipRecordIds?.includes(row.recordId) && row.id !== undefined)
    .map(row => row.id!);
  await repository.commitOwnershipReview({ decision: { ...decision, undoToken: undefined, updatedAt: Date.now() },
    ownershipRows: decision.previousOwnership, deleteOwnershipIds });
  notifyDbChange('addressOwnership'); notifyDbChange('ownershipReviewDecisions');
  return true;
}

export async function listRows<T>(repository: VaultRepository, table: any, cap: number): Promise<T[]> {
  const rows: T[] = []; let cursor: string | number | undefined;
  do { const page = await repository.list(table, { cursor, limit: Math.min(500, cap - rows.length) }); rows.push(...page.rows as T[]); cursor = page.cursor; }
  while (cursor !== undefined && rows.length < cap);
  return rows;
}