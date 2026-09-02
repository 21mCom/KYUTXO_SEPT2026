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
          // Size-cap rejection = this ONE file exceeds the desktop cap. Throw
          // the typed error so the restore skips the file with a per-file
          // warning (same contract as the web branch's HTTP 413) instead of
          // failing the whole restore over it.
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
        formData.append('file', new Blob([fileData]));
        formData.append('relativePath', relativePath);
        const response = await fetch('/api/attachments/write', {
          method: 'POST',
          body: formData,
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          // 413 = this ONE file exceeds the server's size cap. Throw the typed
          // error so the restore skips the file with a per-file warning instead
          // of failing the whole restore over it.
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
    // Used to sweep files this restore wrote if it fails/cancels after
    // the destructive clear, AND to reclaim OLD-vault files a successful
    // restore left behind, so neither is stranded on disk.
    async delete(relativePath) {
      await deleteFile(`${ATTACHMENTS_DIR}/${relativePath}`);
    },
    // Snapshot of every attachment file on disk before the write phase,
    // so a successful restore can delete prior-vault files the new vault
    // does not reference (relative paths, no `attachments/` prefix).
    async list() {
      if (isElectron()) {
        const api = getElectronAPI();
        const result = await api.listAllAttachments();
        if (!result.success) {
          throw new Error(result.error || "Failed to list attachments");
        }
        return result.files ?? [];
      }
      const response = await fetch("/api/attachments/list-all");
      if (!response.ok) {
        throw new Error(`Failed to list attachments: ${response.status}`);
      }
      const data = await response.json();
      return data.files ?? [];
    },
    // Orphaned files: owning record absent. Route to Needs Review folder
    // under the original filename. Best-effort in Electron; no-op in web.
    // Returns the FINAL filename written (the folder de-dupes collisions) so
    // a cancelled merge can undo exactly that file via deleteReview().
    async writeReview(originalFilename, fileData) {
      if (isElectron()) {
        const api = getElectronAPI();
        const result = await api.writeNeedsReview(originalFilename, fileData);
        if (!result.success) {
          // Size-cap rejection = this ONE orphaned file exceeds the desktop
          // cap. Throw the typed error so the restore records it as an
          // oversized skip (named in the summary) instead of a generic
          // best-effort loss — and never as a restore-fatal failure.
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
    // Remove a Needs Review file previously reported by writeReview(); used by
    // the merge-cancel undo pass. No-op in web (writeReview is too).
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
