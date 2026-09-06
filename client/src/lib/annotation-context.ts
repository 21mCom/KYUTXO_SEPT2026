import {
  isUserCuratedImportance,
  type AddressOwnership,
  type BlockchainTransaction,
  type Record,
  type TransactionLegMetadata,
  type TransactionMetadata,
  type TransactionParticipant,
} from './db-types';

/**
 * A deliberately UI-neutral description of what an annotation screen should
 * ask.  It contains values, not callbacks or database rows, and is therefore
 * safe to put in panel state, snapshots, or an IPC/backup payload.
 */
export type AnnotationClassification =
  | 'receive'
  | 'send'
  | 'change'
  | 'consolidation'
  | 'owner-transfer'
  | 'coinjoin'
  | 'undetermined';

export type AnnotationQuestion =
  | 'controlled-by'
  | 'wallet-or-counterparty'
  | 'label'
  | 'notes'
  | 'tags'
  | 'acquisition-method'
  | 'disposition-type';

export interface AddressAnnotationContext {
  target: 'address';
  classification: 'address';
  sentence: string;
  questions: readonly AnnotationQuestion[];
  address: string;
  ownership: 'ours' | 'external' | 'unassigned' | 'undetermined';
}

export interface AnnotationLegContext {
  legKey: string;
  role: TransactionParticipant['role'];
  address: string;
  amount: number;
  ownership: 'ours' | 'external' | 'unassigned' | 'undetermined';
  owner?: string;
  wallet?: string;
  counterparty?: string;
  direction: TransactionLegMetadata['direction'];
  /** Only fields deliberately supplied for this leg; never includes defaults. */
  override?: AnnotationMetadataValues;
  /** Defaults merged with the explicit per-leg values for display/editing. */
  effective: AnnotationMetadataValues;
}

export interface AnnotationMetadataValues {
  flowType?: TransactionMetadata['flowType'];
  acquisitionMethod?: TransactionMetadata['acquisitionMethod'];
  dispositionType?: TransactionMetadata['dispositionType'];
  costBasisUsd?: number;
  categories?: string[];
  tags?: string[];
  notes?: string;
}

export interface TransactionAnnotationContext {
  target: 'transaction';
  txid: string;
  classification: AnnotationClassification;
  sentence: string;
  questions: readonly AnnotationQuestion[];
  /** Explicit transaction-level values, suitable as per-leg defaults. */
  defaults: AnnotationMetadataValues;
  legs: AnnotationLegContext[];
  participatingOwners: string[];
  participatingWallets: string[];
  participatingCounterparties: string[];
  hasUndeterminedInputs: boolean;
}

export interface DeriveTransactionAnnotationContextInput {
  transaction: BlockchainTransaction;
  participants: readonly TransactionParticipant[];
  addressRecords: readonly Record[];
  /** Optional normalized ownership takes precedence over the legacy projection. */
  addressOwnership?: readonly AddressOwnership[];
  transactionMetadata?: TransactionMetadata;
  legMetadata?: readonly TransactionLegMetadata[];
}

/** Relationship fields are intentionally absent for change/consolidation/
 * CoinJoin. A metadata-only save from those screens must not project blank
 * hidden values onto participant ownership. */
export function shouldPersistTransactionRelationships(
  context: TransactionAnnotationContext | null,
  relationshipDirty: boolean,
): context is TransactionAnnotationContext {
  return !!context && relationshipDirty &&
    (context.questions.includes('controlled-by') || context.questions.includes('wallet-or-counterparty'));
}

type Ownership = AnnotationLegContext['ownership'];

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function recordIndex(records: readonly Record[]): Map<number, Record> {
  return new Map(records.filter((record): record is Record & { id: number } =>
    record.type === 'address' && typeof record.id === 'number').map(record => [record.id, record]));
}

function classifyRecord(record: Record | undefined, normalized: AddressOwnership | undefined): Ownership {
  if (normalized) {
    if (normalized.state === 'assigned' || normalized.state === 'ours-owner-unknown') return 'ours';
    if (normalized.state === 'not-ours') return 'external';
    return 'undetermined';
  }
  if (!record) return 'undetermined';
  if (record.counterpartyType) return 'external';
  return isUserCuratedImportance(record.addressImportance) ? 'ours' : 'external';
}

function metadataValues(metadata: TransactionMetadata | TransactionLegMetadata | undefined): AnnotationMetadataValues {
  if (!metadata) return {};
  const value: AnnotationMetadataValues = {};
  if (metadata.flowType !== undefined) value.flowType = metadata.flowType;
  if (metadata.acquisitionMethod !== undefined) value.acquisitionMethod = metadata.acquisitionMethod;
  if (metadata.dispositionType !== undefined) value.dispositionType = metadata.dispositionType;
  if (metadata.costBasisUsd !== undefined) value.costBasisUsd = metadata.costBasisUsd;
  if (metadata.categories !== undefined) value.categories = [...metadata.categories];
  if (metadata.tags !== undefined) value.tags = [...metadata.tags];
  if (metadata.notes !== undefined) value.notes = metadata.notes;
  return value;
}

/** Stable key used by the normalized projection and by callers building leg edits. */
export function annotationLegKey(participant: TransactionParticipant): string {
  return `${participant.role}:${participant.vout ?? participant.id ?? participant.address}`;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function isCoinjoin(parts: readonly TransactionParticipant[], records: Map<number, Record>): boolean {
  if (parts.some(part => records.get(part.recordId ?? -1)?.counterpartyType === 'mixer')) return true;
  const outputs = parts.filter(part => part.role === 'output' && part.amount > 0);
  const amounts = new Map<number, number>();
  for (const output of outputs) amounts.set(output.amount, (amounts.get(output.amount) ?? 0) + 1);
  return parts.filter(part => part.role === 'input').length >= 2 &&
    [...amounts.values()].some(count => count >= 3);
}

function transactionClassification(
  parts: readonly TransactionParticipant[],
  ownerships: readonly Ownership[],
  records: Map<number, Record>,
  normalizedOwnership: Map<number, AddressOwnership>,
): AnnotationClassification {
  const inputs = parts.filter(part => part.role === 'input');
  const outputs = parts.filter(part => part.role === 'output');
  // Do not let a pattern heuristic make a positive claim where an input is
  // incomplete or its ownership cannot be established. In particular, a
  // partially decoded CoinJoin must remain reviewable as undetermined.
  if (inputs.some(input => {
    const participantIndex = parts.indexOf(input);
    return !text(input.address) || ownerships[participantIndex] === 'undetermined';
  })) return 'undetermined';
  if (isCoinjoin(parts, records)) return 'coinjoin';
  const ownInputs = inputs.filter((_, index) => ownerships[parts.indexOf(inputs[index])] === 'ours');
  const ownOutputs = outputs.filter((_, index) => ownerships[parts.indexOf(outputs[index])] === 'ours');
  if (ownInputs.length === 0 && ownOutputs.length > 0) return 'receive';
  if (ownInputs.length === 0) return 'undetermined';
  const externalOutputs = outputs.filter((_, index) => ownerships[parts.indexOf(outputs[index])] !== 'ours');
  if (externalOutputs.length > 0) return 'send';
  if (ownOutputs.length === 0) return 'undetermined';
  // The normalized entity is the authoritative owner identity. Legacy owner
  // text remains a fallback only for addresses that have not been projected.
  const owners = unique([...ownInputs, ...ownOutputs].map(part => {
    const ownership = normalizedOwnership.get(part.recordId ?? -1);
    return ownership
      ? (ownership.entityId === undefined ? undefined : `entity:${ownership.entityId}`)
      : text(records.get(part.recordId ?? -1)?.owner);
  }));
  if (owners.length > 1) return 'owner-transfer';
  if (ownInputs.length > 1) return 'consolidation';
  return 'change';
}

function questionsFor(classification: AnnotationClassification): AnnotationQuestion[] {
  const common: AnnotationQuestion[] = ['label', 'notes', 'tags'];
  if (classification === 'receive') return ['wallet-or-counterparty', 'acquisition-method', ...common];
  if (classification === 'send') return ['wallet-or-counterparty', 'disposition-type', ...common];
  if (classification === 'owner-transfer') return ['controlled-by', 'wallet-or-counterparty', ...common];
  if (classification === 'undetermined') return ['controlled-by', 'wallet-or-counterparty', ...common];
  return common;
}

function sentenceFor(classification: AnnotationClassification): string {
  const sentences: globalThis.Record<AnnotationClassification, string> = {
    receive: 'This transaction receives funds into your wallet.',
    send: 'This transaction sends funds to an external counterparty.',
    change: 'This transaction moves funds to a change address you control.',
    consolidation: 'This transaction consolidates your unspent outputs.',
    'owner-transfer': 'This transaction transfers funds between your owners.',
    coinjoin: 'This transaction appears to be a CoinJoin.',
    undetermined: 'This transaction has undetermined inputs or ownership.',
  };
  return sentences[classification];
}

export function deriveAddressAnnotationContext(address: Record, ownership?: AddressOwnership): AddressAnnotationContext {
  const state = classifyRecord(address, ownership);
  return {
    target: 'address',
    classification: 'address',
    sentence: state === 'ours' ? 'This address is controlled by you.' : 'Annotate this address and its relationship to you.',
    questions: ['controlled-by', 'wallet-or-counterparty', 'label', 'notes', 'tags'],
    address: address.inputString,
    ownership: state,
  };
}

export function deriveTransactionAnnotationContext(input: DeriveTransactionAnnotationContextInput): TransactionAnnotationContext {
  const records = recordIndex(input.addressRecords);
  const ownershipByRecord = new Map((input.addressOwnership ?? []).map(row => [row.recordId, row]));
  const participants = input.participants.filter(participant => participant.txid === input.transaction.txid);
  const ownerships = participants.map(participant =>
    classifyRecord(records.get(participant.recordId ?? -1), ownershipByRecord.get(participant.recordId ?? -1)));
  const classification = transactionClassification(participants, ownerships, records, ownershipByRecord);
  const defaults = metadataValues(input.transactionMetadata);
  const legRows = new Map((input.legMetadata ?? [])
    .filter(leg => leg.txid === input.transaction.txid).map(leg => [leg.legKey, leg]));
  const legs = participants.map((participant, index) => {
    const record = records.get(participant.recordId ?? -1);
    const row = legRows.get(annotationLegKey(participant));
    const override = metadataValues(row);
    return {
      legKey: annotationLegKey(participant), role: participant.role, address: participant.address,
      amount: participant.amount, ownership: ownerships[index], owner: text(record?.owner),
      wallet: text(record?.walletName), counterparty: text(record?.counterpartyName),
      direction: row?.direction ?? (participant.role === 'input' ? 'outgoing' : classification === 'owner-transfer' ? 'owner-transfer' : 'incoming'),
      ...(row ? { override } : {}),
      effective: { ...defaults, ...override },
    };
  });
  const involved = participants.map(participant => records.get(participant.recordId ?? -1));
  return {
    target: 'transaction', txid: input.transaction.txid, classification, sentence: sentenceFor(classification),
    questions: questionsFor(classification), defaults, legs,
    participatingOwners: unique(involved.map(record => text(record?.owner))),
    participatingWallets: unique(involved.map(record => text(record?.walletName))),
    participatingCounterparties: unique(involved.map(record => text(record?.counterpartyName))),
    hasUndeterminedInputs: participants.some((participant, index) =>
      participant.role === 'input' && (!text(participant.address) || ownerships[index] === 'undetermined')),
  };
}