/**
 * Main-thread client for the SQLite-WASM prototype worker (Task #229).
 *
 * Wraps the worker with Comlink and exposes a typed API. Also owns the feature
 * flag (persisted preference) and the in-memory "active backend" switch used by
 * the participant repository to route queries.
 */
import * as Comlink from 'comlink';
import type {
  SqliteWorkerApi,
  InitResult,
  SeedProgress,
  SeedResult,
  SqliteStatus,
  StorageMode,
} from '../workers/sqlite-worker';
import type { TransactionParticipant } from './database';
import type { ParticipantRow } from '../workers/sqlite-worker';

export type { InitResult, SeedProgress, SeedResult, SqliteStatus, StorageMode };

const PREF_KEY = 'kyutxo-sqlite-prototype-enabled';

let worker: Worker | null = null;
let client: Comlink.Remote<SqliteWorkerApi> | null = null;
let initPromise: Promise<InitResult> | null = null;

// Runtime switch (not persisted). The page flips this to "sqlite" only AFTER
// seeding has completed so queries never hit an empty database.
let activeBackend: 'dexie' | 'sqlite' = 'dexie';

export function getActiveBackend(): 'dexie' | 'sqlite' {
  return activeBackend;
}

export function setActiveBackend(backend: 'dexie' | 'sqlite'): void {
  activeBackend = backend;
}

export function isSqlitePrototypeEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setSqlitePrototypeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, String(enabled));
  } catch {
    // ignore storage errors
  }
}

function getClient(): Comlink.Remote<SqliteWorkerApi> {
  if (!client) {
    worker = new Worker(new URL('../workers/sqlite-worker.ts', import.meta.url), {
      type: 'module',
    });
    client = Comlink.wrap<SqliteWorkerApi>(worker);
  }
  return client;
}

export async function ensureSqliteInit(): Promise<InitResult> {
  if (!initPromise) {
    initPromise = getClient().init();
  }
  return initPromise;
}

export async function getSqliteStatus(): Promise<SqliteStatus> {
  await ensureSqliteInit();
  return getClient().getStatus();
}

export async function seedSqlite(
  onProgress?: (p: SeedProgress) => void,
  options?: { force?: boolean }
): Promise<SeedResult> {
  await ensureSqliteInit();
  const cb = onProgress ? Comlink.proxy(onProgress) : undefined;
  return getClient().seedFromIndexedDB(cb, options);
}

export async function cancelSqliteSeeding(): Promise<void> {
  if (!client) return;
  return client.cancelSeeding();
}

function rowsToParticipants(rows: ParticipantRow[]): TransactionParticipant[] {
  return rows.map((r) => ({
    id: r.id,
    txid: r.txid,
    role: r.role,
    address: r.address,
    amount: r.amount,
    vout: r.vout ?? undefined,
    prevTxid: r.prevTxid ?? undefined,
    prevVout: r.prevVout ?? undefined,
    recordId: r.recordId ?? undefined,
    scriptType: (r.scriptType ?? undefined) as TransactionParticipant['scriptType'],
  }));
}

export async function sqliteGetParticipantsByTxids(
  txids: string[]
): Promise<TransactionParticipant[]> {
  await ensureSqliteInit();
  const rows = await getClient().getParticipantsByTxids(txids);
  return rowsToParticipants(rows);
}

export async function sqliteGetParticipantsByAddresses(
  addresses: string[]
): Promise<TransactionParticipant[]> {
  await ensureSqliteInit();
  const rows = await getClient().getParticipantsByAddresses(addresses);
  return rowsToParticipants(rows);
}

export async function sqliteCountParticipants(): Promise<number> {
  await ensureSqliteInit();
  return getClient().countParticipants();
}
