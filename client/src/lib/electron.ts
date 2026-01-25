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
  isPortableMode: () => Promise<boolean>;
  // Tor proxy operations
  torTest: (torProxyUrl?: string) => Promise<TorTestResult>;
  torRequest: (params: TorRequestParams) => Promise<TorRequestResult>;
  torStatus: () => Promise<TorStatusResult>;
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
