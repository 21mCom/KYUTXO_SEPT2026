import { notifyDbChange } from '../database';
import { getVaultRepository } from '../repository';
import type { CleanupDeleteRecordResult } from '../repository/contracts';

/**
 * Remove a cleanup candidate and its origin ledger as one unit. Packaged
 * vaults delegate the transaction to SQLCipher; browser/development retains
 * the equivalent Dexie transaction.
 */
export async function deleteCleanupRecordWithOrigins(recordId: number): Promise<boolean> {
  const repository = getVaultRepository();
  let deleted: boolean;
  const result = await repository.command<CleanupDeleteRecordResult>(
    'cleanup.deleteRecordWithOrigins',
    { recordId },
  );
  deleted = result.deleted;
  if (deleted) notifyDbChange(['records', 'recordOrigins']);
  return deleted;
}