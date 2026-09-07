import { isElectron, getElectronAPI } from "@/lib/electron";
import { deleteFile } from "@/lib/attachments";
import { ATTACHMENTS_DIR } from "@/lib/backup/format";
import {
  AttachmentTooLargeError,
  type AttachmentFileWriter,
} from "@/lib/backup/restore";

// The AttachmentFileWriter used by every v3 restore entry point (the Settings
// Restore-from-Backup flow and the one-click demo-vault loader). Extracted from
// restore-backup-flow.tsx so both flows share the exact same write/delete/list/
// needs-review behaviour instead of drifting apart.
export function createRestoreAttachmentWriter(): AttachmentFileWriter {
  return {
    async write(relativePath, fileData) {
      if (isElectron()) {
        const api = getElectronAPI();
        const result = await api.writeAttachment(relativePath, fileData);
        if (!result.success) {
          if (result.code === "ATTACHMENT_TOO_LARGE") {
            throw new AttachmentTooLargeError(
              relativePath,
              result.error || "Attachment exceeds the maximum size",
            );
          }
          throw new Error(result.error || `Failed to write attachment ${relativePath}`);
        }
      } else {
        const formData = new FormData();
        formData.append("file", new Blob([fileData]));
        formData.append("relativePath", relativePath);
        const response = await fetch("/api/attachments/write", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          if (response.status === 413) {
            throw new AttachmentTooLargeError(
              relativePath,
              errorData.error || "Attachment exceeds the maximum size",
            );
          }
          throw new Error(errorData.error || response.statusText);
        }
      }
    },
    async delete(relativePath) {
      await deleteFile(`${ATTACHMENTS_DIR}/${relativePath}`);
    },
    // Continue one bounded, resumable filesystem traversal. Restore consumes
    // this only after a successful replace, so old filenames are never retained
    // in one pre-clear array.
    async listPage(cursor, limit) {
      if (isElectron()) {
        const result = await getElectronAPI().listAllAttachments(cursor, limit);
        if (!result.success) {
          throw new Error(result.error || "Failed to list attachments");
        }
        return { files: result.files ?? [], cursor: result.cursor ?? null };
      }
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/attachments/list-all?${query}`);
      if (!response.ok) {
        throw new Error(`Failed to list attachments: ${response.status}`);
      }
      const data = await response.json();
      return { files: data.files ?? [], cursor: data.cursor ?? null };
    },
    async closeListing(cursor) {
      if (isElectron()) {
        const result = await getElectronAPI().closeAttachmentListing(cursor);
        if (!result.success) {
          throw new Error(result.error || "Failed to close attachment listing");
        }
        return;
      }
      const response = await fetch(
        `/api/attachments/list-all?closeCursor=${encodeURIComponent(cursor)}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to close attachment listing: ${response.status}`);
      }
    },
    async writeReview(originalFilename, fileData) {
      if (isElectron()) {
        const api = getElectronAPI();
        const result = await api.writeNeedsReview(originalFilename, fileData);
        if (!result.success) {
          if (result.code === "ATTACHMENT_TOO_LARGE") {
            throw new AttachmentTooLargeError(
              originalFilename,
              result.error || "Attachment exceeds the maximum size",
            );
          }
          throw new Error(result.error ?? `Failed to write ${originalFilename} to Needs Review folder`);
        }
        if (result.savedName) {
          return result.savedName;
        }
      }
    },
    async deleteReview(name) {
      if (isElectron()) {
        const api = getElectronAPI();
        const result = await api.deleteNeedsReview(name);
        if (!result.success) {
          throw new Error(result.error ?? `Failed to delete ${name} from Needs Review folder`);
        }
      }
    },
  };
}