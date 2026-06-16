import { db } from '@/lib/database';
import { isElectron, getElectronAPI } from '@/lib/electron';
import { updateEvidenceAttachment } from '@/lib/data/evidence-crud';
import { getRecord } from '@/lib/data/record-crud';
import { archiveAttachments } from '@/lib/data/trash-crud';
import {
  addAttachment,
  deleteAttachment as deleteAttachmentRecord,
  getAttachment,
  getAllAttachments,
  getAttachmentsByRecordId,
  updateAttachment,
  countAttachments,
} from '@/lib/data/attachments-crud';

async function hashIdentifier(identifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(identifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateOpaqueFilename(extension: string): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return extension ? `${hex}${extension}` : hex;
}

export interface AttachmentUploadResult {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  objectStoragePath: string;
}

// Upload attachment - works in both Electron and web modes
export async function uploadAttachment(
  recordId: number,
  file: File,
  identifier: string
): Promise<AttachmentUploadResult> {
  try {
    const fileData: ArrayBuffer = await file.arrayBuffer();
    
    let objectStoragePath: string;
    const hashedId = await hashIdentifier(identifier);
    const opaqueFilename = generateOpaqueFilename(file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '');
    
    if (isElectron()) {
      const api = getElectronAPI();
      const result = await api.saveAttachment(hashedId, opaqueFilename, fileData);
      
      if (!result.success) {
        throw new Error(result.error || 'Upload failed');
      }
      
      objectStoragePath = result.path!;
    } else {
      const fileToUpload = new Blob([fileData], { 
        type: file.type 
      });
      
      const formData = new FormData();
      formData.append('file', fileToUpload, opaqueFilename);
      formData.append('identifier', hashedId);
      formData.append('recordId', recordId.toString());
      formData.append('encrypted', 'false');

      const response = await fetch('/api/attachments/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }

      const data = await response.json();
      objectStoragePath = data.objectStoragePath;
    }

    const attachmentId = await addAttachment({
      recordId,
      filename: file.name,
      mimeType: file.type,
      size: file.size, // Original file size
      objectStoragePath,
    });

    return {
      id: attachmentId as number,
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      objectStoragePath,
    };
  } catch (error) {
    throw new Error(`Failed to upload attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Download attachment - works in both Electron and web modes
export async function downloadAttachment(objectPath: string): Promise<Blob> {
  try {
    let data: ArrayBuffer;
    
    if (isElectron()) {
      const api = getElectronAPI();
      const result = await api.readAttachment(objectPath);
      
      if (!result.success) {
        throw new Error(result.error || 'Download failed');
      }
      
      data = result.data!;
    } else {
      const encodedPath = objectPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
      const response = await fetch(`/api/attachments/download/${encodedPath}`);
      
      if (!response.ok) {
        throw new Error('Download failed');
      }
      
      data = await response.arrayBuffer();
    }
    
    return new Blob([data]);
  } catch (error) {
    throw new Error(`Failed to download attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Download attachment by ID (looks up encryption status from metadata)
export async function downloadAttachmentById(attachmentId: number): Promise<{ blob: Blob; filename: string; mimeType: string }> {
  const attachment = await getAttachment(attachmentId);
  if (!attachment) {
    throw new Error('Attachment not found');
  }
  
  const blob = await downloadAttachment(attachment.objectStoragePath);
  
  // Create blob with original mime type
  const typedBlob = new Blob([blob], { type: attachment.mimeType });
  
  return {
    blob: typedBlob,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
  };
}

// Delete attachment - works in both Electron and web modes
export async function deleteAttachment(id: number): Promise<void> {
  try {
    const attachment = await getAttachment(id);
    if (!attachment) {
      throw new Error('Attachment not found');
    }

    if (isElectron()) {
      // Electron mode: delete via IPC
      const api = getElectronAPI();
      const result = await api.deleteAttachment(attachment.objectStoragePath);
      
      if (!result.success) {
        throw new Error(result.error || 'Delete failed');
      }
    } else {
      // Web mode: delete via API (encode path to handle slashes and special characters)
      const encodedPath = attachment.objectStoragePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
      const response = await fetch(`/api/attachments/${encodedPath}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Delete failed');
      }
    }

    await deleteAttachmentRecord(id);
  } catch (error) {
    throw new Error(`Failed to delete attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Remove an attachment from its record WITHOUT destroying the file. The file
// bytes are left on disk and the metadata is archived so the file stays
// recoverable (download or permanent purge from Settings > Deleted Attachments).
// Use this for user-initiated deletes. deleteAttachment() above still physically
// removes the file and is reserved for rolling back a failed upload.
export async function trashAttachment(id: number): Promise<void> {
  const attachment = await getAttachment(id);
  if (!attachment) {
    throw new Error('Attachment not found');
  }
  await archiveAttachments([attachment], 'attachment-delete', { skipNotification: true });
  await deleteAttachmentRecord(id);
}

export async function getRecordAttachments(recordId: number) {
  return getAttachmentsByRecordId(recordId);
}

export function getAttachmentIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'doc';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'spreadsheet';
  return 'file';
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// ============ GENERIC FILE UPLOAD/DOWNLOAD ============
// These functions are for uploading files without creating attachment records
// Useful for evidence attachments which have their own table

// Upload a file and return the storage path (no DB record created)
export async function uploadFile(file: File): Promise<string> {
  try {
    const fileData: ArrayBuffer = await file.arrayBuffer();
    
    if (isElectron()) {
      const api = getElectronAPI();
      const evidenceId = `evidence_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const hashedId = await hashIdentifier(evidenceId);
      const opaqueFilename = generateOpaqueFilename(file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '');
      const result = await api.saveAttachment(hashedId, opaqueFilename, fileData);
      
      if (!result.success) {
        throw new Error(result.error || 'Upload failed');
      }
      
      return result.path!;
    } else {
      const fileToUpload = new Blob([fileData], { 
        type: file.type 
      });
      
      const evidenceId = `evidence_${Date.now()}`;
      const hashedId = await hashIdentifier(evidenceId);
      const opaqueFilename = generateOpaqueFilename(file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '');
      const formData = new FormData();
      formData.append('file', fileToUpload, opaqueFilename);
      formData.append('identifier', hashedId);
      formData.append('recordId', '0');
      formData.append('encrypted', 'false');

      const response = await fetch('/api/attachments/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }

      const data = await response.json();
      return data.objectStoragePath;
    }
  } catch (error) {
    throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Download a file by its storage path and trigger browser download
export async function downloadFile(objectPath: string, filename: string): Promise<void> {
  try {
    const blob = await downloadAttachment(objectPath);
    
    // Create download link
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    throw new Error(`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Get file blob for preview (no download triggered)
export async function getFileBlob(
  objectPath: string, 
  mimeType: string
): Promise<Blob> {
  try {
    const blob = await downloadAttachment(objectPath);
    // Return blob with correct mime type for proper browser handling
    return new Blob([blob], { type: mimeType });
  } catch (error) {
    throw new Error(`Failed to get file for preview: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Check if a file type is previewable in-browser
// Note: PDFs excluded from preview due to XSS concerns - download only
export function isPreviewableType(mimeType: string): boolean {
  // SVG excluded - can contain scripts
  if (mimeType === 'image/svg+xml') return true; // Treated as text
  // Images (except SVG handled above)
  if (mimeType.startsWith('image/')) return true;
  // PDF excluded for security - use download instead
  // Text files
  if (mimeType.startsWith('text/')) return true;
  // Common text-based formats
  if (mimeType === 'application/json') return true;
  if (mimeType === 'application/xml') return true;
  // Audio
  if (mimeType.startsWith('audio/')) return true;
  // Video
  if (mimeType.startsWith('video/')) return true;
  
  return false;
}

// Get preview type category
// Note: SVG is treated as text for security (SVG can contain embedded scripts)
// Note: PDF excluded from preview for security - download only
export function getPreviewType(mimeType: string): 'image' | 'text' | 'audio' | 'video' | 'unsupported' {
  // SVG treated as text for security reasons (can contain scripts)
  if (mimeType === 'image/svg+xml') return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  // PDF excluded for security - use download instead
  if (mimeType === 'application/pdf') return 'unsupported';
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return 'text';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'unsupported';
}

// Delete a file by its storage path (no DB record deletion)
export async function deleteFile(objectPath: string): Promise<void> {
  try {
    if (isElectron()) {
      // Electron mode: delete via IPC
      const api = getElectronAPI();
      const result = await api.deleteAttachment(objectPath);
      
      if (!result.success) {
        throw new Error(result.error || 'Delete failed');
      }
    } else {
      // Web mode: delete via API (encode path to handle slashes and special characters)
      const encodedPath = objectPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
      const response = await fetch(`/api/attachments/${encodedPath}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Delete failed');
      }
    }
  } catch (error) {
    throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============ LEGACY PATH MIGRATION ============

function isAlreadyHashed(dirName: string): boolean {
  return /^[0-9a-f]{64}$/.test(dirName);
}

function isOpaqueFilename(filename: string): boolean {
  const baseName = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
  return /^[0-9a-f]{32}$/.test(baseName);
}

async function renameAttachmentFile(oldRelPath: string, newRelPath: string): Promise<void> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.renameAttachment(oldRelPath, newRelPath);
    if (!result.success) {
      throw new Error(result.error || 'Rename failed');
    }
  } else {
    const response = await fetch('/api/attachments/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath: oldRelPath, newPath: newRelPath }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Rename failed');
    }
  }
}

// ---- Byte-level helpers (copy = read + write + verify; never deletes) ------

async function readAttachmentBytes(relPath: string): Promise<ArrayBuffer> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.readAttachment(relPath);
    if (!result.success) throw new Error(result.error || 'Read failed');
    return result.data!;
  }
  const encoded = relPath.split('/').map(s => encodeURIComponent(s)).join('/');
  const response = await fetch(`/api/attachments/download/${encoded}`);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return response.arrayBuffer();
}

async function writeAttachmentBytes(relPath: string, data: ArrayBuffer): Promise<void> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.writeAttachment(relPath, data);
    if (!result.success) throw new Error(result.error || 'Write failed');
    return;
  }
  const pathWithoutPrefix = relPath.startsWith('attachments/')
    ? relPath.slice('attachments/'.length)
    : relPath;
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const formData = new FormData();
  formData.append('file', blob, 'file');
  formData.append('relativePath', pathWithoutPrefix);
  const response = await fetch('/api/attachments/write', { method: 'POST', body: formData });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Write failed' }));
    throw new Error(error.error || 'Write failed');
  }
}

// Copy a file to a new relative path and verify the copy is byte-identical. The
// original is intentionally left in place — recovery must never delete data.
// Verification compares every byte (not just length) so a same-length corrupted
// copy can never replace the original in the DB row.
async function copyAndVerifyAttachmentFile(srcRelPath: string, destRelPath: string): Promise<void> {
  const data = await readAttachmentBytes(srcRelPath);
  await writeAttachmentBytes(destRelPath, data);
  const verify = await readAttachmentBytes(destRelPath);
  const src = new Uint8Array(data);
  const dst = new Uint8Array(verify);
  if (src.byteLength !== dst.byteLength) {
    throw new Error(`Copy verification failed: ${dst.byteLength} != ${src.byteLength} bytes`);
  }
  for (let i = 0; i < src.byteLength; i++) {
    if (src[i] !== dst[i]) {
      throw new Error(`Copy verification failed: byte mismatch at offset ${i}`);
    }
  }
}

async function listAllAttachmentFiles(): Promise<string[]> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.listAllAttachments();
    if (!result.success) throw new Error(result.error || 'List failed');
    return result.files ?? [];
  }
  const response = await fetch('/api/attachments/list-all');
  if (!response.ok) throw new Error(`List failed: ${response.status}`);
  const data = await response.json();
  return data.files ?? [];
}

// Normalize a DB-stored path so it can be compared against the on-disk relative
// paths from listAllAttachmentFiles (forward slashes, no `attachments/` prefix).
function normalizeStoredPath(p: string): string {
  const fwd = p.replace(/\\/g, '/');
  return fwd.startsWith('attachments/') ? fwd.slice('attachments/'.length) : fwd;
}

export interface AttachmentAuditRow {
  source: 'attachments' | 'evidenceAttachments';
  id: number;
  objectStoragePath: string;
}

export interface AttachmentAuditResult {
  totalDbRows: number;
  totalDiskFiles: number;
  matched: number;
  missingFiles: AttachmentAuditRow[];
  orphanedFiles: string[];
}

// Read-only reconciliation of database attachment rows against files on disk.
// Never moves, writes, or deletes anything — it only reports the truth so the
// user can see what is recoverable before running any migration.
export async function auditAttachments(): Promise<AttachmentAuditResult> {
  const diskFiles = await listAllAttachmentFiles();
  const diskSet = new Set(diskFiles.map(f => f.replace(/\\/g, '/')));
  const referenced = new Set<string>();

  const allAttachments = await getAllAttachments();
  const allEvidence = await db.evidenceAttachments.toArray();

  let matched = 0;
  const missingFiles: AttachmentAuditRow[] = [];

  const check = (source: AttachmentAuditRow['source'], id: number, p: string) => {
    const norm = normalizeStoredPath(p);
    if (diskSet.has(norm)) {
      matched++;
      referenced.add(norm);
    } else {
      missingFiles.push({ source, id, objectStoragePath: p });
    }
  };

  for (const att of allAttachments) {
    if (att.objectStoragePath) check('attachments', att.id!, att.objectStoragePath);
  }
  for (const att of allEvidence) {
    if (att.objectStoragePath) check('evidenceAttachments', att.id!, att.objectStoragePath);
  }

  const orphanedFiles = Array.from(diskSet).filter(f => !referenced.has(f));

  return {
    totalDbRows: allAttachments.length + allEvidence.length,
    totalDiskFiles: diskSet.size,
    matched,
    missingFiles,
    orphanedFiles,
  };
}

// Classifies a stored path: 'skip' (already in hashed/opaque scheme or empty),
// 'rename' (legacy two-segment plaintext path), or 'root' (single-segment file
// stranded at the attachments root — previously skipped entirely).
function classifyStoredPath(objectStoragePath: string): 'skip' | 'rename' | 'root' {
  const parts = objectStoragePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const segs = parts[0] === 'attachments' ? parts.slice(1) : parts;
  if (segs.length >= 2) {
    return (isAlreadyHashed(segs[0]) && isOpaqueFilename(segs[1])) ? 'skip' : 'rename';
  }
  if (segs.length === 1) return 'root';
  return 'skip';
}

interface AttachmentMigrationItem {
  table: 'attachments' | 'evidenceAttachments';
  id: number;
  objectStoragePath: string;
  recordId?: number;
  isRootFile: boolean;
}

// Migrate a single attachment row's stored path into the hashed/opaque scheme.
// Throws on failure (the caller counts it). Extracted so the keyset loop below
// stays a thin pump over batches rather than holding the whole table in memory.
async function migrateOneAttachmentPath(item: AttachmentMigrationItem): Promise<void> {
  if (item.isRootFile) {
    // Single-segment file stranded at the attachments root. Recover it into
    // the hashed/opaque scheme by COPYING (read+write+verify) then updating
    // the DB row. The original root file is never deleted, so a failed copy
    // can never lose data and re-running is safe (the migrated row is
    // re-classified as 'skip' and the leftover root file shows up in the
    // audit as orphaned, ready for the user to clean up manually).
    const parts = item.objectStoragePath.replace(/\\/g, '/').split('/').filter(Boolean);
    const hasPrefix = parts[0] === 'attachments';
    const rootName = hasPrefix ? parts[1] : parts[0];

    // Resolve the target hashed directory. Record attachments hash the
    // owning record's identifier so list-attachments(identifier) keeps
    // working; evidence/record-less files mint a fresh opaque identifier
    // because the original is unrecoverable (only the hashed dir is stored).
    let identifier: string;
    if (item.table === 'attachments' && item.recordId != null) {
      const rec = await getRecord(item.recordId);
      identifier = rec?.inputString || `orphan_${item.recordId}`;
    } else {
      identifier = `evidence_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
    const newDirName = await hashIdentifier(identifier);
    const ext = rootName.includes('.') ? rootName.substring(rootName.lastIndexOf('.')) : '';
    const newFileName = generateOpaqueFilename(ext);
    const newRelPath = `${newDirName}/${newFileName}`;
    const newStoragePath = hasPrefix ? `attachments/${newRelPath}` : newRelPath;

    console.log(`[Migration] Recovering root file: ${item.objectStoragePath} -> ${newStoragePath}`);
    await copyAndVerifyAttachmentFile(item.objectStoragePath.replace(/\\/g, '/'), newStoragePath);

    if (item.table === 'attachments') {
      await updateAttachment(item.id, { objectStoragePath: newStoragePath }, { skipNotification: true });
    } else {
      await updateEvidenceAttachment(item.id, { objectStoragePath: newStoragePath }, { skipNotification: true });
    }

    console.log(`[Migration] Recovered root file for attachment ${item.id}: ${item.objectStoragePath} -> ${newStoragePath}`);
    return;
  }

  const pathParts = item.objectStoragePath.replace(/\\/g, '/').split('/');
  const hasPrefix = pathParts[0] === 'attachments';
  const dirName = hasPrefix ? pathParts[1] : pathParts[0];
  const oldFileName = hasPrefix ? pathParts[2] : pathParts[1];

  let newDirName = dirName;
  if (!isAlreadyHashed(dirName)) {
    newDirName = await hashIdentifier(dirName);
  }

  let newFileName = oldFileName;
  if (!isOpaqueFilename(oldFileName)) {
    const ext = oldFileName.includes('.') ? oldFileName.substring(oldFileName.lastIndexOf('.')) : '';
    newFileName = generateOpaqueFilename(ext);
  }

  const oldRelPath = `${dirName}/${oldFileName}`;
  const newRelPath = `${newDirName}/${newFileName}`;

  let didRenameFile = false;
  if (oldRelPath !== newRelPath) {
    console.log(`[Migration] Renaming: ${oldRelPath} -> ${newRelPath}`);
    await renameAttachmentFile(oldRelPath, newRelPath);
    didRenameFile = true;
  }

  const newStoragePath = hasPrefix ? `attachments/${newRelPath}` : newRelPath;

  try {
    if (item.table === 'attachments') {
      await updateAttachment(item.id, { objectStoragePath: newStoragePath }, { skipNotification: true });
    } else {
      await updateEvidenceAttachment(item.id, { objectStoragePath: newStoragePath }, { skipNotification: true });
    }
  } catch (dbError) {
    if (didRenameFile) {
      try {
        await renameAttachmentFile(newRelPath, oldRelPath);
      } catch (rollbackError) {
        console.error(`Rollback failed for attachment ${item.id}:`, rollbackError);
      }
    }
    throw dbError;
  }

  console.log(`[Migration] Successfully migrated attachment ${item.id}: ${item.objectStoragePath} -> ${newStoragePath}`);
}

// Normalises every attachment's stored path into the hashed/opaque scheme.
// Reads each table in id-keyset BATCHES (never the whole table at once) so it
// stays bounded on vaults with millions of attachment rows, yielding to the
// event loop between batches so a long run never freezes the UI.
export async function migrateAttachmentPaths(
  onProgress?: (current: number, total: number, message: string) => void
): Promise<{ migrated: number; failed: number }> {
  const total = (await countAttachments()) + (await db.evidenceAttachments.count());
  if (total === 0) {
    return { migrated: 0, failed: 0 };
  }

  const BATCH = 500;
  let migrated = 0;
  let failed = 0;
  let processed = 0;

  const tables: Array<'attachments' | 'evidenceAttachments'> = ['attachments', 'evidenceAttachments'];
  for (const table of tables) {
    let lastId = 0;
    for (;;) {
      const chunk =
        table === 'attachments'
          ? await db.attachments.where('id').above(lastId).limit(BATCH).toArray()
          : await db.evidenceAttachments.where('id').above(lastId).limit(BATCH).toArray();
      if (chunk.length === 0) break;
      lastId = chunk[chunk.length - 1].id!;

      for (const att of chunk) {
        processed++;
        const kind = classifyStoredPath(att.objectStoragePath);
        if (kind === 'skip') continue;

        const item: AttachmentMigrationItem = {
          table,
          id: att.id!,
          objectStoragePath: att.objectStoragePath,
          recordId: table === 'attachments' ? (att as Attachment).recordId : undefined,
          isRootFile: kind === 'root',
        };

        if (onProgress) {
          onProgress(processed, total, `Migrating attachment ${processed} of ${total}`);
        }

        try {
          await migrateOneAttachmentPath(item);
          migrated++;
        } catch (error) {
          console.error(`Failed to migrate attachment ${item.id} (${item.table}):`, error);
          failed++;
        }
      }

      // Yield between batches so the migration never blocks the main thread.
      await new Promise(r => setTimeout(r, 0));
      if (chunk.length < BATCH) break;
    }
  }

  return { migrated, failed };
}
