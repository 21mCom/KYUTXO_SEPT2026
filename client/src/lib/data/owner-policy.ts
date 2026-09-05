import { db, type Owner, type OwnerKind, type OwnerMatchingMethod, type OwnerResidency } from '../database';
import { loadCoinOrigins } from '../coin-origins';
import { propagateStringFieldRename } from './vocabulary-crud';

export const UNASSIGNED_OWNER_VALUE = '__unassigned__';
export const UNASSIGNED_OWNER_OPTION = { value: UNASSIGNED_OWNER_VALUE, label: 'Unassigned' } as const;

export interface OwnerSelectorOption {
  value: string;
  label: string;
  ownerId?: number;
}

export interface OwnerResidencyInput {
  startDate: string;
  endDate?: string;
  jurisdiction: string;
  region?: string;
  notes?: string;
  matchingMethod: OwnerMatchingMethod;
}

export interface OwnerPolicyResolution {
  owner: Owner;
  residency: OwnerResidency | null;
  matchingMethod: OwnerMatchingMethod;
}

export interface OwnerPolicySummary {
  currentHoldingsSats: number;
  currentBatchCount: number;
  unassignedBatchCount: number;
  unassignedSats: number;
  /** ISO dates for that owner's disposals that have no applicable residency. */
  disposalDatesOutsideResidency: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(date: string, field: string): void {
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
}

function normalizeResidency(input: OwnerResidencyInput): OwnerResidencyInput {
  const startDate = input.startDate?.trim();
  const endDate = input.endDate?.trim() || undefined;
  const jurisdiction = input.jurisdiction?.trim();
  if (!startDate) throw new Error('Residency start date is required');
  assertDate(startDate, 'Residency start date');
  if (endDate) {
    assertDate(endDate, 'Residency end date');
    if (endDate < startDate) throw new Error('Residency end date cannot be before its start date');
  }
  if (!jurisdiction) throw new Error('Residency jurisdiction is required');
  return { ...input, startDate, endDate, jurisdiction, region: input.region?.trim() || undefined, notes: input.notes?.trim() || undefined };
}

/** Reject inclusive-date overlaps, including a boundary day shared by two rows. */
export function validateResidencyRanges(rows: Pick<OwnerResidency, 'id' | 'startDate' | 'endDate'>[]): void {
  const sorted = [...rows].sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.id ?? 0) - (b.id ?? 0));
  for (const row of sorted) {
    assertDate(row.startDate, 'Residency start date');
    if (row.endDate) {
      assertDate(row.endDate, 'Residency end date');
      if (row.endDate < row.startDate) throw new Error('Residency end date cannot be before its start date');
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (!previous.endDate || current.startDate <= previous.endDate) {
      throw new Error(`Residency dates overlap: ${previous.startDate}–${previous.endDate ?? 'ongoing'} and ${current.startDate}–${current.endDate ?? 'ongoing'}`);
    }
  }
}

/** Gaps are valid; callers can show this returned list as a clear warning. */
export function findResidencyGaps(rows: Pick<OwnerResidency, 'id' | 'startDate' | 'endDate'>[]): Array<{ startDate: string; endDate?: string }> {
  validateResidencyRanges(rows);
  const sorted = [...rows].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const gaps: Array<{ startDate: string; endDate?: string }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const end = sorted[i - 1].endDate;
    if (!end) break;
    const next = new Date(`${end}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const startDate = next.toISOString().slice(0, 10);
    if (startDate < sorted[i].startDate) gaps.push({ startDate, endDate: dateBefore(sorted[i].startDate) });
  }
  return gaps;
}

function dateBefore(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export async function ensureDefaultOwner(): Promise<Owner> {
  const owners = await db.owners.toArray();
  const defaultOwner = owners.find((owner) => owner.isDefault);
  if (defaultOwner) return defaultOwner;
  const existing = owners.find((owner) => owner.name.trim().toLowerCase() === 'me');
  if (existing) {
    await db.owners.update(existing.id!, { isDefault: true });
    return { ...existing, isDefault: true };
  }
  if (owners.length) {
    const first = [...owners].sort((a, b) => a.createdAt - b.createdAt)[0];
    await db.owners.update(first.id!, { isDefault: true });
    return { ...first, isDefault: true };
  }
  const id = await db.owners.add({ name: 'Me', kind: 'person', isDefault: true, createdAt: Date.now() });
  return (await db.owners.get(id))!;
}

export async function createPolicyOwner(name: string, kind: OwnerKind = 'person'): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Owner name cannot be empty');
  const existing = await db.owners.where('name').equalsIgnoreCase(trimmed).first();
  if (existing) throw new Error('Owner already exists');
  return db.owners.add({ name: trimmed, kind, createdAt: Date.now() }) as Promise<number>;
}

export async function updatePolicyOwner(id: number, changes: Pick<Partial<Owner>, 'name' | 'kind'>): Promise<void> {
  const owner = await db.owners.get(id);
  if (!owner) throw new Error('Owner not found');
  const name = changes.name?.trim();
  if (changes.name !== undefined) {
    if (!name) throw new Error('Owner name cannot be empty');
    const existing = await db.owners.where('name').equalsIgnoreCase(name).first();
    if (existing && existing.id !== id) throw new Error('Owner already exists');
  }
  if (name && name !== owner.name) {
    await db.transaction('rw', db.owners, db.records, async () => {
      await db.owners.update(id, { ...changes, name });
      await propagateStringFieldRename('owner', owner.name, name);
    });
  } else await db.owners.update(id, { ...changes, ...(name ? { name } : {}) });
}

export async function getPolicyOwners(includeArchived = false): Promise<Owner[]> {
  await ensureDefaultOwner();
  const owners = await db.owners.toArray();
  return owners.filter((owner) => includeArchived || !owner.archivedAt).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getActiveOwnerSelectorOptions(): Promise<OwnerSelectorOption[]> {
  const owners = await getPolicyOwners();
  return [UNASSIGNED_OWNER_OPTION, ...owners.map((owner) => ({ value: owner.name, label: owner.name, ownerId: owner.id }))];
}

export async function createOwnerResidency(ownerId: number, input: OwnerResidencyInput): Promise<number> {
  if (!await db.owners.get(ownerId)) throw new Error('Owner not found');
  const normalized = normalizeResidency(input);
  const existing = await db.ownerResidencies.where('ownerId').equals(ownerId).toArray();
  validateResidencyRanges([...existing, { ...normalized }]);
  const now = Date.now();
  return db.ownerResidencies.add({ ownerId, ...normalized, createdAt: now, updatedAt: now }) as Promise<number>;
}

export async function updateOwnerResidency(id: number, input: OwnerResidencyInput): Promise<void> {
  const existing = await db.ownerResidencies.get(id);
  if (!existing) throw new Error('Owner residency not found');
  const normalized = normalizeResidency(input);
  const rows = await db.ownerResidencies.where('ownerId').equals(existing.ownerId).toArray();
  validateResidencyRanges(rows.filter((row) => row.id !== id).concat({ ...existing, ...normalized }));
  await db.ownerResidencies.update(id, { ...normalized, updatedAt: Date.now() });
}

export async function deleteOwnerResidency(id: number): Promise<void> {
  await db.ownerResidencies.delete(id);
}

export async function getOwnerResidencies(ownerId: number): Promise<OwnerResidency[]> {
  return (await db.ownerResidencies.where('ownerId').equals(ownerId).toArray())
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.id ?? 0) - (b.id ?? 0));
}

/** Date-only policy lookup; both residency endpoints are inclusive. */
export async function resolveOwnerPolicy(ownerId: number, disposalDate: string): Promise<OwnerPolicyResolution> {
  assertDate(disposalDate, 'Disposal date');
  const owner = await db.owners.get(ownerId);
  if (!owner) throw new Error('Owner not found');
  const residency = (await getOwnerResidencies(ownerId))
    .find((row) => row.startDate <= disposalDate && (!row.endDate || disposalDate <= row.endDate)) ?? null;
  return { owner, residency, matchingMethod: residency?.matchingMethod ?? 'fifo' };
}

/**
 * Archive only after all live origin batches bearing this owner's legacy label
 * have been reassigned. This deliberately reads the same ledger as the holdings
 * view, rather than treating stale address metadata as an open batch.
 */
export async function archivePolicyOwner(id: number): Promise<void> {
  const owner = await db.owners.get(id);
  if (!owner) throw new Error('Owner not found');
  if (owner.isDefault) {
    throw new Error('The default owner can be renamed but cannot be archived');
  }
  const ledger = await loadCoinOrigins();
  const open = ledger.outpoints.filter((batch) => batch.owner === owner.name);
  if (open.length) throw new Error(`Cannot archive ${owner.name}: ${open.length} open coin-origin batch${open.length === 1 ? '' : 'es'} must be reassigned first`);
  await db.owners.update(id, { archivedAt: Date.now() });
}

export async function getOwnerPolicySummary(ownerId: number): Promise<OwnerPolicySummary> {
  const owner = await db.owners.get(ownerId);
  if (!owner) throw new Error('Owner not found');
  const ledger = await loadCoinOrigins();
  const current = ledger.outpoints.filter((batch) => batch.owner === owner.name);
  const unassigned = ledger.outpoints.filter((batch) => !batch.owner?.trim());
  const lots = new Map(ledger.lots.map((lot) => [lot.lotId, lot]));
  const hopDate = new Map(ledger.hops.map((hop) => [hop.txid, hop.blockTime > 0 ? new Date(hop.blockTime * 1000).toISOString().slice(0, 10) : null]));
  const disposalDates = new Set<string>();
  for (const disposal of ledger.disposals) {
    if (!disposal.allocations.some((allocation) => lots.get(allocation.lotId)?.owner === owner.name)) continue;
    const date = hopDate.get(disposal.txid);
    if (date && !(await resolveOwnerPolicy(ownerId, date)).residency) disposalDates.add(date);
  }
  return {
    currentHoldingsSats: current.reduce((total, batch) => total + batch.amountSats, 0),
    currentBatchCount: current.length,
    unassignedBatchCount: unassigned.length,
    unassignedSats: unassigned.reduce((total, batch) => total + batch.amountSats, 0),
    disposalDatesOutsideResidency: [...disposalDates].sort(),
  };
}