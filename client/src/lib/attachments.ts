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
