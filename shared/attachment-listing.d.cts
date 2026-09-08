export type AttachmentListingPage = {
  limit?: number;
  cursor?: string;
  closeCursor?: string;
  summaryOnly?: boolean;
};

export type AttachmentListingResult = {
  success: boolean;
  files?: string[];
  total?: number;
  totalBytes?: number;
  cursor?: string | null;
  code?: 'EXPIRED' | 'TOO_MANY';
  error?: string;
};

export function createAttachmentListing(options: {
  attachmentsDir: string;
  onFileVisited?: () => void;
  now?: () => number;
  randomUUID?: () => string;
  sessionTtlMs?: number;
  maxSessions?: number;
}): {
  list(page?: AttachmentListingPage): Promise<AttachmentListingResult>;
  summary(): Promise<{ total: number; totalBytes: number }>;
  closeCursor(id: string): Promise<void>;
  reapExpired(currentTime?: number): Promise<void>;
  startReaper(intervalMs?: number): NodeJS.Timeout;
};

declare const attachmentListingModule: {
  createAttachmentListing: typeof createAttachmentListing;
};
export default attachmentListingModule;