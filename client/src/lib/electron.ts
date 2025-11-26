// Type declarations for Electron API exposed via preload
interface ElectronAPI {
  getAppDataPath: () => Promise<string>;
  getAttachmentsPath: () => Promise<string>;
  saveAttachment: (identifier: string, filename: string, data: ArrayBuffer) => Promise<{ success: boolean; path?: string; error?: string }>;
  readAttachment: (relativePath: string) => Promise<{ success: boolean; data?: ArrayBuffer; error?: string }>;
  deleteAttachment: (relativePath: string) => Promise<{ success: boolean; error?: string }>;
  listAttachments: (identifier: string) => Promise<{ success: boolean; files?: string[]; error?: string }>;
  platform: string;
  isElectron: boolean;
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
