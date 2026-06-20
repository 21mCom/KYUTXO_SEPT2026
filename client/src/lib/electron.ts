// Tor proxy types
export interface TorTestResult {
  success: boolean;
  proxyUrl?: string;
  proxyName?: string;
  isTor?: boolean;
  torIp?: string;
  latency?: number;
  message?: string;
  error?: string;
  testedProxies?: string[];
}

// Electrum protocol types
export interface ElectrumTestParams {
  host: string;
  port: number;
  useSSL?: boolean;
  timeout?: number;
}

export interface ElectrumTestResult {
  success: boolean;
  serverVersion?: string;
  blockHeight?: number;
  latency?: number;
  message?: string;
  error?: string;
}

export interface ElectrumHistoryParams {
  host: string;
  port: number;
  useSSL?: boolean;
  address: string;
  timeout?: number;
}

export interface ElectrumHistoryItem {
  tx_hash: string;
  height: number;
  fee?: number;
}

export interface ElectrumHistoryResult {
  success: boolean;
  history: ElectrumHistoryItem[];
  error?: string;
}

export interface ElectrumUtxoParams {
  host: string;
  port: number;
  useSSL?: boolean;
  address: string;
  timeout?: number;
}

export interface ElectrumUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

export interface ElectrumUtxoResult {
  success: boolean;
  utxos: ElectrumUtxo[];
  error?: string;
}

export interface ElectrumTransactionParams {
  host: string;
  port: number;
  useSSL?: boolean;
  txid: string;
  verbose?: boolean;
  timeout?: number;
}

export interface ElectrumTransactionResult {
  success: boolean;
  transaction?: unknown;
  error?: string;
}

export interface ElectrumBatchHistoryParams {
  host: string;
  port: number;
  useSSL?: boolean;
  addresses: string[];
  timeout?: number;
}

export interface ElectrumBatchHistoryResult {
  success: boolean;
  results: Array<{
    address: string;
    success: boolean;
    history: ElectrumHistoryItem[];
    error?: string;
  }>;
  latency?: number;
  addressCount?: number;
  error?: string;
}

export interface TorRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  torProxyUrl?: string;
  allowedHost?: string;
  trustedLocalHosts?: string[];  // Whitelist of allowed local IPs/hostnames
}

export interface TorRequestResult {
  success: boolean;
  status?: number;
  statusText?: string;
  data?: unknown;
  latency?: number;
  contentType?: string;
  error?: string;
}

export interface TorProxyStatus {
  name: string;
  url: string;
  port: number;
  available: boolean;
  isTor?: boolean;
  exitIp?: string;
  latency?: number;
  error?: string;
}

export interface TorStatusResult {
  torAvailable: boolean;
  proxies: TorProxyStatus[];
  recommendation: string;
}

// Native read-engine IPC bridge (better-sqlite3 worker_thread, desktop only).
// Every channel returns a uniform { ok, result, error } envelope so the renderer
// never has to catch a rejected invoke. `result` is typed as `unknown` here to
// keep this module decoupled from engine-core; engine-client.ts casts on unwrap.
export interface EngineEnvelope<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

export interface EngineBridge {
  init: () => Promise<EngineEnvelope>;
  status: () => Promise<EngineEnvelope>;
  seedBegin: () => Promise<EngineEnvelope>;
  seedBatch: (table: string, rows: unknown[]) => Promise<EngineEnvelope>;
  seedFinish: (sourceCounts: Record<string, number>) => Promise<EngineEnvelope>;
  query: (name: string, args: unknown) => Promise<EngineEnvelope>;
  benchmark: () => Promise<EngineEnvelope>;
  reopen: () => Promise<EngineEnvelope>;
  integrityCheck: () => Promise<EngineEnvelope>;
  clear: () => Promise<EngineEnvelope>;
  generateSynthetic: (spec: unknown) => Promise<EngineEnvelope>;
  dbInfo: () => Promise<EngineEnvelope>;
  /**
   * Subscribe to pushed finalize-phase progress (index build → materialize →
   * verify). Present only in the desktop build; returns an unsubscribe fn.
   */
  onFinalizeProgress?: (cb: (progress: unknown) => void) => () => void;
}

// Type declarations for Electron API exposed via preload
interface ElectronAPI {
  getAppDataPath: () => Promise<string>;
  getAttachmentsPath: () => Promise<string>;
  getDataPath: () => Promise<string>;
  saveAttachment: (identifier: string, filename: string, data: ArrayBuffer) => Promise<{ success: boolean; path?: string; error?: string }>;
  readAttachment: (relativePath: string) => Promise<{ success: boolean; data?: ArrayBuffer; error?: string }>;
  deleteAttachment: (relativePath: string) => Promise<{ success: boolean; error?: string }>;
  listAttachments: (identifier: string) => Promise<{ success: boolean; files?: string[]; error?: string }>;
  // Backup/restore operations
  listAllAttachments: () => Promise<{ success: boolean; files?: string[]; error?: string }>;
  writeAttachment: (relativePath: string, data: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
  renameAttachment: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>;
  // Streaming backup writer (export) — chunks are written straight to disk.
  backupOpen: (suggestedName: string) => Promise<{ success: boolean; id?: string; filePath?: string; canceled?: boolean; error?: string }>;
  backupWrite: (id: string, data: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
  backupClose: (id: string) => Promise<{ success: boolean; error?: string }>;
  backupAbort: (id: string) => Promise<{ success: boolean; error?: string }>;
  isPortableMode: () => Promise<boolean>;
  // Tor proxy operations
  torTest: (torProxyUrl?: string) => Promise<TorTestResult>;
  torRequest: (params: TorRequestParams) => Promise<TorRequestResult>;
  torStatus: () => Promise<TorStatusResult>;
  // Electrum protocol operations
  electrumTest: (params: ElectrumTestParams) => Promise<ElectrumTestResult>;
  electrumGetHistory: (params: ElectrumHistoryParams) => Promise<ElectrumHistoryResult>;
  electrumGetUtxos: (params: ElectrumUtxoParams) => Promise<ElectrumUtxoResult>;
  electrumGetTransaction: (params: ElectrumTransactionParams) => Promise<ElectrumTransactionResult>;
  electrumBatchGetHistory: (params: ElectrumBatchHistoryParams) => Promise<ElectrumBatchHistoryResult>;
  platform: string;
  isElectron: boolean;
  // Native read-engine bridge (present only in the desktop build).
  engine: EngineBridge;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// Check if running in Electron
export function isElectron(): boolean {
  return typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
}

// Get the Electron API (throws if not in Electron)
export function getElectronAPI(): ElectronAPI {
  if (!isElectron()) {
    throw new Error('Not running in Electron');
  }
  return window.electronAPI!;
}

// Safe check for Electron API availability
export function getElectronAPISafe(): ElectronAPI | null {
  return isElectron() ? window.electronAPI! : null;
}
