import { db } from '@/lib/database';

export interface AttachmentUploadResult {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  objectStoragePath: string;
}

export async function uploadAttachment(
  recordId: number,
  file: File
): Promise<AttachmentUploadResult> {
  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`/api/attachments/upload/${recordId}`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Upload failed');
    }

    const data = await response.json();

    const attachmentId = await db.attachments.add({
      recordId,
      filename: data.filename,
      mimeType: data.mimeType,
      size: data.size,
      objectStoragePath: data.objectStoragePath,
      createdAt: Date.now(),
    });

    return {
      id: attachmentId as number,
      filename: data.filename,
      mimeType: data.mimeType,
      size: data.size,
      objectStoragePath: data.objectStoragePath,
    };
  } catch (error) {
    throw new Error(`Failed to upload attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function downloadAttachment(objectPath: string): Promise<Blob> {
  try {
    const response = await fetch(`/api/attachments/download/${objectPath}`);
    
    if (!response.ok) {
      throw new Error('Download failed');
    }
    
    return response.blob();
  } catch (error) {
    throw new Error(`Failed to download attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function deleteAttachment(id: number): Promise<void> {
  try {
    const attachment = await db.attachments.get(id);
    if (!attachment) {
      throw new Error('Attachment not found');
    }

    const response = await fetch(`/api/attachments/${attachment.objectStoragePath}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Delete failed');
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
