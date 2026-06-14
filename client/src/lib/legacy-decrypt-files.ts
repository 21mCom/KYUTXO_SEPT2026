import { decryptBinary } from './crypto';
import { db } from './database';
import { getAllAttachments } from './data/attachments-crud';
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

export async function decryptLegacyAttachmentFiles(
  key: CryptoKey,
  onProgress?: (progress: FileDecryptProgress) => void,
): Promise<FileDecryptResult> {
  // Enumerating every attachment can take a while on large vaults; surface a
  // "preparing" phase so the UI never sits silently on 0/0.
  if (onProgress) {
    onProgress({ current: 0, total: 0, decrypted: 0, failed: 0, skipped: 0, phase: 'Preparing file list' });
  }

  const allAttachments = await getAllAttachments();
  const allEvidenceAttachments = await db.evidenceAttachments.toArray();

  const allFiles: Array<{ objectStoragePath: string; source: string; id: number }> = [];

  for (const att of allAttachments) {
    if (att.objectStoragePath) {
      allFiles.push({ objectStoragePath: att.objectStoragePath, source: 'attachments', id: att.id! });
    }
  }
  for (const att of allEvidenceAttachments) {
    if (att.objectStoragePath) {
      allFiles.push({ objectStoragePath: att.objectStoragePath, source: 'evidenceAttachments', id: att.id! });
    }
  }

  const total = allFiles.length;
  let decrypted = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];

  if (total === 0) {
    return { totalDecrypted: 0, totalFailed: 0, totalSkipped: 0, errors: [] };
  }

  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];

    try {
      const encryptedData = await withTimeout(
        readFileBytes(file.objectStoragePath),
        FILE_OP_TIMEOUT_MS,
        `Read ${file.objectStoragePath}`,
      );

      if (encryptedData.byteLength < 28) {
        skipped++;
        if (onProgress) {
          onProgress({ current: i + 1, total, decrypted, failed, skipped });
        }
        continue;
      }

      let plainData: ArrayBuffer;
      try {
        plainData = await decryptBinary(encryptedData, key);
      } catch {
        skipped++;
        if (onProgress) {
          onProgress({ current: i + 1, total, decrypted, failed, skipped });
        }
        continue;
      }

      await withTimeout(
        writeFileBytes(file.objectStoragePath, plainData),
        FILE_OP_TIMEOUT_MS,
        `Write ${file.objectStoragePath}`,
      );
      decrypted++;
      console.log(`[FileDecrypt] Decrypted ${file.source} #${file.id}: ${file.objectStoragePath}`);
    } catch (err) {
      failed++;
      const msg = `${file.source} #${file.id} (${file.objectStoragePath}): ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[FileDecrypt] Failed: ${msg}`);
      errors.push(msg);
    }

    if (onProgress) {
      onProgress({ current: i + 1, total, decrypted, failed, skipped });
    }

    if (i % 5 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return { totalDecrypted: decrypted, totalFailed: failed, totalSkipped: skipped, errors };
}
