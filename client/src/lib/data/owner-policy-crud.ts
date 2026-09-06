// Compatibility-facing owner policy API. Keep the persistence vocabulary here
// so settings and later annotation/reporting callers share the same rules.
import {
  archivePolicyOwner,
  createOwnerResidency,
  createPolicyOwner,
  deleteOwnerResidency,
  ensureDefaultOwner,
  getOwnerPolicySummary,
  getOwnerResidencies,
  getPolicyOwners,
  updateOwnerResidency,
  updatePolicyOwner,
  type OwnerResidencyInput,
} from './owner-policy';
import type { Owner, OwnerKind, OwnerMatchingMethod } from '../database';

type ScreenResidency = {
  ownerId: number;
  jurisdiction: string;
  region?: string | null;
  notes?: string | null;
  startsOn: string;
  endsOn?: string | null;
  matchingMethod: OwnerMatchingMethod;
};

const toInput = (row: Omit<ScreenResidency, 'ownerId'>): OwnerResidencyInput => ({
  startDate: row.startsOn,
  endDate: row.endsOn ?? undefined,
  jurisdiction: row.jurisdiction,
  region: row.region ?? undefined,
  notes: row.notes ?? undefined,
  matchingMethod: row.matchingMethod,
});

export { ensureDefaultOwner };
export async function listOwnerPolicies(): Promise<Array<Owner & { id: number; isDefault?: boolean }>> {
  return (await getPolicyOwners(true)).map((owner) => ({
    ...owner,
    id: owner.id!,
    isDefault: owner.isDefault === true,
  }));
}
export const createOwnerPolicy = (input: { name: string; kind: OwnerKind; defaultMatchingMethod?: OwnerMatchingMethod }) =>
  createPolicyOwner(input.name, input.kind, input.defaultMatchingMethod);
export const updateOwnerPolicy = (
  id: number,
  input: { name: string; kind: OwnerKind; defaultMatchingMethod?: OwnerMatchingMethod },
) => updatePolicyOwner(id, input);
export const archiveOwnerPolicy = archivePolicyOwner;
export async function listResidencies(ownerId: number) {
  return (await getOwnerResidencies(ownerId)).map((row) => ({
    ...row,
    startsOn: row.startDate,
    endsOn: row.endDate ?? null,
  }));
}
export const createResidency = (input: ScreenResidency) => createOwnerResidency(input.ownerId, toInput(input));
export const updateResidency = (id: number, input: Omit<ScreenResidency, 'ownerId'>) => updateOwnerResidency(id, toInput(input));
export const deleteResidency = deleteOwnerResidency;
export async function getOwnerPolicySummaries() {
  const owners = await getPolicyOwners(true);
  return Promise.all(owners.map(async (owner) => {
    const summary = await getOwnerPolicySummary(owner.id!);
    return {
      ownerId: owner.id!,
      currentHoldings: summary.currentHoldingsSats,
      // Unassigned is vault-wide, not owner-specific. Attach it exactly once
      // for the aggregate settings contract (the stable default owner).
      unassignedBatches: owner.isDefault ? summary.unassignedBatchCount : 0,
      disposalsOutsideResidency: summary.disposalDatesOutsideResidency.length,
    };
  }));
}