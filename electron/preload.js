const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File system operations
  getAppDataPath: () => ipcRenderer.invoke('get-app-data-path'),
  getAttachmentsPath: () => ipcRenderer.invoke('get-attachments-path'),
  
  // Attachment operations
  saveAttachment: (identifier, filename, data) => 
    ipcRenderer.invoke('save-attachment', { identifier, filename, data }),
  readAttachment: (relativePath) => 
    ipcRenderer.invoke('read-attachment', relativePath),
  deleteAttachment: (relativePath) => 
    ipcRenderer.invoke('delete-attachment', relativePath),
  listAttachments: (identifier) => 
    ipcRenderer.invoke('list-attachments', identifier),
  
  // Platform information
  platform: process.platform,
  isElectron: true,
});
