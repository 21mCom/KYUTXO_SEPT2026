/**
 * Owner cost-basis book.
 *
 * This is deliberately separate from coin-origins-core: coin origins answers
 * "where did this UTXO come from?", while this file answers "which owner's tax
 * lot was disposed?".  Both use satoshis as integers, but neither calculation
 * is allowed to overwrite the other.
 */
import type { Owner, OwnerMatchingMethod, OwnerResidency } from './db-types';

export const UNASSIGNED_COST_BASIS_OWNER = '__unassigned__';
export type ValueProvenance = 'provided' | 'estimated' | 'unknown';
export type TransferBasisRule = 'carry-over' | 'market-value-step-up';

export interface OwnerBookAddress {
  address: string;
  /** Empty and whitespace-only labels are always the isolated Unassigned book. */
  owner?: string | null;
}
export interface OwnerBookTransaction {
  txid: string;
  /** ISO calendar date.  A missing date remains visible in warnings. */
  date?: string | null;
  feeSats?: number | null;
  /** Transaction defaults, superseded by a matching leg. */
  costBasisUsd?: number | null;
  estimatedCostBasisUsd?: number | null;
  proceedsUsd?: number | null;
  estimatedProceedsUsd?: number | null;
}
export interface OwnerBookParticipant {
  id?: number;
  txid: string;
  role: 'input' | 'output';
  address?: string | null;
  amount: number;
  vout?: number | null;
  prevTxid?: string | null;
  prevVout?: number | null;
}
export interface OwnerBookLeg {
  txid: string;
  legKey: string;
  /** Matches normalized transaction leg metadata when present. */
  direction?: 'incoming' | 'outgoing' | 'owner-transfer';
  owner?: string | null;
  costBasisUsd?: number | null;
  estimatedCostBasisUsd?: number | null;
  proceedsUsd?: number | null;
  estimatedProceedsUsd?: number | null;
  transferBasisRule?: TransferBasisRule;
  /** Market value used for a step-up; provenance is explicit. */
  marketValueUsd?: number | null;
  estimatedMarketValueUsd?: number | null;
  /** Ordered lot ids selected by a user under specific-identification. */
  specificLotIds?: string[];
}
export interface OwnerBookInput {
  owners: Owner[];
  residencies: OwnerResidency[];
  addresses: OwnerBookAddress[];
  transactions: OwnerBookTransaction[];
  participants: OwnerBookParticipant[];
  legs?: OwnerBookLeg[];
  /** Used for old single-owner vaults whose address labels were absent. */
  legacyDefaultOwner?: string;
}

export interface OwnerCostBatch {
  lotId: string;
  owner: string;
  acquiredTxid: string;
  acquiredAt?: string;
  sats: number;
  remainingSats: number;
  costUsd?: number;
  costProvenance: ValueProvenance;
}
export interface OwnerCostAllocation {
  lotId: string;
  sats: number;
  costUsd?: number;
  costProvenance: ValueProvenance;
}
export interface OwnerCostDisposal {
  txid: string;
  date?: string;
  owner: string;
  kind: 'external' | 'fee' | 'owner-transfer';
  sats: number;
  allocations: OwnerCostAllocation[];
  costUsd?: number;
  costProvenance: ValueProvenance;
  proceedsUsd?: number;
  proceedsProvenance: ValueProvenance;
  matchingMethod: OwnerMatchingMethod;
  transferBasisRule?: TransferBasisRule;
  /** The controlled input leg which supplied this disposal. */
  sourceLegKey?: string;
  /** The controlled recipient output leg for an owner transfer. */
  recipientLegKey?: string;
  /** Recipient book owner when this disposal closes one owner's book and opens another. */
  recipientOwner?: string;
}
export interface OwnerCostWarning {
  code: 'residency-gap' | 'missing-disposal-date' | 'unknown-owner-policy' | 'specific-identification-unavailable';
  owner: string;
  date?: string;
  message: string;
}
export interface OwnerCostAssumption {
  owner: string;
  date?: string;
  matchingMethod: OwnerMatchingMethod;
  residency?: Pick<OwnerResidency, 'jurisdiction' | 'region' | 'startDate' | 'endDate'>;
  fallback: boolean;
}
export interface OwnerCostSummary {
  owner: string;
  disposedSats: number;
  feeSats: number;
  proceedsUsd?: number;
  costUsd?: number;
  gainUsd?: number;
  openSats: number;
  unknownCostSats: number;
}
export interface OwnerCostBasisReport {
  version: 1;
  /** Stable revision of the policy snapshot used for every row in this report. */
  policyRevision: string;
  batches: OwnerCostBatch[];
  disposals: OwnerCostDisposal[];
  warnings: OwnerCostWarning[];
  assumptions: OwnerCostAssumption[];
  /** Includes Unassigned; selectedOwner only filters this display breakdown. */
  byOwner: OwnerCostSummary[];
  selectedOwner?: string;
}
/** Bounded renderer DTO. Detailed lots/disposals never cross a normal screen boundary. */
export interface OwnerCostBasisPage {
  version: 1;
  checkpointKey: string;
  policyRevision: string;
  byOwner: OwnerCostSummary[];
  /** Bounded disposal rows; allocations remain in the non-renderer report only. */
  disposals: OwnerCostDisposalSummary[];
  /** Bounded currently-open lots, suitable for a normal screen. */
  openBatches: OwnerCostOpenBatchSummary[];
  warnings: OwnerCostWarning[];
  assumptions: OwnerCostAssumption[];
  disposalsTotal: number;
  openBatchesTotal: number;
  warningsTotal: number;
  assumptionsTotal: number;
  /** Bounded, checkpoint-bound rows accepted by the cost-basis editor. */
  editorRows: OwnerCostBasisEditorRow[];
  editorRowsTotal: number;
}
export type OwnerCostDisposalSummary = Omit<OwnerCostDisposal, 'allocations'> & { allocationsTotal: number };
export type OwnerCostOpenBatchSummary = Pick<OwnerCostBatch,
  'lotId' | 'owner' | 'acquiredTxid' | 'acquiredAt' | 'sats' | 'remainingSats' | 'costUsd' | 'costProvenance'>;
export interface OwnerCostBasisEditorRow {
  txid: string;
  owner: string;
  kind: 'external' | 'owner-transfer';
  sats: number;
  legKey: string;
  sourceLegKey?: string;
  recipientLegKey?: string;
  /** Source owner remains available for transfer context; owner is the edited leg's owner. */
  sourceOwner?: string;
  direction: 'outgoing' | 'owner-transfer';
}

const isSats = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const amount = (value: unknown) => isSats(value) ? value : 0;
// An intentionally blank label is not a synonym for the default owner.  This is
// important when an address is cleared after a mixed-owner consolidation.
const cleanOwner = (owner?: string | null, legacy?: string) =>
  owner === undefined ? legacy?.trim() || UNASSIGNED_COST_BASIS_OWNER : owner?.trim() || UNASSIGNED_COST_BASIS_OWNER;
const knownValue = (provided?: number | null, estimated?: number | null): { value?: number; provenance: ValueProvenance } =>
  Number.isFinite(provided) ? { value: provided!, provenance: 'provided' } :
    Number.isFinite(estimated) ? { value: estimated!, provenance: 'estimated' } : { provenance: 'unknown' };
const legKey = (part: OwnerBookParticipant) => `${part.role}:${part.role === 'output' ? part.vout ?? part.id ?? part.address : part.vout ?? part.id ?? part.address}`;
const outpoint = (txid: string, vout: number) => `${txid}:${vout}`;

/** Largest-remainder allocation makes every proportional sat allocation exact. */
export function allocateSatsProportionally(total: number, weights: readonly number[]): number[] {
  if (!isSats(total) || !weights.length) return weights.map(() => 0);
  const valid = weights.map(amount);
  const denominator = valid.reduce((sum, n) => sum + n, 0);
  if (!denominator) return valid.map(() => 0);
  const base = valid.map(weight => Math.floor(total * weight / denominator));
  const remainder = total - base.reduce((sum, n) => sum + n, 0);
  // Stable index tie-break is intentional and makes native/fallback repeatable.
  const winners = new Set(valid.map((weight, i) => ({ i, r: (total * weight) % denominator }))
    .sort((a, b) => b.r - a.r || a.i - b.i).slice(0, remainder).map(row => row.i));
  return base.map((n, index) => n + (winners.has(index) ? 1 : 0));
}

function policyFor(
  owner: string, date: string | undefined, owners: Owner[], residencies: OwnerResidency[], warnings: OwnerCostWarning[], assumptions: OwnerCostAssumption[],
): OwnerMatchingMethod {
  const policyOwner = owners.find(row => row.name.trim().toLocaleLowerCase() === owner.toLocaleLowerCase());
  const residency = policyOwner && date
    ? residencies.find(row => row.ownerId === policyOwner.id && row.startDate <= date && (!row.endDate || date <= row.endDate))
    : undefined;
  const fallback = !residency;
  const method = residency?.matchingMethod ?? policyOwner?.defaultMatchingMethod ?? 'fifo';
  assumptions.push({ owner, date, matchingMethod: method, residency: residency && {
    jurisdiction: residency.jurisdiction, region: residency.region, startDate: residency.startDate, endDate: residency.endDate,
  }, fallback });
  if (!date) warnings.push({ code: 'missing-disposal-date', owner, message: `No disposal date for ${owner}; ${method.toUpperCase()} owner default was used.` });
  else if (!policyOwner && owner !== UNASSIGNED_COST_BASIS_OWNER) warnings.push({ code: 'unknown-owner-policy', owner, date, message: `${owner} has no policy owner; FIFO default was used.` });
  else if (!residency && owner !== UNASSIGNED_COST_BASIS_OWNER) warnings.push({ code: 'residency-gap', owner, date, message: `${owner} has no residency covering ${date}; ${method.toUpperCase()} owner default was used.` });
  return method;
}

function costPiece(batch: OwnerCostBatch, sats: number): OwnerCostAllocation {
  const costUsd = batch.costUsd === undefined ? undefined : batch.costUsd * sats / batch.sats;
  return { lotId: batch.lotId, sats, costUsd, costProvenance: batch.costProvenance };
}

function takeLots(
  book: OwnerCostBatch[], sats: number, method: OwnerMatchingMethod, specific: string[] | undefined,
): OwnerCostAllocation[] {
  const available = book.filter(batch => batch.remainingSats > 0);
  let ordered = [...available];
  if (method === 'lifo') ordered.sort((a, b) => (b.acquiredAt ?? '').localeCompare(a.acquiredAt ?? '') || b.acquiredTxid.localeCompare(a.acquiredTxid) || b.lotId.localeCompare(a.lotId));
  else if (method === 'hifo') ordered.sort((a, b) => ((b.costUsd ?? -Infinity) / b.sats) - ((a.costUsd ?? -Infinity) / a.sats) || a.lotId.localeCompare(b.lotId));
  else if (method === 'specific-identification' && specific?.length) {
    const position = new Map(specific.map((id, i) => [id, i]));
    ordered.sort((a, b) => (position.get(a.lotId) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.lotId) ?? Number.MAX_SAFE_INTEGER) || a.lotId.localeCompare(b.lotId));
  }
  const result: OwnerCostAllocation[] = [];
  if (method === 'proportional') {
    const shares = allocateSatsProportionally(Math.min(sats, available.reduce((n, b) => n + b.remainingSats, 0)), available.map(b => b.remainingSats));
    available.forEach((batch, i) => { if (shares[i]) { batch.remainingSats -= shares[i]; result.push(costPiece(batch, shares[i])); } });
    return result;
  }
  let remaining = sats;
  for (const batch of ordered) {
    const used = Math.min(remaining, batch.remainingSats);
    if (used) { batch.remainingSats -= used; result.push(costPiece(batch, used)); remaining -= used; }
    if (!remaining) break;
  }
  if (remaining) result.push({ lotId: 'unknown', sats: remaining, costProvenance: 'unknown' });
  return result;
}

function allocationCost(parts: OwnerCostAllocation[]): { costUsd?: number; provenance: ValueProvenance } {
  if (parts.some(p => p.costProvenance === 'unknown')) return { provenance: 'unknown' };
  const costUsd = parts.reduce((sum, p) => sum + (p.costUsd ?? 0), 0);
  return { costUsd, provenance: parts.some(p => p.costProvenance === 'estimated') ? 'estimated' : 'provided' };
}

/** Calculate a report; `selectedOwner` only filters the returned owner breakdown. */
export function calculateOwnerCostBasis(input: OwnerBookInput, selectedOwner?: string): OwnerCostBasisReport {
  const addressOwner = new Map(input.addresses.map(row => [row.address, cleanOwner(row.owner, input.legacyDefaultOwner)]));
  const txs = [...input.transactions].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.txid.localeCompare(b.txid));
  const parts = new Map<string, OwnerBookParticipant[]>();
  input.participants.forEach(p => parts.set(p.txid, [...(parts.get(p.txid) ?? []), p]));
  const legs = new Map((input.legs ?? []).map(row => [`${row.txid}|${row.legKey}`, row]));
  const books = new Map<string, OwnerCostBatch[]>();
  const addBatch = (batch: OwnerCostBatch) => { const book = books.get(batch.owner) ?? []; book.push(batch); books.set(batch.owner, book); };
  const disposals: OwnerCostDisposal[] = [], warnings: OwnerCostWarning[] = [], assumptions: OwnerCostAssumption[] = [];

  for (const tx of txs) {
    const rows = parts.get(tx.txid) ?? [];
    const ins = rows.filter(p => p.role === 'input' && amount(p.amount));
    const outs = rows.filter(p => p.role === 'output' && amount(p.amount));
    // A normalized input leg is authoritative for an ownership correction. Do
    // this before grouping: a consolidation can have several inputs belonging
    // to the same displayed owner with different specific-lot instructions.
    const ownedIns = ins.map(p => {
      const leg = legs.get(`${tx.txid}|${legKey(p)}`);
      return { p, leg, owner: leg?.owner === undefined ? addressOwner.get(p.address ?? '') : cleanOwner(leg.owner) };
    }).filter((x): x is typeof x & { owner: string } => !!x.owner);
    const ownedOuts = outs.map(p => {
      const leg = legs.get(`${tx.txid}|${legKey(p)}`);
      return { p, leg, owner: leg?.owner === undefined ? addressOwner.get(p.address ?? '') : cleanOwner(leg.owner) };
    }).filter((x): x is typeof x & { owner: string } => !!x.owner);
    if (!ownedIns.length) {
      const outputSats = ownedOuts.map(({ p }) => amount(p.amount));
      const totalProvided = knownValue(tx.costBasisUsd, tx.estimatedCostBasisUsd);
      const totalCostShares = totalProvided.value === undefined
        ? outputSats.map(() => undefined)
        : allocateValueProportionally(totalProvided.value, outputSats);
      for (const [outputIndex, { p, owner }] of ownedOuts.entries()) {
        const leg = legs.get(`${tx.txid}|${legKey(p)}`);
        const legValue = knownValue(leg?.costBasisUsd, leg?.estimatedCostBasisUsd);
        const value = legValue.value !== undefined
          ? legValue
          : { value: totalCostShares[outputIndex], provenance: totalProvided.provenance };
        addBatch({ lotId: `book:${tx.txid}:${p.vout ?? p.id ?? 0}`, owner, acquiredTxid: tx.txid, acquiredAt: tx.date ?? undefined, sats: amount(p.amount), remainingSats: amount(p.amount), costUsd: value.value, costProvenance: value.provenance });
      }
      continue;
    }
    const totalIn = ownedIns.reduce((n, row) => n + amount(row.p.amount), 0);
    // Provider fee metadata is advisory. When every observed input/output has
    // an exact integer amount, conservation is the authoritative fee even if a
    // provider omitted or misreported it. With incomplete rows, retain the
    // provider value but never charge more than the controlled input pool.
    const completeInputs = rows.filter(p => p.role === 'input');
    const completeOutputs = rows.filter(p => p.role === 'output');
    const allAmountsAvailable = completeInputs.length > 0 && completeOutputs.every(p => isSats(p.amount)) &&
      completeInputs.every(p => isSats(p.amount));
    const allInputSats = completeInputs.reduce((n, p) => n + amount(p.amount), 0);
    const allOutputSats = completeOutputs.reduce((n, p) => n + amount(p.amount), 0);
    const reconciledFee = allAmountsAvailable && allInputSats >= allOutputSats
      ? allInputSats - allOutputSats : undefined;
    const feeSats = reconciledFee ?? amount(tx.feeSats);
    // Fee ownership follows the observed input contribution universe. This
    // avoids charging a controlled input for an external co-input's fee.
    const feeByInput = allocateSatsProportionally(Math.min(feeSats, allInputSats), completeInputs.map(p => amount(p.amount)));
    const feeByParticipant = new Map<OwnerBookParticipant, number>(
      completeInputs.map((p, i): [OwnerBookParticipant, number] => [p, feeByInput[i] ?? 0]),
    );
    const source: Array<{ owner: string; allocations: OwnerCostAllocation[]; remaining: number; method: OwnerMatchingMethod; leg?: OwnerBookLeg; legKey: string }> = [];
    ownedIns.forEach(({ p, owner, leg: inputLeg }) => {
      const sats = amount(p.amount);
      const method = policyFor(owner, tx.date ?? undefined, input.owners, input.residencies, warnings, assumptions);
      const allocations = takeLots(books.get(owner) ?? [], sats, method, inputLeg?.specificLotIds);
      if (method === 'specific-identification' && !inputLeg?.specificLotIds?.length) warnings.push({
        code: 'specific-identification-unavailable', owner, date: tx.date ?? undefined,
        message: `${owner} selected specific identification but no input lots were specified; stable FIFO order was used.`,
      });
      const inputFee = Math.min(feeByParticipant.get(p) ?? 0, sats);
      const sourceLegKey = legKey(p);
      source.push({ owner, allocations, remaining: sats - inputFee, method, leg: inputLeg, legKey: sourceLegKey });
      if (inputFee) {
        const feeParts = takeAllocation(allocations, inputFee);
        const cost = allocationCost(feeParts);
        disposals.push({ txid: tx.txid, date: tx.date ?? undefined, owner, kind: 'fee', sats: inputFee, allocations: feeParts, costUsd: cost.costUsd, costProvenance: cost.provenance, proceedsProvenance: 'unknown', matchingMethod: method, sourceLegKey });
      }
    });
    for (const { p, owner: recipient } of ownedOuts) {
      let needed = amount(p.amount);
      const received: OwnerCostAllocation[] = [];
      const transferChunks: Array<{ src: typeof source[number]; sats: number; allocations: OwnerCostAllocation[] }> = [];
      const recipientLegKey = legKey(p);
      const recipientLeg = legs.get(`${tx.txid}|${recipientLegKey}`);
      for (const src of source) {
        const used = Math.min(needed, src.remaining); if (!used) continue;
        const chunk = takeAllocation(src.allocations, used); src.remaining -= used; needed -= used; received.push(...chunk);
        if (src.owner !== recipient) {
          transferChunks.push({ src, sats: used, allocations: chunk });
        }
      }
      // A recipient output has one market value, even where several owners fund
      // it. Allocate that value once across its ordered source chunks; assigning
      // it per chunk would duplicate proceeds and overstate the transfer.
      const rule = recipientLeg?.transferBasisRule ?? 'carry-over';
      const proceeds = rule === 'market-value-step-up'
        ? knownValue(recipientLeg?.marketValueUsd ?? recipientLeg?.proceedsUsd ?? tx.proceedsUsd, recipientLeg?.estimatedMarketValueUsd ?? recipientLeg?.estimatedProceedsUsd ?? tx.estimatedProceedsUsd)
        : { provenance: 'unknown' as ValueProvenance };
      const proceedsShares = proceeds.value === undefined ? transferChunks.map(() => undefined)
        : allocateValueExactly(proceeds.value, transferChunks.map(chunk => chunk.sats));
      transferChunks.forEach((chunk, index) => {
        const cost = allocationCost(chunk.allocations);
        disposals.push({ txid: tx.txid, date: tx.date ?? undefined, owner: chunk.src.owner, recipientOwner: recipient, kind: 'owner-transfer', sats: chunk.sats, allocations: chunk.allocations, costUsd: cost.costUsd, costProvenance: cost.provenance, proceedsUsd: proceedsShares[index], proceedsProvenance: proceeds.provenance, matchingMethod: chunk.src.method, transferBasisRule: rule, sourceLegKey: chunk.src.legKey, recipientLegKey });
      });
      // Never manufacture a carry-over basis if the output is larger than the
      // controlled input pool (for example, a mixed external input).  The
      // excess is a separately visible unknown batch.
      if (needed > 0) received.push({ lotId: 'unknown', sats: needed, costProvenance: 'unknown' });
      const inherited = allocationCost(received);
      const isStepUp = recipientLeg?.transferBasisRule === 'market-value-step-up';
      const stepped = isStepUp ? knownValue(recipientLeg!.marketValueUsd, recipientLeg!.estimatedMarketValueUsd) : undefined;
      addBatch({ lotId: `book:${tx.txid}:${p.vout ?? p.id ?? 0}`, owner: recipient, acquiredTxid: tx.txid, acquiredAt: tx.date ?? undefined, sats: amount(p.amount), remainingSats: amount(p.amount), costUsd: stepped?.value ?? inherited.costUsd, costProvenance: stepped?.provenance ?? inherited.provenance });
    }
    const externalSources = source.filter(src => src.remaining > 0);
    const transactionProceeds = knownValue(tx.proceedsUsd, tx.estimatedProceedsUsd);
    const proceedsShares = transactionProceeds.value === undefined
      ? externalSources.map(() => undefined)
      : allocateValueProportionally(transactionProceeds.value, externalSources.map(src => src.remaining));
    for (const [sourceIndex, src] of externalSources.entries()) {
      const used = src.remaining, chunks = takeAllocation(src.allocations, used), cost = allocationCost(chunks);
      const legProceeds = knownValue(src.leg?.proceedsUsd, src.leg?.estimatedProceedsUsd);
      const defaults = legProceeds.value !== undefined
        ? legProceeds
        : { value: proceedsShares[sourceIndex], provenance: transactionProceeds.provenance };
      disposals.push({ txid: tx.txid, date: tx.date ?? undefined, owner: src.owner, kind: 'external', sats: used, allocations: chunks, costUsd: cost.costUsd, costProvenance: cost.provenance, proceedsUsd: defaults.value, proceedsProvenance: defaults.provenance, matchingMethod: src.method, sourceLegKey: src.legKey });
    }
  }
  const allBatches = [...books.values()].flat();
  const names = new Set([...books.keys(), ...disposals.map(d => d.owner)]);
  const byOwner = [...names].sort().map(owner => {
    const mine = disposals.filter(d => d.owner === owner), external = mine.filter(d => d.kind !== 'fee');
    const costsKnown = external.every(d => d.costProvenance !== 'unknown'), proceedsKnown = external.every(d => d.proceedsProvenance !== 'unknown');
    const costUsd = costsKnown ? external.reduce((n, d) => n + (d.costUsd ?? 0), 0) : undefined;
    const proceedsUsd = proceedsKnown ? external.reduce((n, d) => n + (d.proceedsUsd ?? 0), 0) : undefined;
    const batches = allBatches.filter(b => b.owner === owner);
    return { owner, disposedSats: external.reduce((n, d) => n + d.sats, 0), feeSats: mine.filter(d => d.kind === 'fee').reduce((n, d) => n + d.sats, 0), costUsd, proceedsUsd, gainUsd: costUsd === undefined || proceedsUsd === undefined ? undefined : proceedsUsd - costUsd, openSats: batches.reduce((n, b) => n + b.remainingSats, 0), unknownCostSats: batches.filter(b => b.costProvenance === 'unknown').reduce((n, b) => n + b.remainingSats, 0) };
  });
  const policyRevision = input.owners.map(row => `${row.id}:${row.name}:${row.archivedAt ?? ''}`)
    .concat(input.residencies.map(row => `${row.ownerId}:${row.startDate}:${row.endDate ?? ''}:${row.matchingMethod}:${row.updatedAt}`))
    .sort().join('|');
  return { version: 1, policyRevision, batches: allBatches, disposals, warnings, assumptions, byOwner: selectedOwner === undefined ? byOwner : byOwner.filter(row => row.owner === cleanOwner(selectedOwner)), selectedOwner };
}

/**
 * Selecting an owner changes only the display breakdown, never the underlying
 * accounting book.  Keeping this projection separate lets a materialized book
 * serve owner switches without re-matching lots or losing warnings/provenance.
 */
export function selectOwnerCostBasisReport(report: OwnerCostBasisReport, selectedOwner?: string): OwnerCostBasisReport {
  return {
    ...report,
    byOwner: selectedOwner === undefined
      ? report.byOwner
      : report.byOwner.filter(row => row.owner === cleanOwner(selectedOwner)),
    selectedOwner,
  };
}

export function ownerCostBasisEditorRows(report: OwnerCostBasisReport): OwnerCostBasisEditorRow[] {
  const rows: OwnerCostBasisEditorRow[] = [];
  for (const disposal of report.disposals) {
    if (disposal.kind === 'fee') continue;
    const key = disposal.kind === 'external' ? disposal.sourceLegKey : disposal.recipientLegKey;
    if (!key) continue;
    rows.push({
      txid: disposal.txid,
      owner: disposal.kind === 'owner-transfer' ? disposal.recipientOwner ?? UNASSIGNED_COST_BASIS_OWNER : disposal.owner,
      sourceOwner: disposal.kind === 'owner-transfer' ? disposal.owner : undefined,
      kind: disposal.kind,
      sats: disposal.sats,
      legKey: key,
      direction: disposal.kind === 'external' ? 'outgoing' : 'owner-transfer',
      sourceLegKey: disposal.sourceLegKey,
      recipientLegKey: disposal.recipientLegKey,
    });
  }
  return [...new Map(rows.map(row => [`${row.txid}|${row.legKey}`, row])).values()];
}

function allocateValueProportionally(total: number, weights: readonly number[]): number[] {
  const denominator = weights.reduce((sum, weight) => sum + amount(weight), 0);
  if (!denominator) return weights.map(() => 0);
  return weights.map(weight => total * amount(weight) / denominator);
}

/** Preserve an output's stated value exactly while deterministically splitting it. */
function allocateValueExactly(total: number, weights: readonly number[]): number[] {
  const shares = allocateValueProportionally(total, weights);
  if (!shares.length) return shares;
  // Floating point division can leave a tiny residual. Give it to the final
  // stable chunk so reductions always equal the declared output value exactly.
  shares[shares.length - 1] = total - shares.slice(0, -1).reduce((sum, value) => sum + value, 0);
  return shares;
}

/** Compact, auditable export: detailed allocations stay available in the book,
 * while this bounded summary is safe for a normal report download. */
export function buildOwnerCostBasisCsv(report: OwnerCostBasisReport): string {
  const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [
    ['Owner', 'Disposed sats', 'Fee sats', 'Open sats', 'Cost USD', 'Proceeds USD', 'Gain USD', 'Unknown open cost sats'],
    ...report.byOwner.map(row => [row.owner === UNASSIGNED_COST_BASIS_OWNER ? 'Unassigned' : row.owner, row.disposedSats, row.feeSats, row.openSats, row.costUsd ?? 'unknown', row.proceedsUsd ?? 'unknown', row.gainUsd ?? 'unknown', row.unknownCostSats]),
    [],
    ['Policy assumptions'],
    ['Owner', 'Date', 'Jurisdiction', 'Method', 'Fallback'],
    ...report.assumptions.map(row => [row.owner, row.date ?? 'unknown', row.residency?.jurisdiction ?? 'none', row.matchingMethod, row.fallback ? 'yes' : 'no']),
    [],
    ['Warnings'],
    ...report.warnings.map(row => [row.code, row.owner, row.date ?? '', row.message]),
  ];
  return lines.map(line => line.map(quote).join(',')).join('\n');
}

export function pageOwnerCostBasis(report: OwnerCostBasisReport, checkpointKey: string, limit = 100, editorRows: OwnerCostBasisEditorRow[] = []): OwnerCostBasisPage {
  const bounded = Math.min(250, Math.max(1, Math.trunc(limit)));
  const openBatches = report.batches.filter(batch => batch.remainingSats > 0);
  return { version: 1, checkpointKey, policyRevision: report.policyRevision, byOwner: report.byOwner.slice(0, bounded),
    disposals: report.disposals.slice(0, bounded).map(({ allocations, ...disposal }) => ({ ...disposal, allocationsTotal: allocations.length })),
    openBatches: openBatches.slice(0, bounded),
    warnings: report.warnings.slice(0, bounded), assumptions: report.assumptions.slice(0, bounded),
    disposalsTotal: report.disposals.length, openBatchesTotal: openBatches.length,
    warningsTotal: report.warnings.length, assumptionsTotal: report.assumptions.length,
    editorRows: editorRows.slice(0, bounded), editorRowsTotal: editorRows.length };
}
export function buildOwnerCostBasisPageCsv(page: OwnerCostBasisPage): string {
  const q = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [['Checkpoint', page.checkpointKey], ['Owner', 'Disposed sats', 'Fee sats', 'Open sats', 'Cost USD', 'Proceeds USD', 'Gain USD'],
    ...page.byOwner.map(x => [x.owner, x.disposedSats, x.feeSats, x.openSats, x.costUsd ?? 'unknown', x.proceedsUsd ?? 'unknown', x.gainUsd ?? 'unknown']),
    [],
    ['Disposals shown', `${page.disposals.length} of ${page.disposalsTotal}`],
    ['Transaction', 'Owner', 'Kind', 'Sats', 'Cost USD', 'Proceeds USD', 'Allocations'],
    ...page.disposals.map(x => [x.txid, x.owner, x.kind, x.sats, x.costUsd ?? 'unknown', x.proceedsUsd ?? 'unknown', x.allocationsTotal]),
    [],
    ['Open batches shown', `${page.openBatches.length} of ${page.openBatchesTotal}`],
    ['Lot', 'Owner', 'Acquired transaction', 'Remaining sats', 'Cost USD', 'Cost provenance'],
    ...page.openBatches.map(x => [x.lotId, x.owner, x.acquiredTxid, x.remainingSats, x.costUsd ?? 'unknown', x.costProvenance])]
    .map(row => row.map(q).join(',')).join('\n');
}

/** Consume a list of allocations in list order without ever rounding sats. */
function takeAllocation(parts: OwnerCostAllocation[], wanted: number): OwnerCostAllocation[] {
  const result: OwnerCostAllocation[] = [];
  let left = wanted;
  for (const part of parts) {
    if (!left || !part.sats) continue;
    const sats = Math.min(left, part.sats);
    const before = part.sats;
    const costUsd = part.costUsd === undefined ? undefined : part.costUsd * sats / before;
    part.sats -= sats; left -= sats;
    if (part.costUsd !== undefined) part.costUsd -= costUsd!;
    result.push({ ...part, sats, costUsd });
  }
  if (left) result.push({ lotId: 'unknown', sats: left, costProvenance: 'unknown' });
  return result;
}
