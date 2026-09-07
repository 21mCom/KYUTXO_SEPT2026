import { notifyDbChange, type Attachment, type EvidenceAttachment } from '@/lib/database';
import { isElectron, getElectronAPI } from '@/lib/electron';
import { updateEvidenceAttachment, countEvidenceAttachments, getAllEvidenceAttachments } from '@/lib/data/evidence-crud';
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
import { getVaultRepository } from '@/lib/repository';

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

async function attachmentResponseError(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error ? body.error : fallback;
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
        throw new Error(await attachmentResponseError(response, 'Download failed'));
      }
      
      data = await response.arrayBuffer();
    }
    
    return new Blob([data]);
  } catch (error) {
    throw new Error(`Failed to download attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Download attachment by ID. The stored path is tried first; if it no longer
// resolves to a file on disk (the file was moved into the hashed/opaque scheme
// by a prior privacy migration but this row's pointer drifted), we locate the
// real file, re-link the row, and open it. If it genuinely cannot be found, we
// throw a clear, actionable error pointing at the Settings repair tool instead
// of a generic failure.
export async function downloadAttachmentById(attachmentId: number): Promise<{ blob: Blob; filename: string; mimeType: string }> {
  const attachment = await getAttachment(attachmentId);
  if (!attachment) {
    throw new Error('Attachment not found');
  }

  let blob: Blob;
  try {
    blob = await downloadAttachment(attachment.objectStoragePath);
  } catch (err) {
    // The stored path did not resolve. Try to find the real file on disk and
    // re-link this row to it — only ever to an unambiguous, already-migrated
    // hashed/opaque file, never back onto a legacy plaintext path.
    const relinked = await locateAndRelinkAttachment(attachment).catch(() => null);
    if (relinked) {
      blob = await downloadAttachment(relinked);
    } else {
      throw new Error(
        'This attachment\u2019s file could not be found on disk. Open Settings \u2192 Storage & Files and run \u201CRepair attachment links\u201D to reconnect your files.',
      );
    }
  }

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
  if (!response.ok) {
    throw new Error(await attachmentResponseError(response, 'Download failed'));
  }
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
  const files: string[] = [];
  let cursor: string | null = null;
  do {
    if (isElectron()) {
      const result = await getElectronAPI().listAllAttachments(cursor, 1_000);
      if (!result.success) throw new Error(result.error || 'List failed');
      files.push(...(result.files ?? []));
      cursor = result.cursor ?? null;
    } else {
      const query = new URLSearchParams({ limit: '1000' });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(`/api/attachments/list-all?${query}`);
      if (!response.ok) throw new Error(`List failed: ${response.status}`);
      const data = await response.json();
      files.push(...(data.files ?? []));
      cursor = data.cursor ?? null;
    }
  } while (cursor);
  return files;
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
  const allEvidence = await getAllEvidenceAttachments();

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

// ============ RECONCILIATION / RE-LINK CORE ============
//
// When a privacy migration moved attachment files into the hashed/opaque scheme
// (attachments/<sha256(identifier)>/<32-hex opaque><ext>) but a DB row's stored
// path drifted out of sync, the literal path no longer resolves and the file
// "won't open". These helpers locate the real file on disk and re-link the row
// to it. They NEVER move, copy, or delete bytes — they only repoint DB rows, and
// only ever to an unambiguous, already-migrated hashed/opaque file.

interface AttachmentDiskIndex {
  // Normalised on-disk relative paths (forward slashes, no `attachments/` prefix).
  diskSet: Set<string>;
  // Directory (path minus filename, '' for root files) -> filenames in it.
  byDir: Map<string, string[]>;
  // Normalised paths already referenced/claimed by a DB row. Files NOT in here
  // are orphans available to be claimed by a drifted row.
  referenced: Set<string>;
}

function splitDirFile(norm: string): { dir: string; file: string } {
  const parts = norm.split('/').filter(Boolean);
  const file = parts[parts.length - 1] ?? '';
  const dir = parts.length >= 2 ? parts.slice(0, -1).join('/') : '';
  return { dir, file };
}

function indexAddFile(byDir: Map<string, string[]>, norm: string): void {
  const { dir, file } = splitDirFile(norm);
  if (!file) return;
  let list = byDir.get(dir);
  if (!list) {
    list = [];
    byDir.set(dir, list);
  }
  if (!list.includes(file)) list.push(file);
}

function indexRemoveFile(byDir: Map<string, string[]>, norm: string): void {
  const { dir, file } = splitDirFile(norm);
  const list = byDir.get(dir);
  if (!list) return;
  const i = list.indexOf(file);
  if (i >= 0) list.splice(i, 1);
}

async function buildAttachmentDiskIndex(): Promise<{ diskSet: Set<string>; byDir: Map<string, string[]> }> {
  const files = await listAllAttachmentFiles();
  const diskSet = new Set<string>();
  const byDir = new Map<string, string[]>();
  for (const raw of files) {
    const norm = raw.replace(/\\/g, '/');
    diskSet.add(norm);
    indexAddFile(byDir, norm);
  }
  return { diskSet, byDir };
}

// Batched keyset scan of BOTH attachment tables, accumulating only the set of
// on-disk paths some row already points at (cheap strings, never the rows). Used
// to identify orphaned files that a drifted row may safely claim.
async function collectReferencedPaths(diskSet: Set<string>): Promise<Set<string>> {
  const referenced = new Set<string>();
  const BATCH = 500;
  const tables: Array<'attachments' | 'evidenceAttachments'> = ['attachments', 'evidenceAttachments'];
  for (const table of tables) {
    let lastId = 0;
    for (;;) {
      const chunk = (await getVaultRepository().list(table, { cursor: lastId, limit: BATCH })).rows as Array<Attachment | EvidenceAttachment>;
      if (chunk.length === 0) break;
      lastId = chunk[chunk.length - 1].id!;
      for (const row of chunk) {
        if (!row.objectStoragePath) continue;
        const norm = normalizeStoredPath(row.objectStoragePath);
        if (diskSet.has(norm)) referenced.add(norm);
      }
      await new Promise(r => setTimeout(r, 0));
      if (chunk.length < BATCH) break;
    }
  }
  return referenced;
}

async function buildAttachmentRepairIndex(): Promise<AttachmentDiskIndex> {
  const { diskSet, byDir } = await buildAttachmentDiskIndex();
  const referenced = await collectReferencedPaths(diskSet);
  return { diskSet, byDir, referenced };
}

function extLower(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() || name;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

// Max same-extension candidates we will read bytes for to break a tie by exact
// size. Kept small so a pathological directory can never turn one repair into a
// huge read amplification.
const MAX_SIZE_DISAMBIG = 8;

// Find the real on-disk file for a drifted DB row, or null if it cannot be
// resolved unambiguously. Only ever returns a hashed/opaque file (the migrated
// scheme): we never re-link a row back onto a legacy plaintext path. Candidate
// directories are hashed only, because the migration hashes the old directory
// name and uploads hash the owning record's identifier — both reconstruct the
// same directory the file was moved into.
async function findActualFileForRow(
  objectStoragePath: string,
  filename: string,
  size: number | undefined,
  recordInputString: string | undefined,
  byDir: Map<string, string[]>,
  referenced: Set<string>,
): Promise<string | null> {
  const { dir: storedDir } = splitDirFile(normalizeStoredPath(objectStoragePath));

  const candidateDirs: string[] = [];
  const addDir = (d: string) => {
    if (d && !candidateDirs.includes(d)) candidateDirs.push(d);
  };
  if (storedDir) {
    if (isAlreadyHashed(storedDir)) addDir(storedDir);
    else addDir(await hashIdentifier(storedDir));
  }
  if (recordInputString) addDir(await hashIdentifier(recordInputString));

  // Gather orphaned (unclaimed), opaque-named files in those directories.
  const available: string[] = [];
  for (const dir of candidateDirs) {
    const files = byDir.get(dir);
    if (!files) continue;
    for (const f of files) {
      if (!isOpaqueFilename(f)) continue; // hashed/opaque scheme only
      const full = `${dir}/${f}`;
      if (referenced.has(full)) continue; // already claimed by another row
      if (!available.includes(full)) available.push(full);
    }
  }
  if (available.length === 0) return null;
  if (available.length === 1) return available[0];

  // Multiple candidates: prefer ones whose extension matches the row's filename.
  const wantExt = extLower(filename);
  const extMatches = wantExt ? available.filter(p => extLower(p) === wantExt) : [];
  const pool = extMatches.length > 0 ? extMatches : available;
  if (pool.length === 1) return pool[0];

  // Still ambiguous: break the tie by exact byte size when we know it and the
  // candidate set is small. Never guess if the size ties or can't be read.
  if (size != null && pool.length > 0 && pool.length <= MAX_SIZE_DISAMBIG) {
    const sizeMatches: string[] = [];
    for (const p of pool) {
      try {
        const bytes = await readAttachmentBytes(p);
        if (bytes.byteLength === size) sizeMatches.push(p);
      } catch {
        // Skip unreadable candidate.
      }
    }
    if (sizeMatches.length === 1) return sizeMatches[0];
  }
  return null; // ambiguous — do not guess
}

// Re-apply the original row's path style (Electron stores without an
// `attachments/` prefix; the web server stores with it) to a normalised target.
function reapplyAttachmentPrefix(originalStoredPath: string, normalizedTarget: string): string {
  const hadPrefix = originalStoredPath.replace(/\\/g, '/').startsWith('attachments/');
  return hadPrefix ? `attachments/${normalizedTarget}` : normalizedTarget;
}

// Used by the tolerant open path. Builds the repair index, finds the real file
// for a single record attachment, and re-links the row. Returns the new stored
// path on success, or null when the file cannot be resolved unambiguously.
async function locateAndRelinkAttachment(attachment: Attachment): Promise<string | null> {
  const { byDir, referenced } = await buildAttachmentRepairIndex();
  let inputString: string | undefined;
  if (attachment.recordId != null) {
    const rec = await getRecord(attachment.recordId);
    inputString = rec?.inputString;
  }
  const found = await findActualFileForRow(
    attachment.objectStoragePath,
    attachment.filename,
    attachment.size,
    inputString,
    byDir,
    referenced,
  );
  if (!found) return null;
  const newPath = reapplyAttachmentPrefix(attachment.objectStoragePath, found);
  await updateAttachment(attachment.id!, { objectStoragePath: newPath });
  return newPath;
}

export interface AttachmentReconcileResult {
  repaired: number;
  unresolved: number;
}

// Repair drifted attachment pointers by re-linking each row whose stored path no
// longer resolves to a file on disk. Relink-only: never moves, copies, or
// deletes bytes. Batched + yielding so it stays responsive and bounded on large
// vaults. Covers both the record-attachment and evidence tables.
export async function reconcileAttachmentPaths(
  onProgress?: (current: number, total: number, message: string) => void,
): Promise<AttachmentReconcileResult> {
  const { diskSet, byDir } = await buildAttachmentDiskIndex();
  const referenced = await collectReferencedPaths(diskSet);

  const total = (await countAttachments()) + (await countEvidenceAttachments());
  if (total === 0) return { repaired: 0, unresolved: 0 };

  const BATCH = 500;
  let repaired = 0;
  let unresolved = 0;
  let processed = 0;

  const tables: Array<'attachments' | 'evidenceAttachments'> = ['attachments', 'evidenceAttachments'];
  for (const table of tables) {
    let lastId = 0;
    for (;;) {
      const chunk = (await getVaultRepository().list(table, { cursor: lastId, limit: BATCH })).rows as Array<Attachment | EvidenceAttachment>;
      if (chunk.length === 0) break;
      lastId = chunk[chunk.length - 1].id!;

      for (const row of chunk) {
        processed++;
        if (onProgress) {
          onProgress(processed, total, `Checking attachment ${processed} of ${total}`);
        }
        if (!row.objectStoragePath) continue;
        const norm = normalizeStoredPath(row.objectStoragePath);
        if (diskSet.has(norm)) continue; // already resolves — nothing to do

        let inputString: string | undefined;
        if (table === 'attachments' && (row as Attachment).recordId != null) {
          const rec = await getRecord((row as Attachment).recordId);
          inputString = rec?.inputString;
        }

        const found = await findActualFileForRow(
          row.objectStoragePath,
          row.filename,
          row.size,
          inputString,
          byDir,
          referenced,
        );
        if (!found) {
          unresolved++;
          continue;
        }

        const newPath = reapplyAttachmentPrefix(row.objectStoragePath, found);
        if (table === 'attachments') {
          await updateAttachment(row.id!, { objectStoragePath: newPath }, { skipNotification: true });
        } else {
          await updateEvidenceAttachment(row.id!, { objectStoragePath: newPath }, { skipNotification: true });
        }
        referenced.add(found); // claim it so no other row re-links to the same file
        repaired++;
      }

      await new Promise(r => setTimeout(r, 0));
      if (chunk.length < BATCH) break;
    }
  }

  if (repaired > 0) {
    notifyDbChange('attachments');
    notifyDbChange('evidenceAttachments');
  }
  return { repaired, unresolved };
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
  filename: string;
  size?: number;
  isRootFile: boolean;
}

// Migrate a single attachment row's stored path into the hashed/opaque scheme.
// Throws on failure (the caller counts it). Extracted so the keyset loop below
// stays a thin pump over batches rather than holding the whole table in memory.
//
// When an `index` is supplied, the migration also CONVERGES: a row whose current
// file is already gone from its stored location (a prior partial migration moved
// it, or a restore left the pointer stale) is re-linked to the existing on-disk
// file instead of failing on a missing rename/copy source. Relink-only — never
// moves or copies bytes on that path. The index is kept consistent as files are
// renamed/copied/relinked so later rows in the same run see the truth.
async function migrateOneAttachmentPath(item: AttachmentMigrationItem, index?: AttachmentDiskIndex): Promise<void> {
  if (index) {
    const norm = normalizeStoredPath(item.objectStoragePath);
    if (!index.diskSet.has(norm)) {
      let inputString: string | undefined;
      if (item.table === 'attachments' && item.recordId != null) {
        const rec = await getRecord(item.recordId);
        inputString = rec?.inputString;
      }
      const found = await findActualFileForRow(
        item.objectStoragePath,
        item.filename,
        item.size,
        inputString,
        index.byDir,
        index.referenced,
      );
      if (found) {
        const newStoragePath = reapplyAttachmentPrefix(item.objectStoragePath, found);
        if (item.table === 'attachments') {
          await updateAttachment(item.id, { objectStoragePath: newStoragePath }, { skipNotification: true });
        } else {
          await updateEvidenceAttachment(item.id, { objectStoragePath: newStoragePath }, { skipNotification: true });
        }
        index.referenced.add(found);
        console.log(`[Migration] Re-linked attachment ${item.id} to existing file: ${item.objectStoragePath} -> ${newStoragePath}`);
        return;
      }
    }
  }

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

    if (index) {
      // A new copy now exists at the hashed/opaque path and is claimed by this
      // row. The original root file is intentionally left in place (orphan).
      const newNorm = normalizeStoredPath(newStoragePath);
      index.diskSet.add(newNorm);
      indexAddFile(index.byDir, newNorm);
      index.referenced.add(newNorm);
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

  if (index) {
    // Keep the in-memory index consistent so later rows in this run never match
    // a file that was just moved away, nor treat the new file as an orphan.
    const newNorm = normalizeStoredPath(newStoragePath);
    if (didRenameFile) {
      index.diskSet.delete(oldRelPath);
      indexRemoveFile(index.byDir, oldRelPath);
    }
    index.diskSet.add(newNorm);
    indexAddFile(index.byDir, newNorm);
    index.referenced.add(newNorm);
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
  const total = (await countAttachments()) + (await countEvidenceAttachments());
  if (total === 0) {
    return { migrated: 0, failed: 0 };
  }

  const BATCH = 500;
  let migrated = 0;
  let failed = 0;
  let processed = 0;

  // Build the on-disk index once so a drifted row whose file already moved can
  // be re-linked (convergence) instead of failing on a missing rename/copy
  // source. The index is kept consistent inside migrateOneAttachmentPath as
  // files are renamed/copied/relinked.
  const index = await buildAttachmentRepairIndex();

  const tables: Array<'attachments' | 'evidenceAttachments'> = ['attachments', 'evidenceAttachments'];
  for (const table of tables) {
    let lastId = 0;
    for (;;) {
      const chunk = (await getVaultRepository().list(table, { cursor: lastId, limit: BATCH })).rows as Array<Attachment | EvidenceAttachment>;
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
          filename: att.filename,
          size: att.size,
          isRootFile: kind === 'root',
        };

        if (onProgress) {
          onProgress(processed, total, `Migrating attachment ${processed} of ${total}`);
        }

        try {
          await migrateOneAttachmentPath(item, index);
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
