import type { Record as DbRecord } from "./db-types";

/**
 * Pure, db-free grouping helpers shared between the balance/wallet overview
 * pages and the CRUD layer that fetches a single group's rows on demand. Keeping
 * these here (no Dexie import) lets both the UI aggregation pass and the
 * record-crud lookups agree on exactly how an address record maps to groups.
 */
export type GroupBy = "wallet" | "seed" | "owner" | "tag" | "category";

/** The bucket name used for records missing a value for the given grouping. */
export const GROUP_EMPTY_KEY: Record<GroupBy, string> = {
  wallet: "Unassigned",
  seed: "Unassigned",
  owner: "Unassigned",
  tag: "Untagged",
  category: "Uncategorized",
};

export function getGroupKeys(record: DbRecord, groupBy: GroupBy): string[] {
  switch (groupBy) {
    case "wallet":
      return [record.walletName || GROUP_EMPTY_KEY.wallet];
    case "seed":
      return [record.seedName || GROUP_EMPTY_KEY.seed];
    case "owner":
      return [record.owner || GROUP_EMPTY_KEY.owner];
    case "tag":
      return record.tags && record.tags.length > 0 ? record.tags : [GROUP_EMPTY_KEY.tag];
    case "category":
      return record.categories && record.categories.length > 0 ? record.categories : [GROUP_EMPTY_KEY.category];
  }
}

export function addressMatchesGroup(record: DbRecord, groupBy: GroupBy, groupKey: string): boolean {
  return getGroupKeys(record, groupBy).includes(groupKey);
}

/** Lightweight per-address row used when a group is expanded. */
export interface AddressBalanceRow {
  id: number;
  address: string;
  sats: number;
  utxoCount: number;
  label?: string;
}
