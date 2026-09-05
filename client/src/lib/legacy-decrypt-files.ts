import { decryptBinary } from './crypto';
import { getVaultRepository } from './repository';
import type { Attachment, EvidenceAttachment } from './db-types';
import { isElectron, getElectronAPI } from './electron';

export interface FileDecryptProgress {
  current: number;
  total: number;
  decrypted: number;
  failed: number;
  skipped: number;
  phase?: string;
}

const FILE_OP_TIMEOUT_MS = 30000;

/**
 * Rejects if the underlying promise does not settle within `ms`. Used so a
 * single stuck file read/write cannot freeze the entire migration — the file is
 * simply counted as failed and the loop moves on.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface FileDecryptResult {
  totalDecrypted: number;
  totalFailed: number;
  totalSkipped: number;
  errors: string[];
}

async function readFileBytes(objectPath: string): Promise<ArrayBuffer> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.readAttachment(objectPath);
    if (!result.success) {
      throw new Error(result.error || 'Read failed');
    }
    return result.data!;
  } else {
    const encodedPath = objectPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const response = await fetch(`/api/attachments/download/${encodedPath}`);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    return response.arrayBuffer();
  }
}

async function writeFileBytes(objectPath: string, data: ArrayBuffer): Promise<void> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.writeAttachment(objectPath, data);
    if (!result.success) {
      throw new Error(result.error || 'Write failed');
    }
  } else {
    const pathWithoutPrefix = objectPath.startsWith('attachments/')
      ? objectPath.slice('attachments/'.length)
      : objectPath;

    const blob = new Blob([data], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('file', blob, 'file');
    formData.append('relativePath', pathWithoutPrefix);

    const response = await fetch('/api/attachments/write', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Write failed' }));
      throw new Error(error.error || 'Write failed');
    }
  }
}

/**
 * Durable resume point. `tableIndex` indexes FILE_DECRYPT_TABLES; `lastId` is the
 * highest primary key already processed in that table. Everything before it (all
 * earlier tables fully, plus rows up to `lastId` in the current table) is done.
 */
export interface FileDecryptCheckpoint {
  tableIndex: number;
  lastId: number;
}

interface FileDecryptOptions {
  getCheckpoint?: () => Promise<FileDecryptCheckpoint | null>;
  saveCheckpoint?: (cp: FileDecryptCheckpoint) => Promise<void>;
}

const FILE_DECRYPT_TABLES = ['attachments', 'evidenceAttachments'] as const;
const FILE_DECRYPT_BATCH = 200;

export async function decryptLegacyAttachmentFiles(
  key: CryptoKey,
  onProgress?: (progress: FileDecryptProgress) => void,
  options?: FileDecryptOptions,
): Promise<FileDecryptResult> {
  if (onProgress) {
    onProgress({ current: 0, total: 0, decrypted: 0, failed: 0, skipped: 0, phase: 'Preparing file list' });
  }

  // Indexed counts give a stable progress denominator without loading any rows.
  const repository = getVaultRepository();
  const total = (await repository.count('attachments')) + (await repository.count('evidenceAttachments'));

  let decrypted = 0;
  let failed = 0;
  let skipped = 0;
  let current = 0;
  const errors: string[] = [];

  if (total === 0) {
    return { totalDecrypted: 0, totalFailed: 0, totalSkipped: 0, errors: [] };
  }

  // Resume from the durable checkpoint. The checkpoint only ever advances over
  // fully-clean batches and is FROZEN the moment a hard (IO) failure occurs, so
  // an interrupted run resumes at the first failed file and never skips it.
  // (decrypt-fails and too-small files are benign skips, not failures.)
  const startCp = (await options?.getCheckpoint?.()) ?? { tableIndex: 0, lastId: 0 };
  let checkpointFrozen = false;

  for (let tableIndex = startCp.tableIndex; tableIndex < FILE_DECRYPT_TABLES.length; tableIndex++) {
    const table = FILE_DECRYPT_TABLES[tableIndex];
    let lastId = tableIndex === startCp.tableIndex ? startCp.lastId : 0;

    for (;;) {
      const page = await repository.list(table, { cursor: lastId || undefined, limit: FILE_DECRYPT_BATCH });
      const chunk = page.rows as Array<Attachment | EvidenceAttachment>;
      if (chunk.length === 0) break;

      const batchLastId = chunk[chunk.length - 1].id!;
      let batchHadFailure = false;

      for (const att of chunk) {
        current++;
        const objectStoragePath = att.objectStoragePath;
        if (!objectStoragePath) {
          if (onProgress) onProgress({ current, total, decrypted, failed, skipped });
          continue;
        }

        try {
          const encryptedData = await withTimeout(
            readFileBytes(objectStoragePath),
            FILE_OP_TIMEOUT_MS,
            `Read ${objectStoragePath}`,
          );

          if (encryptedData.byteLength < 28) {
            skipped++;
          } else {
            let plainData: ArrayBuffer | null = null;
            try {
              plainData = await decryptBinary(encryptedData, key);
            } catch {
              skipped++;
            }
            if (plainData) {
              await withTimeout(
                writeFileBytes(objectStoragePath, plainData),
                FILE_OP_TIMEOUT_MS,
                `Write ${objectStoragePath}`,
              );
              decrypted++;
              console.log(`[FileDecrypt] Decrypted ${table} #${att.id}: ${objectStoragePath}`);
            }
          }
        } catch (err) {
          failed++;
          batchHadFailure = true;
          const msg = `${table} #${att.id} (${objectStoragePath}): ${err instanceof Error ? err.message : String(err)}`;
          console.error(`[FileDecrypt] Failed: ${msg}`);
          errors.push(msg);
        }

        if (onProgress) onProgress({ current, total, decrypted, failed, skipped });
      }

      lastId = batchLastId;

      if (batchHadFailure) {
        // Freeze the checkpoint at its last clean position so a resume retries
        // this batch (and everything after) rather than skipping the failure.
        checkpointFrozen = true;
      } else if (!checkpointFrozen) {
        await options?.saveCheckpoint?.({ tableIndex, lastId: batchLastId });
      }

      // Yield between batches so a long run never blocks the main thread.
      await new Promise(r => setTimeout(r, 0));
      if (chunk.length < FILE_DECRYPT_BATCH) break;
    }

    // A table finished with no failures so far — advance to the next table's
    // start so a resume never re-scans a fully-completed table.
    if (!checkpointFrozen) {
      await options?.saveCheckpoint?.({ tableIndex: tableIndex + 1, lastId: 0 });
    }
  }

  return { totalDecrypted: decrypted, totalFailed: failed, totalSkipped: skipped, errors };
}
