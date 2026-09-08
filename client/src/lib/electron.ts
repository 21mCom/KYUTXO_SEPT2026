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

export interface DesktopLockSettings {
  idleTimeoutSeconds: number;
  lockOnSuspend: boolean;
  lockOnResume: boolean;
  lockOnScreenLock: boolean;
}

export interface DesktopLockSettingsResult {
  success: boolean;
  error?: string;
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
  // Optional cancellation group id: an electrumCancel({ cancelId }) call
  // aborts every in-flight request registered under the same id.
  cancelId?: string;
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
  // Optional cancellation group id (see ElectrumHistoryParams.cancelId).
  cancelId?: string;
}

export interface ElectrumCancelParams {
  cancelId: string;
}

export interface ElectrumCancelResult {
  success: boolean;
  aborted?: number;
  error?: string;
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
  // Optional cancellation group id (see ElectrumHistoryParams.cancelId).
  cancelId?: string;
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
  // Optional cancellation group id (see ElectrumHistoryParams.cancelId).
  cancelId?: string;
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
  /** Omitted by newer desktop builds: proxy URLs stay out of IPC payloads. */
  url?: string;
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

export interface ProtectedStoreStatus {
  mode: 'protected' | 'plaintext-fallback';
  available: boolean;
  exists: boolean;
  unlocked: boolean;
  verified?: boolean;
  /**
   * Optional explicit readiness bit for newer protected-store workers. Older
   * workers express the same condition with available/unlocked/verified.
   */
  ready?: boolean;
  version: number;
}
export interface DemoVaultCheckResult {
  present: boolean;
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
  protectedStore: ProtectedStoreBridge;
  saveAttachment: (identifier: string, filename: string, data: ArrayBuffer) => Promise<{ success: boolean; path?: string; error?: string }>;
  readAttachment: (relativePath: string) => Promise<{ success: boolean; data?: ArrayBuffer; error?: string }>;
  deleteAttachment: (relativePath: string) => Promise<{ success: boolean; error?: string }>;
  listAttachments: (identifier: string) => Promise<{ success: boolean; files?: string[]; error?: string }>;
  // Backup/restore operations
  listAllAttachments: (cursor?: string | null, limit?: number) => Promise<{ success: boolean; files?: string[]; total?: number; totalBytes?: number; fingerprint?: string; cursor?: string | null; error?: string }>;
  closeAttachmentListing: (cursor: string) => Promise<{ success: boolean; error?: string }>;
  // `code: "ATTACHMENT_TOO_LARGE"` marks a size-cap rejection so the restore
  // writer can skip just that file (parity with the web endpoint's HTTP 413).
  writeAttachment: (relativePath: string, data: ArrayBuffer) => Promise<{ success: boolean; code?: string; error?: string }>;
  renameAttachment: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>;
  // Streaming backup writer (export) — chunks are written straight to disk.
  backupOpen: (suggestedName: string) => Promise<{ success: boolean; id?: string; canceled?: boolean; error?: string }>;
  backupWrite: (id: string, data: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
  backupClose: (id: string) => Promise<{ success: boolean; error?: string }>;
  backupAbort: (id: string) => Promise<{ success: boolean; error?: string }>;
  // Scheduled backups use an opaque main-process file session. The renderer
  // never receives a file descriptor or opens an arbitrary local path.
  chooseBackupFolder?: () => Promise<{ success: boolean; token?: string; label?: string; path?: string; canceled?: boolean; error?: string }>;
  scheduledBackupOpen?: (destinationToken: string, suggestedName: string) => Promise<{ success: boolean; id?: string; error?: string }>;
  scheduledBackupWrite?: (id: string, data: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
  scheduledBackupClose?: (id: string) => Promise<{ success: boolean; sizeBytes?: number; checksum?: string; error?: string }>;
  scheduledBackupRead?: (id: string, offset: number) => Promise<{ success: boolean; data?: ArrayBuffer; bytesRead?: number; eof?: boolean; error?: string }>;
  scheduledBackupValidate?: (id: string, rendererChecksum: string) => Promise<{ success: boolean; sizeBytes?: number; checksum?: string; error?: string }>;
  scheduledBackupPromote?: (id: string, finalName: string, rendererVerified: boolean) => Promise<{ success: boolean; name?: string; sizeBytes?: number; checksum?: string; error?: string }>;
  scheduledBackupAbort?: (id: string) => Promise<{ success: boolean; error?: string }>;
  listScheduledBackups?: (destinationToken: string) => Promise<{ success: boolean; files?: ScheduledBackupFile[]; invalidFiles?: ScheduledBackupFile[]; error?: string }>;
  deleteScheduledBackup?: (destinationToken: string, name: string) => Promise<{ success: boolean; error?: string }>;
  getScheduledBackupDiskSpace?: (destinationToken: string) => Promise<{ success: boolean; freeBytes?: number; error?: string }>;
  // One-click demo vault (optional — older desktop builds lack these channels).
  checkDemoVault?: () => Promise<DemoVaultCheckResult>;
  readDemoVault?: (offset: number) => Promise<DemoVaultReadResult>;
  isPortableMode: () => Promise<boolean>;
  // Free/total disk space on the attachments filesystem (pre-flight restore check)
  getDiskSpace: () => Promise<{ success: boolean; freeBytes?: number; totalBytes?: number; error?: string }>;
  // Total byte size of all attachment files (pre-flight export size estimate)
  getAttachmentsSize: () => Promise<{ success: boolean; totalBytes?: number; fileCount?: number; fingerprint?: string; error?: string }>;
  // Needs Review folder (orphaned restore attachments)
  writeNeedsReview: (originalFilename: string, data: ArrayBuffer) => Promise<{ success: boolean; savedName?: string; error?: string; code?: string }>;
  openNeedsReviewFolder: () => Promise<{ success: boolean; error?: string }>;
  listNeedsReview: () => Promise<{ success: boolean; files?: NeedsReviewFile[]; error?: string }>;
  readNeedsReview: (name: string) => Promise<{ success: boolean; data?: ArrayBuffer; error?: string }>;
  deleteNeedsReview: (name: string) => Promise<{ success: boolean; error?: string }>;
  // Tor proxy operations
  torTest: () => Promise<TorTestResult>;
  torRequest: (params: TorRequestParams) => Promise<TorRequestResult>;
  torStatus: () => Promise<TorStatusResult>;
  torUpdateSettings: (settings: TorUpdateSettingsParams) => Promise<{ success: boolean; error?: string }>;
  setVaultLockSettings?: (settings: DesktopLockSettings) => Promise<DesktopLockSettingsResult>;
  onVaultLock?: (callback: (detail: { reason?: string }) => void) => () => void;
  // Electrum protocol operations
  electrumTest: (params: ElectrumTestParams) => Promise<ElectrumTestResult>;
  electrumGetHistory: (params: ElectrumHistoryParams) => Promise<ElectrumHistoryResult>;
  electrumGetUtxos: (params: ElectrumUtxoParams) => Promise<ElectrumUtxoResult>;
  electrumGetTransaction: (params: ElectrumTransactionParams) => Promise<ElectrumTransactionResult>;
  electrumGetBlockHash: (params: ElectrumBlockHashParams) => Promise<ElectrumBlockHashResult>;
  // Optional: older preloads may not expose it, so callers must feature-check.
  electrumCancel?: (params: ElectrumCancelParams) => Promise<ElectrumCancelResult>;
  electrumBatchGetHistory: (params: ElectrumBatchHistoryParams) => Promise<ElectrumBatchHistoryResult>;
  electrumBatchGetUtxos: (params: ElectrumBatchUtxoParams) => Promise<ElectrumBatchUtxoResult>;
  electrumTrustCertificate: (params: ElectrumTrustCertificateParams) => Promise<ElectrumTrustCertificateResult>;
  electrumGetCertificateTrust: (params: ElectrumGetCertificateTrustParams) => Promise<ElectrumGetCertificateTrustResult>;
  electrumRevokeCertificate: (params: ElectrumRevokeCertificateParams) => Promise<ElectrumRevokeCertificateResult>;
  platform: string;
  isElectron: boolean;
  // Electron runtime version string (e.g. "43.4.0"), present only in the
  // desktop build. Absent in older preloads — callers must guard for undefined.
  electronVersion?: string;
  // Native read-engine bridge (present only in the desktop build).
  engine: EngineBridge;
}

export interface ScheduledBackupFile {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
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

export interface ProtectedStoreBridge {
  status: () => Promise<EngineEnvelope<ProtectedStoreStatus>>;
  create: (password: string) => Promise<EngineEnvelope<{ mode: 'protected'; verified: true; unlocked: true }>>;
  unlock: (password: string) => Promise<EngineEnvelope<{ mode: 'protected'; verified: true; unlocked: true }>>;
  lock: () => Promise<EngineEnvelope<{ unlocked: false }>>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<EngineEnvelope<{ changed: true }>>;
  integrity: () => Promise<EngineEnvelope<{ ok: true }>>;
  repository: {
    save: (collection: string, row: unknown) => Promise<EngineEnvelope<{ id: string | number }>>;
    find: (collection: string, id: string | number) => Promise<EngineEnvelope<unknown | null>>;
    page: (
      collection: string,
      after: string | number | undefined,
      limit: number,
      direction?: 'asc' | 'desc',
    ) => Promise<EngineEnvelope<{ items: unknown[]; next: string | number | null }>>;
    remove: (collection: string, id: string | number) => Promise<EngineEnvelope<{ deleted: boolean }>>;
    saveBatch: (collection: string, rows: unknown[]) => Promise<EngineEnvelope<{ ids: Array<string | number> }>>;
    removeBatch: (collection: string, ids: Array<string | number>) => Promise<EngineEnvelope<{ deleted: number }>>;
    count: (collection: string) => Promise<EngineEnvelope<{ count: number }>>;
    clear: (collection: string) => Promise<EngineEnvelope<{ deleted: number }>>;
    batch: (
      collection: string,
      operations: Array<{ operation: 'save'; row: unknown } | { operation: 'remove'; id: string | number }>,
    ) => Promise<EngineEnvelope<{ results: Array<{ operation: string; id?: string | number; deleted?: boolean }> }>>;
    query: (collection: string, name: string, value: unknown, limit?: number) => Promise<EngineEnvelope<{ items: unknown[] }>>;
    command: (name: string, value: unknown) => Promise<EngineEnvelope<unknown>>;
    deleteOrArchiveRecords: (command: { recordIds: number[]; mode: 'delete' | 'archive'; archivedAt?: number; archiveReason?: string }) => Promise<EngineEnvelope<{ deleted: number; archived: number }>>;
    saveTransactionWithParticipants: (transaction: unknown, participants: unknown[], replaceParticipants?: boolean) => Promise<EngineEnvelope<{ transactionId: string | number; participantIds: Array<string | number> }>>;
    saveSettingsWithHistory: (settings: unknown, historyEntry?: unknown, retainHistory?: number) => Promise<EngineEnvelope<{ settingsId: string | number; historyId?: string | number; retainedHistory: number }>>;
    clearVault: () => Promise<EngineEnvelope<{ deleted: number }>>;
    restoreCommit: (replaceExisting: boolean, rows: object) => Promise<EngineEnvelope<{ saved: number }>>;
    commitOwnershipReview: (command: unknown) => Promise<EngineEnvelope<unknown>>;
    ownerCostBasisPage: (options: { selectedOwner?: string; limit?: number; expectedCheckpointKey?: string }) => Promise<EngineEnvelope<import('./owner-cost-basis-core').OwnerCostBasisPage>>;
    ownerCostBasisProjection: (addresses: string[]) => Promise<EngineEnvelope<import('./repository/contracts').OwnerCostBasisProjectionResult>>;
  };
  writeAttachment: (bytes: ArrayBuffer, alias?: string) => Promise<EngineEnvelope<{ id: string; name: string; alias?: string; size: number }>>;
  readAttachment: (name: string, id: string) => Promise<EngineEnvelope<ArrayBuffer>>;
  deleteAttachment: (name: string) => Promise<EngineEnvelope<{ deleted: true }>>;
  listAttachments: () => Promise<EngineEnvelope<Array<{ alias: string; size: number }>>>;
  renameAttachment: (oldAlias: string, newAlias: string) => Promise<EngineEnvelope<{ renamed: true }>>;
}
