/**
 * Main-thread client for the KYUTXO SQLite read-engine worker (Task #271).
 *
 * Owns the Worker + Comlink wiring and exposes a typed, promise-based API. Also
 * best-effort requests durable storage from the window (StorageManager.persist()
 * is window-only in most browsers; the worker reads back persisted()/estimate()).
 *
 * This is an ISOLATED engine surface — it does not touch the live Dexie data
 * paths. Screens are ported onto it only after the foundation is proven at scale.
 */
import * as Comlink from 'comlink';
import type {
  EngineWorkerApi,
  InitResult,
  EngineStatus,
  SeedProgress,
  SeedResult,
  QueryBenchmarkResult,
  StorageMode,
  StorageEstimate,
} from '../../workers/engine-worker';
import type {
  RecordRow,
  RecordPageOptions,
  RecordQueryOptions,
  AddressAggregate,
  OwnedUtxo,
  ParticipantRow,
  SeedMeta,
  MirrorTable,
  SyntheticSpec,
} from './engine-core';

export type {
  InitResult,
  EngineStatus,
  SeedProgress,
  SeedResult,
  QueryBenchmarkResult,
  StorageMode,
  StorageEstimate,
  RecordRow,
  RecordPageOptions,
  RecordQueryOptions,
  AddressAggregate,
  OwnedUtxo,
  ParticipantRow,
  SeedMeta,
  MirrorTable,
  SyntheticSpec,
};

let worker: Worker | null = null;
let client: Comlink.Remote<EngineWorkerApi> | null = null;
let initPromise: Promise<InitResult> | null = null;

function getClient(): Comlink.Remote<EngineWorkerApi> {
  if (!client) {
    worker = new Worker(new URL('../../workers/engine-worker.ts', import.meta.url), {
      type: 'module',
    });
    client = Comlink.wrap<EngineWorkerApi>(worker);
  }
  return client;
}

/** Best-effort durable-storage request (window-only API). */
async function requestPersistence(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!already) await navigator.storage.persist();
    }
  } catch {
    /* ignore — worker reports the actual persisted state */
  }
}

export async function ensureEngineInit(): Promise<InitResult> {
  if (!initPromise) {
    initPromise = (async () => {
      await requestPersistence();
      return getClient().init();
    })();
  }
  return initPromise;
}

export async function getEngineStatus(): Promise<EngineStatus> {
  await ensureEngineInit();
  return getClient().getStatus();
}

export async function seedTable(
  table: MirrorTable,
  onProgress?: (p: SeedProgress) => void,
): Promise<SeedResult> {
  await ensureEngineInit();
  const cb = onProgress ? Comlink.proxy(onProgress) : undefined;
  return getClient().seedTable(table, cb);
}

export async function seedAll(onProgress?: (p: SeedProgress) => void): Promise<SeedResult[]> {
  await ensureEngineInit();
  const cb = onProgress ? Comlink.proxy(onProgress) : undefined;
  return getClient().seedAll(cb);
}

export async function cancelSeeding(): Promise<void> {
  if (!client) return;
  return client.cancelSeeding();
}

export async function reopenAndVerify(): Promise<{
  storageMode: StorageMode;
  before: number;
  after: number;
  fileStats: { pageCount: number; pageSize: number; freelistCount: number; sizeBytes: number };
}> {
  await ensureEngineInit();
  return getClient().reopenAndVerify();
}

export async function generateSynthetic(
  spec: SyntheticSpec,
): Promise<{ records: number; transactions: number; participants: number }> {
  await ensureEngineInit();
  return getClient().generateSynthetic(spec);
}

export async function runQueryBenchmark(): Promise<QueryBenchmarkResult[]> {
  await ensureEngineInit();
  return getClient().runQueryBenchmark();
}

export async function clearEngine(): Promise<void> {
  await ensureEngineInit();
  return getClient().clearAll();
}

// ---- Query passthrough ----------------------------------------------------

export async function engineGetRecordPage(opts: RecordPageOptions): Promise<RecordRow[]> {
  await ensureEngineInit();
  return getClient().getRecordPage(opts);
}

export async function engineCountRecords(opts: RecordQueryOptions = {}): Promise<number> {
  await ensureEngineInit();
  return getClient().countRecords(opts);
}

export async function engineGetAddressAggregates(addresses: string[]): Promise<AddressAggregate[]> {
  await ensureEngineInit();
  return getClient().getAddressAggregates(addresses);
}

export async function engineGetOwnedUtxos(opts: {
  tiers?: string[];
  afterId?: number;
  limit: number;
}): Promise<OwnedUtxo[]> {
  await ensureEngineInit();
  return getClient().getOwnedUtxos(opts);
}

export async function engineCountOwnedUtxos(tiers?: string[]): Promise<number> {
  await ensureEngineInit();
  return getClient().countOwnedUtxos(tiers);
}

export async function engineGetParticipantsByTxids(txids: string[]): Promise<ParticipantRow[]> {
  await ensureEngineInit();
  return getClient().getParticipantsByTxids(txids);
}

export async function engineGetParticipantsByAddresses(addresses: string[]): Promise<ParticipantRow[]> {
  await ensureEngineInit();
  return getClient().getParticipantsByAddresses(addresses);
}
