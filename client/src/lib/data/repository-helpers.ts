import { getVaultRepository } from '../repository';
import type { ProtectedRepositoryQueryName, VaultRows, VaultTableName } from '../repository';

const PAGE_SIZE = 1000;

/** Read every page deliberately; callers that need a bounded page use `list`. */
export async function listVaultRows<T extends VaultTableName>(table: T): Promise<VaultRows[T][]> {
  const repository = getVaultRepository();
  const rows: VaultRows[T][] = [];
  let cursor: string | number | undefined;
  do {
    const page = await repository.list(table, { cursor, limit: PAGE_SIZE });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

export async function queryVaultRows<T>(table: VaultTableName, name: ProtectedRepositoryQueryName, value: unknown, limit?: number): Promise<T[]> {
  return getVaultRepository().query<T>(table, name, value, limit);
}