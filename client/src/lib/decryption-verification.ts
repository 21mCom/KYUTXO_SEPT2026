// TEMPORARY DIAGNOSTIC MODULE
// ---------------------------------------------------------------------------
// This file powers the temporary "Decryption Verification" panel and is meant
// to be deleted once the user is confident the legacy-decrypt migration ran
// to completion across their dataset. It is purely read-only and must not
// modify any data.
// ---------------------------------------------------------------------------

import { db } from './database';
import { isElectron, getElectronAPI } from './electron';
import { getLegacyDecryptTableConfigs } from './legacy-decrypt';

const ROW_BATCH_SIZE = 200;
const FILE_BATCH_YIELD_EVERY = 5;
const MIN_LEGACY_CIPHERTEXT_LEN = 44;
const MIN_ENCRYPTED_FILE_LEN = 28;
const SAMPLE_LIMIT = 5;

export class ScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled');
    this.name = 'ScanCancelledError';
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanCancelledError();
}

async function yieldToEventLoop() {
  await new Promise<void>((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Heuristic: does the given string look like a leftover legacy AES-GCM
 * ciphertext blob? The original encryptor produced base64 of (12-byte IV +
 * ciphertext + 16-byte auth tag), so the minimum length for any payload is
 * 28 bytes raw → ~40 base64 chars. We bump that to 44 chars to avoid false
 * positives on short identifiers, and we additionally require at least one
 * `+`, `/` or `=` so that pure-alphanumeric values (txids, addresses,
 * derivation paths, words, etc.) don't trip the check.
 */
export function looksLikeLegacyCiphertext(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length < MIN_LEGACY_CIPHERTEXT_LEN) return false;
  if (!BASE64_RE.test(value)) return false;
  if (!/[+/=]/.test(value)) return false;
  return true;
}

const LEGACY_MARKER_KEYS = ['_legacyEncryptedPayload', 'isEncrypted', 'encryptedPayload'] as const;

function hasLegacyMarker(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  for (const key of LEGACY_MARKER_KEYS) {
    if (r[key] !== undefined && r[key] !== null && r[key] !== false && r[key] !== '') {
      return true;
    }
  }
  return false;
}

function rowHasSuspiciousField(row: unknown, fields: string[]): boolean {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  for (const f of fields) {
    if (looksLikeLegacyCiphertext(r[f])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Table scanner
// ---------------------------------------------------------------------------

export interface TableScanResult {
  tableName: string;
  totalRows: number;
  markerRows: number;
  suspiciousFieldRows: number;
  sampleMarkerIds: string[];
  sampleSuspiciousIds: string[];
  sensitiveFields: string[];
  error?: string;
}

export interface TableScanProgress {
  phase: 'tables';
  tableName: string;
  tableIndex: number;
  tableCount: number;
  rowsScanned: number;
  totalRowsInTable: number;
}

export async function scanTablesForEncryption(
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: TableScanProgress) => void;
  },
): Promise<TableScanResult[]> {
  const signal = options?.signal;
  const onProgress = options?.onProgress;
  const configs = getLegacyDecryptTableConfigs();
  const results: TableScanResult[] = [];

  for (let i = 0; i < configs.length; i++) {
    throwIfAborted(signal);
    const cfg = configs[i];
    const sensitiveFieldNames = (cfg.sensitiveFields as unknown[]).map(String);

    const result: TableScanResult = {
      tableName: cfg.name,
      totalRows: 0,
      markerRows: 0,
      suspiciousFieldRows: 0,
      sampleMarkerIds: [],
      sampleSuspiciousIds: [],
      sensitiveFields: sensitiveFieldNames,
    };

    try {
      result.totalRows = await cfg.table.count();
    } catch (err) {
      result.error = `count failed: ${err instanceof Error ? err.message : String(err)}`;
      results.push(result);
      continue;
    }

    onProgress?.({
      phase: 'tables',
      tableName: cfg.name,
      tableIndex: i,
      tableCount: configs.length,
      rowsScanned: 0,
      totalRowsInTable: result.totalRows,
    });

    if (result.totalRows === 0) {
      results.push(result);
      continue;
    }

    let lastId = 0;
    let scanned = 0;

    while (true) {
      throwIfAborted(signal);
      let chunk: Array<Record<string, unknown>>;
      try {
        chunk = (await cfg.table
          .where('id')
          .above(lastId)
          .limit(ROW_BATCH_SIZE)
          .toArray()) as unknown as Array<Record<string, unknown>>;
      } catch (err) {
        result.error = `read failed: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
      if (chunk.length === 0) break;

      lastId = (chunk[chunk.length - 1].id as number) ?? lastId;

      for (const row of chunk) {
        const rowId = String(row.id ?? '?');
        if (hasLegacyMarker(row)) {
          result.markerRows++;
          if (result.sampleMarkerIds.length < SAMPLE_LIMIT) {
            result.sampleMarkerIds.push(rowId);
          }
        }
        if (rowHasSuspiciousField(row, sensitiveFieldNames)) {
          result.suspiciousFieldRows++;
          if (result.sampleSuspiciousIds.length < SAMPLE_LIMIT) {
            result.sampleSuspiciousIds.push(rowId);
          }
        }
      }

      scanned += chunk.length;
      onProgress?.({
        phase: 'tables',
        tableName: cfg.name,
        tableIndex: i,
        tableCount: configs.length,
        rowsScanned: scanned,
        totalRowsInTable: result.totalRows,
      });

      if (chunk.length < ROW_BATCH_SIZE) break;
      await yieldToEventLoop();
    }

    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// File scanner
// ---------------------------------------------------------------------------

export type FileClassification = 'plain' | 'encrypted' | 'unreadable';

export interface FileScanFinding {
  source: 'attachments' | 'evidenceAttachments';
  id: number;
  objectStoragePath: string;
  classification: FileClassification;
  byteLength?: number;
  error?: string;
}

export interface FileScanResult {
  totalFiles: number;
  plainFiles: number;
  encryptedFiles: number;
  unreadableFiles: number;
  sampleEncryptedPaths: string[];
  sampleUnreadable: Array<{ path: string; error: string }>;
  perSource: {
    attachments: number;
    evidenceAttachments: number;
  };
}

export interface FileScanProgress {
  phase: 'files';
  current: number;
  total: number;
  plain: number;
  encrypted: number;
  unreadable: number;
}

async function readFileBytes(objectPath: string): Promise<ArrayBuffer> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.readAttachment(objectPath);
    if (!result.success) {
      throw new Error(result.error || 'Read failed');
    }
    return result.data!;
  }
  const encodedPath = objectPath.split('/').map((s) => encodeURIComponent(s)).join('/');
  const response = await fetch(`/api/attachments/download/${encodedPath}`);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  return response.arrayBuffer();
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Heuristic: does the given file blob look like recognizable plaintext content?
 * Returns true when the file has a known format magic-bytes header or appears
 * to be a valid UTF-8 text file with mostly printable characters. Returns
 * false when the bytes are big enough to plausibly be ciphertext but match
 * none of those signatures.
 */
export function classifyFileBytes(bytes: ArrayBuffer): FileClassification {
  const u8 = new Uint8Array(bytes);
  if (u8.length === 0) return 'plain';
  if (u8.length < MIN_ENCRYPTED_FILE_LEN) return 'plain';

  // PDF: %PDF-
  if (startsWith(u8, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'plain';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(u8, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'plain';
  // JPEG: FF D8 FF
  if (startsWith(u8, [0xff, 0xd8, 0xff])) return 'plain';
  // GIF87a / GIF89a
  if (startsWith(u8, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'plain';
  if (startsWith(u8, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'plain';
  // ZIP / docx / xlsx / pptx / odt: PK\x03\x04 or PK\x05\x06 or PK\x07\x08
  if (startsWith(u8, [0x50, 0x4b, 0x03, 0x04])) return 'plain';
  if (startsWith(u8, [0x50, 0x4b, 0x05, 0x06])) return 'plain';
  if (startsWith(u8, [0x50, 0x4b, 0x07, 0x08])) return 'plain';
  // RIFF (WEBP, WAV)
  if (startsWith(u8, [0x52, 0x49, 0x46, 0x46])) return 'plain';
  // BMP: BM
  if (startsWith(u8, [0x42, 0x4d])) return 'plain';
  // TIFF: II*\0  or MM\0*
  if (startsWith(u8, [0x49, 0x49, 0x2a, 0x00])) return 'plain';
  if (startsWith(u8, [0x4d, 0x4d, 0x00, 0x2a])) return 'plain';
  // 7z: 37 7A BC AF 27 1C
  if (startsWith(u8, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'plain';
  // gzip: 1F 8B
  if (startsWith(u8, [0x1f, 0x8b])) return 'plain';
  // mp4 / mov: ....ftyp at offset 4
  if (u8.length >= 12 && startsWith(u8, [0x66, 0x74, 0x79, 0x70], 4)) return 'plain';

  // Probe for valid UTF-8 plain text in the first 1KB.
  const probe = u8.subarray(0, Math.min(u8.length, 1024));
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(probe);
    let printable = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) {
        printable++;
      }
    }
    if (text.length > 0 && printable / text.length >= 0.95) {
      return 'plain';
    }
  } catch {
    // not valid UTF-8 → fall through
  }

  return 'encrypted';
}

export async function scanFilesForEncryption(
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: FileScanProgress) => void;
  },
): Promise<{ result: FileScanResult; findings: FileScanFinding[] }> {
  const signal = options?.signal;
  const onProgress = options?.onProgress;

  throwIfAborted(signal);
  const allAttachments = await db.attachments.toArray();
  throwIfAborted(signal);
  const allEvidenceAttachments = await db.evidenceAttachments.toArray();

  const queue: Array<{ source: 'attachments' | 'evidenceAttachments'; id: number; path: string }> = [];

  for (const a of allAttachments) {
    if (a.objectStoragePath && a.id != null) {
      queue.push({ source: 'attachments', id: a.id, path: a.objectStoragePath });
    }
  }
  for (const a of allEvidenceAttachments) {
    if (a.objectStoragePath && a.id != null) {
      queue.push({ source: 'evidenceAttachments', id: a.id, path: a.objectStoragePath });
    }
  }

  const findings: FileScanFinding[] = [];
  const result: FileScanResult = {
    totalFiles: queue.length,
    plainFiles: 0,
    encryptedFiles: 0,
    unreadableFiles: 0,
    sampleEncryptedPaths: [],
    sampleUnreadable: [],
    perSource: { attachments: 0, evidenceAttachments: 0 },
  };

  onProgress?.({
    phase: 'files',
    current: 0,
    total: queue.length,
    plain: 0,
    encrypted: 0,
    unreadable: 0,
  });

  for (let i = 0; i < queue.length; i++) {
    throwIfAborted(signal);
    const item = queue[i];
    let classification: FileClassification = 'plain';
    let byteLength: number | undefined;
    let errorMsg: string | undefined;

    try {
      const bytes = await readFileBytes(item.path);
      byteLength = bytes.byteLength;
      classification = classifyFileBytes(bytes);
    } catch (err) {
      classification = 'unreadable';
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    findings.push({
      source: item.source,
      id: item.id,
      objectStoragePath: item.path,
      classification,
      byteLength,
      error: errorMsg,
    });

    if (classification === 'plain') {
      result.plainFiles++;
    } else if (classification === 'encrypted') {
      result.encryptedFiles++;
      result.perSource[item.source]++;
      if (result.sampleEncryptedPaths.length < SAMPLE_LIMIT) {
        result.sampleEncryptedPaths.push(item.path);
      }
    } else {
      result.unreadableFiles++;
      if (result.sampleUnreadable.length < SAMPLE_LIMIT) {
        result.sampleUnreadable.push({ path: item.path, error: errorMsg ?? 'unknown error' });
      }
    }

    onProgress?.({
      phase: 'files',
      current: i + 1,
      total: queue.length,
      plain: result.plainFiles,
      encrypted: result.encryptedFiles,
      unreadable: result.unreadableFiles,
    });

    if ((i + 1) % FILE_BATCH_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }

  return { result, findings };
}
