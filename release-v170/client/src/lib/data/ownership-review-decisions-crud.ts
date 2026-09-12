import type { OwnershipReviewDecision } from "@/lib/db-types";
import { getVaultRepository, type VaultRepository } from "@/lib/repository";

// Review decisions are intentionally accessed through the repository: desktop
// protected vaults must not bypass their guarded store for backup operations.
const PAGE_SIZE = 500;

export async function getAllOwnershipReviewDecisions(
  repository: VaultRepository = getVaultRepository(),
): Promise<OwnershipReviewDecision[]> {
  const rows: OwnershipReviewDecision[] = [];
  let cursor: string | number | undefined;
  do {
    const page = await repository.list("ownershipReviewDecisions", { cursor, limit: PAGE_SIZE });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

export async function clearOwnershipReviewDecisions(
  options: { repository?: VaultRepository } = {},
): Promise<void> {
  await (options.repository ?? getVaultRepository()).clear("ownershipReviewDecisions");
}

/** Inserts decisions by their evidence fingerprint, the stable natural identity. */
export async function restoreOwnershipReviewDecision(
  row: OwnershipReviewDecision,
  options: { repository?: VaultRepository } = {},
): Promise<void> {
  await (options.repository ?? getVaultRepository()).put("ownershipReviewDecisions", row);
}