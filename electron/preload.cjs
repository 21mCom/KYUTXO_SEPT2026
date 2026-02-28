const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File system operations
  getAppDataPath: () => ipcRenderer.invoke('get-app-data-path'),
  getAttachmentsPath: () => ipcRenderer.invoke('get-attachments-path'),
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
  
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
  
  // Portable mode support
  isPortableMode: () => ipcRenderer.invoke('is-portable-mode'),
  
  // Tor proxy operations
  torTest: (torProxyUrl) => 
    ipcRenderer.invoke('tor-test', { torProxyUrl }),
  torRequest: (params) => 
    ipcRenderer.invoke('tor-request', params),
  torStatus: () => 
    ipcRenderer.invoke('tor-status'),
  
  // Electrum protocol operations
  electrumTest: (params) =>
    ipcRenderer.invoke('electrum-test', params),
  electrumGetHistory: (params) =>
    ipcRenderer.invoke('electrum-get-history', params),
  electrumGetUtxos: (params) =>
    ipcRenderer.invoke('electrum-get-utxos', params),
  electrumGetTransaction: (params) =>
    ipcRenderer.invoke('electrum-get-transaction', params),
  electrumBatchGetHistory: (params) =>
    ipcRenderer.invoke('electrum-batch-get-history', params),
  
  // Platform information
  platform: process.platform,
  isElectron: true,
});
