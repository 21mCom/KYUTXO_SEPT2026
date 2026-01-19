import { db } from '@/lib/database';
import { encryptBinary, decryptBinary } from '@/lib/crypto';
import { isEncryptionReady, getEncryptionKey } from '@/lib/encryptionFacade';
import { isElectron, getElectronAPI } from '@/lib/electron';

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
    let fileData: ArrayBuffer = await file.arrayBuffer();
    let isEncrypted = false;
    
    // Encrypt the file if encryption is available
    if (isEncryptionReady()) {
      const key = getEncryptionKey();
      if (key) {
        fileData = await encryptBinary(fileData, key);
        isEncrypted = true;
      }
    }
    
    let objectStoragePath: string;
    
    if (isElectron()) {
      // Electron mode: save via IPC
      const api = getElectronAPI();
      const result = await api.saveAttachment(identifier, file.name, fileData);
      
      if (!result.success) {
        throw new Error(result.error || 'Upload failed');
      }
      
      objectStoragePath = result.path!;
    } else {
      // Web mode: upload via API
      const fileToUpload = new Blob([fileData], { 
        type: isEncrypted ? 'application/octet-stream' : file.type 
      });
      
      const formData = new FormData();
      formData.append('file', fileToUpload, file.name);
      formData.append('identifier', identifier);
      formData.append('recordId', recordId.toString());
      formData.append('encrypted', isEncrypted.toString());

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

    const attachmentId = await db.attachments.add({
      recordId,
      filename: file.name,
      mimeType: file.type,
      size: file.size, // Original file size
      objectStoragePath,
      createdAt: Date.now(),
      isEncrypted,
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
export async function downloadAttachment(objectPath: string, isEncrypted?: boolean): Promise<Blob> {
  try {
    let data: ArrayBuffer;
    
    if (isElectron()) {
      // Electron mode: read via IPC
      const api = getElectronAPI();
      const result = await api.readAttachment(objectPath);
      
      if (!result.success) {
        throw new Error(result.error || 'Download failed');
      }
      
      data = result.data!;
    } else {
      // Web mode: download via API
      const response = await fetch(`/api/attachments/download/${objectPath}`);
      
      if (!response.ok) {
        throw new Error('Download failed');
      }
      
      data = await response.arrayBuffer();
    }
    
    // Decrypt if the attachment is encrypted
    if (isEncrypted && isEncryptionReady()) {
      const key = getEncryptionKey();
      if (key) {
        data = await decryptBinary(data, key);
      }
    }
    
    return new Blob([data]);
  } catch (error) {
    throw new Error(`Failed to download attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Download attachment by ID (looks up encryption status from metadata)
export async function downloadAttachmentById(attachmentId: number): Promise<{ blob: Blob; filename: string; mimeType: string }> {
  const attachment = await db.attachments.get(attachmentId);
  if (!attachment) {
    throw new Error('Attachment not found');
  }
  
  const blob = await downloadAttachment(attachment.objectStoragePath, attachment.isEncrypted);
  
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
    const attachment = await db.attachments.get(id);
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
      // Web mode: delete via API
      const response = await fetch(`/api/attachments/${attachment.objectStoragePath}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Delete failed');
      }
    }

    await db.attachments.delete(id);
  } catch (error) {
    throw new Error(`Failed to delete attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getRecordAttachments(recordId: number) {
  return db.attachments.where('recordId').equals(recordId).toArray();
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
export async function uploadEncryptedFile(file: File): Promise<string> {
  try {
    let fileData: ArrayBuffer = await file.arrayBuffer();
    let isEncrypted = false;
    
    // Encrypt the file if encryption is available
    if (isEncryptionReady()) {
      const key = getEncryptionKey();
      if (key) {
        fileData = await encryptBinary(fileData, key);
        isEncrypted = true;
      }
    }
    
    if (isElectron()) {
      // Electron mode: save via IPC
      const api = getElectronAPI();
      const identifier = `evidence_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const result = await api.saveAttachment(identifier, file.name, fileData);
      
      if (!result.success) {
        throw new Error(result.error || 'Upload failed');
      }
      
      return result.path!;
    } else {
      // Web mode: upload via API
      const fileToUpload = new Blob([fileData], { 
        type: isEncrypted ? 'application/octet-stream' : file.type 
      });
      
      const formData = new FormData();
      formData.append('file', fileToUpload, file.name);
      formData.append('identifier', `evidence_${Date.now()}`);
      formData.append('recordId', '0'); // No associated record
      formData.append('encrypted', isEncrypted.toString());

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
export async function downloadDecryptedFile(objectPath: string, filename: string): Promise<void> {
  try {
    const blob = await downloadAttachment(objectPath, true); // Always try decrypting
    
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

// Get decrypted file blob for preview (no download triggered)
export async function getDecryptedFileBlob(
  objectPath: string, 
  mimeType: string,
  isEncrypted: boolean = true
): Promise<Blob> {
  try {
    const blob = await downloadAttachment(objectPath, isEncrypted);
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
export async function deleteEncryptedFile(objectPath: string): Promise<void> {
  try {
    if (isElectron()) {
      // Electron mode: delete via IPC
      const api = getElectronAPI();
      const result = await api.deleteAttachment(objectPath);
      
      if (!result.success) {
        throw new Error(result.error || 'Delete failed');
      }
    } else {
      // Web mode: delete via API
      const response = await fetch(`/api/attachments/${objectPath}`, {
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

// ============ RE-ENCRYPTION FOR PASSWORD CHANGE ============

// Read raw file data without decrypting (for re-encryption purposes)
async function readRawFile(objectPath: string): Promise<ArrayBuffer> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.readAttachment(objectPath);
    if (!result.success) {
      throw new Error(result.error || 'Read failed');
    }
    return result.data!;
  } else {
    const response = await fetch(`/api/attachments/download/${objectPath}`);
    if (!response.ok) {
      throw new Error('Read failed');
    }
    return response.arrayBuffer();
  }
}

// Write raw file data (for re-encryption purposes)
async function writeRawFile(objectPath: string, data: ArrayBuffer): Promise<void> {
  if (isElectron()) {
    const api = getElectronAPI();
    // Use writeAttachment to overwrite at exact path (not saveAttachment which creates new file)
    const result = await api.writeAttachment(objectPath, data);
    if (!result.success) {
      throw new Error(result.error || 'Write failed');
    }
  } else {
    // Web mode: upload via API (overwrite)
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('file', blob, 'file');
    formData.append('objectPath', objectPath);
    formData.append('overwrite', 'true');

    const response = await fetch('/api/attachments/rewrite', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Write failed');
    }
  }
}

// Re-encrypt a single attachment file with a new key
export async function reEncryptAttachmentFile(
  objectPath: string,
  oldKey: CryptoKey,
  newKey: CryptoKey
): Promise<void> {
  // Read raw encrypted data
  const encryptedData = await readRawFile(objectPath);
  
  // Decrypt with old key
  const decryptedData = await decryptBinary(encryptedData, oldKey);
  
  // Re-encrypt with new key
  const reEncryptedData = await encryptBinary(decryptedData, newKey);
  
  // Write back
  await writeRawFile(objectPath, reEncryptedData);
}

// Re-encrypt all attachment files (for password change)
export async function reEncryptAllAttachmentFiles(
  oldKey: CryptoKey,
  newKey: CryptoKey,
  onProgress?: (current: number, total: number) => void
): Promise<number> {
  // Get all encrypted attachments
  const attachments = await db.attachments.filter(a => a.isEncrypted === true).toArray();
  
  let count = 0;
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    if (onProgress) {
      onProgress(i + 1, attachments.length);
    }
    
    try {
      await reEncryptAttachmentFile(attachment.objectStoragePath, oldKey, newKey);
      count++;
    } catch (error) {
      console.error(`Failed to re-encrypt attachment ${attachment.id}:`, error);
      throw new Error(`Failed to re-encrypt attachment "${attachment.filename}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  return count;
}

// Re-encrypt all evidence attachment files (for password change)
export async function reEncryptAllEvidenceAttachmentFiles(
  oldKey: CryptoKey,
  newKey: CryptoKey,
  onProgress?: (current: number, total: number) => void
): Promise<number> {
  // Get all encrypted evidence attachments
  const evidenceAttachments = await db.evidenceAttachments.filter(a => a.isEncrypted === true).toArray();
  
  let count = 0;
  for (let i = 0; i < evidenceAttachments.length; i++) {
    const attachment = evidenceAttachments[i];
    if (onProgress) {
      onProgress(i + 1, evidenceAttachments.length);
    }
    
    try {
      await reEncryptAttachmentFile(attachment.objectStoragePath, oldKey, newKey);
      count++;
    } catch (error) {
      console.error(`Failed to re-encrypt evidence attachment ${attachment.id}:`, error);
      throw new Error(`Failed to re-encrypt evidence attachment "${attachment.filename}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  return count;
}
