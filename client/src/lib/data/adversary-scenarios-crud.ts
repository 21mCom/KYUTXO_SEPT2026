import { db, notifyDbChange, type AdversaryScenario } from '../database';
import { getVaultRepository } from '../repository';

// All writes to db.adversaryScenarios go through this module (mirrors the
// other lightweight CRUD modules like saved-psbts-crud / dust-flags-crud).

export type NewAdversaryScenario = Omit<AdversaryScenario, 'id' | 'createdAt' | 'updatedAt'>;

const FALLBACK_NAME = 'Untitled scenario';

/** Normalize a free-text list entry: keep non-empty strings, de-duped. */
function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function cleanName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : FALLBACK_NAME;
}

function cleanCounterparty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Natural identity of a scenario for merge de-dup: the user-visible
 * (name, counterparty) pair, case-insensitive. Two scenarios that agree on
 * both are "the same scenario" when merging a backup over an existing vault.
 */
export function adversaryScenarioIdentity(row: { name?: unknown; counterpartyName?: unknown }): string {
  return `${cleanName(row.name).toLowerCase()}${cleanCounterparty(row.counterpartyName).toLowerCase()}`;
}

/** Persist a new scenario. Returns the id. */
export async function saveAdversaryScenario(input: NewAdversaryScenario): Promise<number> {
  const now = Date.now();
  const row: AdversaryScenario = {
    name: cleanName(input.name),
    counterpartyName: cleanCounterparty(input.counterpartyName),
    knownAddresses: cleanStringList(input.knownAddresses),
    knownTxids: cleanStringList(input.knownTxids),
    createdAt: now,
    updatedAt: now,
  };
  const repository = getVaultRepository();
  const id = repository.kind === 'protected'
    ? await repository.add('adversaryScenarios', row)
    : await db.adversaryScenarios.add(row);
  notifyDbChange('adversaryScenarios');
  return id as number;
}

/** All scenarios, newest first. */
export async function getAllAdversaryScenarios(): Promise<AdversaryScenario[]> {
  const repository = getVaultRepository();
  const rows: AdversaryScenario[] = [];
  if (repository.kind === 'protected') {
    let cursor: string | number | undefined;
    do {
      const page = await repository.list('adversaryScenarios', { cursor, limit: 1000 });
      rows.push(...page.rows);
      cursor = page.cursor;
    } while (cursor !== undefined);
  } else rows.push(...await db.adversaryScenarios.toArray());
  return rows.sort((a, b) => b.createdAt - a.createdAt || (b.id ?? 0) - (a.id ?? 0));
}

/** Replace a scenario's editable fields (keeps createdAt, bumps updatedAt). */
export async function updateAdversaryScenario(
  id: number,
  input: NewAdversaryScenario,
): Promise<void> {
  const changes = {
    name: cleanName(input.name),
    counterpartyName: cleanCounterparty(input.counterpartyName),
    knownAddresses: cleanStringList(input.knownAddresses),
    knownTxids: cleanStringList(input.knownTxids),
    updatedAt: Date.now(),
  };
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.update('adversaryScenarios', id, changes);
  else await db.adversaryScenarios.update(id, changes);
  notifyDbChange('adversaryScenarios');
}

export async function deleteAdversaryScenario(id: number, options?: AdversaryScenarioWriteOptions): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.delete('adversaryScenarios', id);
  else await db.adversaryScenarios.delete(id);
  if (!options?.skipNotification) {
    notifyDbChange('adversaryScenarios');
  }
}

export interface AdversaryScenarioWriteOptions {
  skipNotification?: boolean;
}

export async function clearAdversaryScenarios(options?: AdversaryScenarioWriteOptions): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.clear('adversaryScenarios');
  else await db.adversaryScenarios.clear();
  if (!options?.skipNotification) {
    notifyDbChange('adversaryScenarios');
  }
}

export type AdversaryScenarioRestoreMode = 'merge' | 'replace';

/**
 * Restore adversary-scenario rows from a backup. SINGLE source of truth for
 * the backup restore path (v3 inline tables).
 *
 * The backup `id` is always stripped (every row gets a fresh autoincrement
 * id); rows carry no foreign keys into other tables (addresses/txids are
 * stable strings), so no id remap is needed. In MERGE mode a row whose
 * natural identity (name + counterparty, case-insensitive) already exists in
 * the vault is skipped so merging the same backup twice can't duplicate
 * scenarios; the seen-set also collapses duplicates within the incoming
 * backup itself.
 *
 * Returns the number of rows actually written.
 */
export async function restoreAdversaryScenarioRows(
  rows: any[] | undefined,
  restoreMode: AdversaryScenarioRestoreMode,
  options?: AdversaryScenarioWriteOptions,
  // Optional collector: every freshly inserted row's id is pushed here, so a
  // cancelled merge can undo exactly the rows this restore added.
  collect?: { insertedIds?: number[] },
): Promise<number> {
  if (!rows || rows.length === 0) return 0;

  const seen = new Set<string>();
  if (restoreMode === 'merge') {
    const existing = await getAllAdversaryScenarios();
    for (const e of existing) seen.add(adversaryScenarioIdentity(e));
  }

  const now = Date.now();
  const toAdd: AdversaryScenario[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const { id, ...d } = r;
    const key = adversaryScenarioIdentity(d);
    if (seen.has(key)) continue;
    seen.add(key);
    toAdd.push({
      name: cleanName(d.name),
      counterpartyName: cleanCounterparty(d.counterpartyName),
      knownAddresses: cleanStringList(d.knownAddresses),
      knownTxids: cleanStringList(d.knownTxids),
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : now,
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : now,
    });
  }

  if (toAdd.length > 0) {
    const repository = getVaultRepository();
    if (repository.kind === 'protected') {
      for (const row of toAdd) {
        const id = await repository.add('adversaryScenarios', row);
        if (collect?.insertedIds) collect.insertedIds.push(id as number);
      }
    } else {
      const newIds = await db.adversaryScenarios.bulkAdd(toAdd, { allKeys: true });
      if (collect?.insertedIds) {
        for (const id of newIds) collect.insertedIds.push(id as number);
      }
    }
    if (!options?.skipNotification) {
      notifyDbChange('adversaryScenarios');
    }
  }
  return toAdd.length;
}
