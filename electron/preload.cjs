const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File system operations
  
  // Attachment operations
  saveAttachment: (identifier, filename, data) => 
    ipcRenderer.invoke('save-attachment', { identifier, filename, data }),
  readAttachment: (relativePath) => 
    ipcRenderer.invoke('read-attachment', relativePath),
  deleteAttachment: (relativePath) => 
    ipcRenderer.invoke('delete-attachment', relativePath),
  listAttachments: (identifier) => 
    ipcRenderer.invoke('list-attachments', identifier),
  
  // Backup/restore operations for attachments
  listAllAttachments: () => 
    ipcRenderer.invoke('list-all-attachments'),
  writeAttachment: (relativePath, data) => 
    ipcRenderer.invoke('write-attachment', { relativePath, data }),
  renameAttachment: (oldPath, newPath) =>
    ipcRenderer.invoke('rename-attachment', { oldPath, newPath }),

  // Free/total disk space on the attachments filesystem (pre-flight restore check).
  getDiskSpace: () =>
    ipcRenderer.invoke('get-disk-space'),

  // Total byte size of all attachment files (pre-flight export size estimate).
  getAttachmentsSize: () =>
    ipcRenderer.invoke('get-attachments-size'),

  // Orphaned-attachment review folder (populated during restore when an
  // attachment's owning record is absent — never linked to any record).
  writeNeedsReview: (filename, data) =>
    ipcRenderer.invoke('write-needs-review', { filename, data }),
  openNeedsReviewFolder: () =>
    ipcRenderer.invoke('open-needs-review-folder'),
  listNeedsReview: () =>
    ipcRenderer.invoke('list-needs-review'),
  readNeedsReview: (name) =>
    ipcRenderer.invoke('read-needs-review', { name }),
  deleteNeedsReview: (name) =>
    ipcRenderer.invoke('delete-needs-review', { name }),

  // One-click demo vault: probe for an on-disk kyutxo-demo-vault.zip (next to
  // the executable or in the data dir) and stream its bytes in fixed chunks.
  checkDemoVault: () => ipcRenderer.invoke('check-demo-vault'),
  readDemoVault: (offset) => ipcRenderer.invoke('read-demo-vault', { offset }),

  // Streaming backup writer (export): chunks go straight to disk, so the full
  // archive never has to be buffered in renderer memory.
  backupOpen: (suggestedName) => ipcRenderer.invoke('backup-open', { suggestedName }),
  backupWrite: (id, data) => ipcRenderer.invoke('backup-write', { id, data }),
  backupClose: (id) => ipcRenderer.invoke('backup-close', { id }),
  backupAbort: (id) => ipcRenderer.invoke('backup-abort', { id }),

  // Verified scheduled-backup sessions. The main process owns all paths and
  // exposes only an opaque session id while an archive is being built.
  chooseBackupFolder: () => ipcRenderer.invoke('choose-backup-folder'),
  scheduledBackupOpen: (destinationToken, suggestedName) =>
    ipcRenderer.invoke('scheduled-backup-open', { destinationToken, suggestedName }),
  scheduledBackupWrite: (id, data) =>
    ipcRenderer.invoke('scheduled-backup-write', { id, data }),
  scheduledBackupClose: (id) => ipcRenderer.invoke('scheduled-backup-close', { id }),
  scheduledBackupRead: (id, offset) =>
    ipcRenderer.invoke('scheduled-backup-read', { id, offset }),
  scheduledBackupValidate: (id, rendererChecksum) =>
    ipcRenderer.invoke('scheduled-backup-validate', { id, rendererChecksum }),
  scheduledBackupPromote: (id, finalName, rendererVerified) =>
    ipcRenderer.invoke('scheduled-backup-promote', { id, finalName, rendererVerified }),
  scheduledBackupAbort: (id) => ipcRenderer.invoke('scheduled-backup-abort', { id }),
  listScheduledBackups: (destinationToken) =>
    ipcRenderer.invoke('scheduled-backup-list', { destinationToken }),
  deleteScheduledBackup: (destinationToken, name) =>
    ipcRenderer.invoke('scheduled-backup-delete', { destinationToken, name }),
  getScheduledBackupDiskSpace: (destinationToken) =>
    ipcRenderer.invoke('scheduled-backup-disk-space', { destinationToken }),
  
  // Portable mode support
  isPortableMode: () => ipcRenderer.invoke('is-portable-mode'),
  
  // Tor proxy operations
  torTest: () => 
    ipcRenderer.invoke('tor-test'),
  torRequest: (params) => 
    ipcRenderer.invoke('tor-request', params),
  torStatus: () => 
    ipcRenderer.invoke('tor-status'),
  torUpdateSettings: (settings) =>
    ipcRenderer.invoke('tor-update-settings', settings),

  // Main-process lifecycle lock signal (suspend/resume, screen lock, idle).
  // Returns an unsubscribe function so React can cleanly replace listeners.
  onVaultLock: (callback) => {
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('vault-lock', listener);
    return () => ipcRenderer.removeListener('vault-lock', listener);
  },
  // Only the four lifecycle policy values cross this boundary. The main
  // process validates them and owns the actual power-monitor behavior.
  setVaultLockSettings: (settings) =>
    ipcRenderer.invoke('set-vault-lock-settings', settings),
  
  // Electrum protocol operations
  electrumTest: (params) =>
    ipcRenderer.invoke('electrum-test', params),
  electrumGetHistory: (params) =>
    ipcRenderer.invoke('electrum-get-history', params),
  electrumGetUtxos: (params) =>
    ipcRenderer.invoke('electrum-get-utxos', params),
  electrumGetTransaction: (params) =>
    ipcRenderer.invoke('electrum-get-transaction', params),
  electrumGetBlockHash: (params) =>
    ipcRenderer.invoke('electrum-get-block-hash', params),
  electrumCancel: (params) =>
    ipcRenderer.invoke('electrum-cancel', params),
  electrumBatchGetHistory: (params) =>
    ipcRenderer.invoke('electrum-batch-get-history', params),
  electrumBatchGetUtxos: (params) =>
    ipcRenderer.invoke('electrum-batch-get-utxos', params),
  electrumTrustCertificate: (params) =>
    ipcRenderer.invoke('electrum-trust-certificate', params),
  electrumGetCertificateTrust: (params) =>
    ipcRenderer.invoke('electrum-get-certificate-trust', params),
  electrumRevokeCertificate: (params) =>
    ipcRenderer.invoke('electrum-revoke-certificate', params),

  // Native read-engine (better-sqlite3 worker_thread). Fixed channels only —
  // no arbitrary SQL or file paths cross the bridge.
  engine: {
    init: () => ipcRenderer.invoke('engine:init'),
    status: () => ipcRenderer.invoke('engine:status'),
    seedBegin: () => ipcRenderer.invoke('engine:seedBegin'),
    seedBatch: (table, rows) => ipcRenderer.invoke('engine:seedBatch', { table, rows }),
    seedFinish: (sourceCounts) => ipcRenderer.invoke('engine:seedFinish', { sourceCounts }),
    query: (name, args) => ipcRenderer.invoke('engine:query', { name, args }),
    benchmark: () => ipcRenderer.invoke('engine:benchmark'),
    reopen: () => ipcRenderer.invoke('engine:reopen'),
    integrityCheck: () => ipcRenderer.invoke('engine:integrityCheck'),
    clear: () => ipcRenderer.invoke('engine:clear'),
    generateSynthetic: (spec) => ipcRenderer.invoke('engine:generateSynthetic', { spec }),
    dbInfo: () => ipcRenderer.invoke('engine:dbInfo'),
    // Pushed (main → renderer) finalize progress during the index/materialize/
    // verify phase. Returns an unsubscribe fn.
    onFinalizeProgress: (cb) => {
      const listener = (_event, progress) => cb(progress);
      ipcRenderer.on('engine:finalizeProgress', listener);
      return () => ipcRenderer.removeListener('engine:finalizeProgress', listener);
    },
  },

  // Platform information
  platform: process.platform,
  isElectron: true,
  // Electron runtime version — surfaced in the About screen.
  electronVersion: process.versions.electron,
});
