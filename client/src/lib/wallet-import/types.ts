import type { Record as DBRecord } from '../database';

export type WalletType = 'trezor' | 'sparrow' | 'sparrow-bip329' | 'mycelium' | 'phoenix' | 'wallet-of-satoshi' | 'nunchuk' | 'unknown';
export type FileFormat = 'csv' | 'json' | 'jsonl' | 'bsms';
export type TransactionDirection = 'incoming' | 'outgoing' | 'self' | 'internal' | 'unknown';

export interface ParsedTransaction {
  txid: string;
  amount?: number;
  fee?: number;
  date?: string;
  label?: string;
  notes?: string;
  direction: TransactionDirection;
  addresses: string[];
  rawData?: { [key: string]: unknown };
}

export interface ParsedAddress {
  address: string;
  label?: string;
  derivationPath?: string;
  balance?: number;
}

export interface ParsedRecord {
  type: 'address' | 'transaction';
  inputString: string;
  label: string;
  notes?: string;
  amount?: number;
  date?: string;
  source?: string;
  direction?: TransactionDirection;
  isInputAddress?: boolean;
  derivationPath?: string;
  originalData?: { [key: string]: unknown };
}

export interface VaultMetadata {
  isVaultXpub: boolean;
  vaultName: string | null;
  m: number | null;
  n: number | null;
  vaultNotes: string | null;
}

export interface ImportOptions {
  sourceName: string;
  owner?: string;
  walletName?: string;
  defaultTags: string[];
  defaultCategories: string[];
  walletSoftware?: string;
  seedName?: string;
  markInputsAsVerified?: boolean;
  privateKeyStatus?: string;
  labelPrefix?: string;
  vault?: VaultMetadata;
}

export interface ImportResult {
  newRecords: number;
  updatedRecords: number;
  skippedRecords: number;
  failedRecords: number;
  errors: string[];
}

export interface DuplicateInfo {
  parsedRecord: ParsedRecord;
  existingRecord: DBRecord | null;
  isNew: boolean;
  willMerge: boolean;
}

export interface DetectionResult {
  walletType: WalletType;
  fileFormat: FileFormat;
  confidence: number;
  message?: string;
}

export interface ParseResult {
  success: boolean;
  records: ParsedRecord[];
  walletType: WalletType;
  fileFormat: FileFormat;
  errors: string[];
}

export interface WalletAdapter {
  name: string;
  walletType: WalletType;
  
  detectFormat(content: string, filename: string): DetectionResult;
  
  parse(content: string, fileFormat: FileFormat): ParseResult;
  
  getSupportedFormats(): FileFormat[];
}
