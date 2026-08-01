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
// Every Electrum call accepts optional Tor routing: when `useTor` is set the
// socket is opened through the configured SOCKS proxy (or an auto-detected
// Tor proxy when `torProxyUrl` is omitted), which is also what makes .onion
// Electrum hosts reachable.
export interface ElectrumTorParams {
  useTor?: boolean;
  torProxyUrl?: string;
}

export interface ElectrumCertificateInfo {
  fingerprint: string;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  selfSigned?: boolean;
  // How the connection authenticated the server: 'ca' = verified against a
  // certificate authority, 'pinned' = matched the user's trusted fingerprint.
  trust?: 'ca' | 'pinned';
  // Set on CERT_FINGERPRINT_CHANGED failures: the fingerprint the user
  // previously trusted for this server.
  expectedFingerprint?: string;
}

export interface ElectrumTestParams extends ElectrumTorParams {
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
  // 'CERT_UNTRUSTED' (never seen this cert) or 'CERT_FINGERPRINT_CHANGED'
  // (cert differs from the trusted pin — possible MITM) on TLS trust failures.
  errorCode?: string;
  // Transport the connection used ('direct' | 'tor') plus the certificate the
  // server presented (on TLS connections, success or trust failure).
  transport?: 'direct' | 'tor';
  certificate?: ElectrumCertificateInfo;
}

export interface ElectrumTrustCertificateParams {
  host: string;
  port: number;
  certificate: ElectrumCertificateInfo;
}

export interface ElectrumTrustCertificateResult {
  success: boolean;
  pinned?: ElectrumCertificateInfo & { trustedAt?: number };
  error?: string;
}

export interface ElectrumGetCertificateTrustParams {
  host: string;
  port: number;
}

export interface ElectrumGetCertificateTrustResult {
  success: boolean;
  pinned: (ElectrumCertificateInfo & { trustedAt?: number }) | null;
  error?: string;
}

export interface ElectrumRevokeCertificateParams {
  host: string;
  port: number;
}
export interface ElectrumHistoryParams extends ElectrumTorParams {
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

export interface ElectrumUtxoParams extends ElectrumTorParams {
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

export interface ElectrumTransactionParams extends ElectrumTorParams {
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

export interface ElectrumBlockHashParams extends ElectrumTorParams {
  host: string;
  port: number;
  useSSL?: boolean;
  height: number;
  timeout?: number;
}

export interface ElectrumBlockHashResult {
  success: boolean;
  blockHash?: string;
  error?: string;
}

export interface ElectrumBatchHistoryParams extends ElectrumTorParams {
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

export interface ElectrumBatchUtxoParams extends ElectrumTorParams {
  host: string;
  port: number;
  useSSL?: boolean;
  addresses: string[];
  timeout?: number;
}

export interface ElectrumBatchUtxoResult {
  success: boolean;
  results: Array<{
    address: string;
    success: boolean;
    utxos: ElectrumUtxo[];
    error?: string;
  }>;
  latency?: number;
  addressCount?: number;
  error?: string;
}

// Per-request allowlist/proxy overrides were removed: the main process derives
// them from settings pushed via torUpdateSettings.
export interface TorRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface TorUpdateSettingsParams {
  customProviderUrl?: string;
  trustedLocalHosts?: string[];
  torProxyUrl?: string;
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

// One-click demo vault (presenters): probe/stream an on-disk copy of
// kyutxo-demo-vault.zip found next to the executable or in the data directory.
export interface DemoVaultCheckResult {
  present: boolean;
  path?: string;
  size?: number;
  error?: string;
}

export interface DemoVaultReadResult {
  success: boolean;
  data?: ArrayBuffer;
  bytesRead?: number;
  eof?: boolean;
  error?: string;
}

// One orphaned attachment file sitting in the Needs Review folder.
export interface NeedsReviewFile {
  name: string;
  size: number;
  // Epoch millis when the file was routed into the folder (file mtime).
  routedAt: number;
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
  listAllAttachments: () => Promise<{ success: boolean; files?: string[]; totalBytes?: number; error?: string }>;
  writeAttachment: (relativePath: string, data: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
  renameAttachment: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>;
  // Streaming backup writer (export) — chunks are written straight to disk.
  backupOpen: (suggestedName: string) => Promise<{ success: boolean; id?: string; filePath?: string; canceled?: boolean; error?: string }>;
  backupWrite: (id: string, data: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
  backupClose: (id: string) => Promise<{ success: boolean; error?: string }>;
  backupAbort: (id: string) => Promise<{ success: boolean; error?: string }>;
  // One-click demo vault (optional — older desktop builds lack these channels).
  checkDemoVault?: () => Promise<DemoVaultCheckResult>;
  readDemoVault?: (offset: number) => Promise<DemoVaultReadResult>;
  isPortableMode: () => Promise<boolean>;
  // Free/total disk space on the attachments filesystem (pre-flight restore check)
  getDiskSpace: () => Promise<{ success: boolean; freeBytes?: number; totalBytes?: number; error?: string }>;
  // Total byte size of all attachment files (pre-flight export size estimate)
  getAttachmentsSize: () => Promise<{ success: boolean; totalBytes?: number; fileCount?: number; error?: string }>;
  // Needs Review folder (orphaned restore attachments)
  getNeedsReviewPath: () => Promise<string>;
  writeNeedsReview: (originalFilename: string, data: ArrayBuffer) => Promise<{ success: boolean; path?: string; error?: string }>;
  openNeedsReviewFolder: () => Promise<{ success: boolean; error?: string }>;
  listNeedsReview: () => Promise<{ success: boolean; files?: NeedsReviewFile[]; error?: string }>;
  readNeedsReview: (name: string) => Promise<{ success: boolean; data?: ArrayBuffer; error?: string }>;
  deleteNeedsReview: (name: string) => Promise<{ success: boolean; error?: string }>;
  // Tor proxy operations
  torTest: () => Promise<TorTestResult>;
  torRequest: (params: TorRequestParams) => Promise<TorRequestResult>;
  torStatus: () => Promise<TorStatusResult>;
  torUpdateSettings: (settings: TorUpdateSettingsParams) => Promise<{ success: boolean; error?: string }>;
  // Electrum protocol operations
  electrumTest: (params: ElectrumTestParams) => Promise<ElectrumTestResult>;
  electrumGetHistory: (params: ElectrumHistoryParams) => Promise<ElectrumHistoryResult>;
  electrumGetUtxos: (params: ElectrumUtxoParams) => Promise<ElectrumUtxoResult>;
  electrumGetTransaction: (params: ElectrumTransactionParams) => Promise<ElectrumTransactionResult>;
  electrumGetBlockHash: (params: ElectrumBlockHashParams) => Promise<ElectrumBlockHashResult>;
  electrumBatchGetHistory: (params: ElectrumBatchHistoryParams) => Promise<ElectrumBatchHistoryResult>;
  electrumBatchGetUtxos: (params: ElectrumBatchUtxoParams) => Promise<ElectrumBatchUtxoResult>;
  electrumTrustCertificate: (params: ElectrumTrustCertificateParams) => Promise<ElectrumTrustCertificateResult>;
  electrumGetCertificateTrust: (params: ElectrumGetCertificateTrustParams) => Promise<ElectrumGetCertificateTrustResult>;
  electrumRevokeCertificate: (params: ElectrumRevokeCertificateParams) => Promise<ElectrumRevokeCertificateResult>;
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

export interface ElectrumRevokeCertificateResult {
  success: boolean;
  // True when a pin existed and was removed; false when nothing was pinned.
  revoked?: boolean;
  error?: string;
}
