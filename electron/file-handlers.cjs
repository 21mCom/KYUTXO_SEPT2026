const path = require('path');
const { sanitizeIpcError, logMainError } = require('./security-utils.cjs');
const fs = require('fs');
const crypto = require('crypto');

// Hard cap on a single attachment's bytes, mirrored on the server
// (server/attachments.ts). Without it a restore/backup-stream write of an
// unbounded file lands on disk (and crosses IPC) unchecked. Overridable via
// registerFileHandlers options so tests can exercise the cap cheaply.
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MiB

// Filesystem-level containment, mirroring server/attachments.ts. The lexical
// checks in each handler reject `..`/absolute paths, but a SYMLINK planted
// inside the attachments tree (e.g. `attachments/evil -> /etc`) would still
// redirect reads/writes/deletes outside the data root. A symlink AT the target
// is ALWAYS rejected (lstat), even one pointing back inside the root —
// otherwise read/delete/rename would act on the link's TARGET under a
// different attachment's path (cross-attachment disclosure/loss), and a write
// would truncate that target. Existing non-link targets must realpath inside
// the root; for absent write targets the nearest existing ancestor must be
// inside the root.
// Returns the canonical absolute path when contained, null when it is a link
// or escapes.
// O_NOFOLLOW (Linux/macOS) makes the OPEN itself refuse a symlink at the final
// path component, closing the check-then-open race for that component; it is
// undefined on Windows, where the realpath containment checks still apply.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// THREAT MODEL: these handlers defend against PLANTED symlinks — links placed
// in the attachments tree by a crafted backup/restore or by earlier tampering
// — which are rejected (realpath containment) at operation time, with
// O_NOFOLLOW making the final open refuse a link swapped in after the check.
// A CONCURRENT local attacker racing the check-then-act interval on
// intermediate path components is OUT OF SCOPE: such an attacker already has
// write access to the vault's data directory and can read/modify attachments
// directly, so no pathname check could stop them.
function realpathContainedSync(baseDir, absPath, baseReal) {
  const base = baseReal || fs.realpathSync(baseDir);
  // Reject a symlink AT the target before any realpath resolution. lstat sees
  // the link itself (including dangling links), so this single check covers
  // both existing and dangling symlinks.
  try {
    if (fs.lstatSync(absPath).isSymbolicLink()) return null;
  } catch {
    // ENOENT: genuinely absent — the normal write-target case.
  }
  try {
    const real = fs.realpathSync(absPath);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return real;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let dir = path.dirname(absPath);
  // `tail` accumulates path components root-first (unshift prepends each
  // parent), so it is joined as-is — reversing it would target the WRONG
  // location (basename/dir instead of dir/basename).
  const tail = [path.basename(absPath)];
  for (;;) {
    try {
      const realDir = fs.realpathSync(dir);
      if (realDir !== base && !realDir.startsWith(base + path.sep)) return null;
      return path.join(realDir, ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root — not contained
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

// Lexical existence check. fs.existsSync FOLLOWS symlinks, so it reports a
// dangling symlink as absent — a following write would then escape through
// the link. lstat sees the link itself.
function lexistsSync(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Cryptographically random filename suffix (8 hex chars), replacing the old
// 3-char Math.random() suffix; collisions are additionally retried by callers
// via the 'wx' (O_EXCL) write flag.
function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

function registerFileHandlers(ipcMain, { dataDir, attachmentsDir, needsReviewDir, portableMode, maxAttachmentBytes }) {
  const maxAttachmentBytesLimit =
    typeof maxAttachmentBytes === 'number' && maxAttachmentBytes > 0
      ? maxAttachmentBytes
      : DEFAULT_MAX_ATTACHMENT_BYTES;
  // Stored attachment paths may or may not carry an `attachments/` prefix
  // depending on which backend wrote them: the Express server stores paths WITH
  // the prefix (relative to the data dir), while Electron stores them WITHOUT it
  // (relative to attachmentsDir). Strip a leading prefix so both forms resolve
  // here instead of producing an unreadable `attachmentsDir/attachments/...`.
  const stripAttachmentsPrefix = (p) =>
    typeof p === 'string' && p.startsWith('attachments/')
      ? p.slice('attachments/'.length)
      : p;

  // Needs Review accepts only one literal child filename. Unlike the write
  // path (which deliberately sanitizes legacy archive names), read/delete must
  // never silently substitute `dir/name` with `name`.
  const isLiteralNeedsReviewName = (name) =>
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !path.isAbsolute(name) &&
    path.basename(name) === name;

  // Return undefined when absent and null when present-but-unsafe. The folder
  // itself must be a real directory, not a symlink that redirects all review
  // operations elsewhere.
  const getNeedsReviewRoot = () => {
    try {
      const stat = fs.lstatSync(needsReviewDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
      const real = fs.realpathSync(needsReviewDir);
      if (real !== path.resolve(needsReviewDir)) return null;
      return real;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  };

  // Note: absolute data/attachments paths are deliberately NOT exposed over
  // IPC; the renderer only ever needs presence/mode flags.
  ipcMain.handle('is-portable-mode', () => {
    try {
      return portableMode;
    } catch (error) {
      logMainError('[KYUTXO] is-portable-mode failed', error);
      return false;
    }
  });

  ipcMain.handle('save-attachment', async (event, { identifier, filename, data }) => {
    try {
      const buffer = Buffer.from(data);
      if (buffer.byteLength > maxAttachmentBytesLimit) {
        return { success: false, error: `Attachment exceeds the maximum size of ${maxAttachmentBytesLimit} bytes` };
      }
      const sanitizedIdentifier = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
      const recordDir = path.join(attachmentsDir, sanitizedIdentifier);

      if (!fs.existsSync(recordDir)) {
        fs.mkdirSync(recordDir, { recursive: true });
      }

      // Containment: a symlink planted at (or above) the identifier directory
      // would redirect the write outside the attachments root even though
      // every name here is self-generated. Verify the REAL location first.
      const realDir = realpathContainedSync(attachmentsDir, recordDir);
      if (!realDir) {
        return { success: false, error: 'Access denied' };
      }

      // Unique filename: crypto-random suffix + O_EXCL write with collision
      // retry, so an existing file can never be overwritten or raced into.
      const ext = path.extname(filename);
      const baseName = path.basename(filename, ext);
      for (let attempt = 0; attempt < 10; attempt++) {
        const uniqueFilename = `${baseName}_${randomSuffix()}${ext}`;
        try {
          fs.writeFileSync(path.join(realDir, uniqueFilename), buffer, { flag: 'wx' });
          return { success: true, path: path.join(sanitizedIdentifier, uniqueFilename) };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      return { success: false, error: 'Could not allocate a unique filename' };
    } catch (error) {
      logMainError('[KYUTXO] save-attachment failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to save attachment') };
    }
  });

  ipcMain.handle('read-attachment', async (event, relativePath) => {
    try {
      if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) {
        return { success: false, error: 'Invalid relative path' };
      }
      const filePath = path.join(attachmentsDir, stripAttachmentsPrefix(relativePath));
      const resolvedPath = path.resolve(filePath);
      const resolvedAttachmentsDir = path.resolve(attachmentsDir);
      if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep) && resolvedPath !== resolvedAttachmentsDir) {
        return { success: false, error: 'Path traversal detected' };
      }
      try {
        fs.lstatSync(filePath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return { success: false, error: 'Attachment not found' };
        }
        throw error;
      }
      // Symlink containment: the file (or a directory above it) must not be a
      // symlink redirecting the read outside the attachments root.
      const realPath = realpathContainedSync(attachmentsDir, filePath);
      if (!realPath) {
        return { success: false, error: 'Access denied' };
      }
      // O_NOFOLLOW: the open itself refuses a symlink swapped in at the final
      // component after the containment check (no-op on Windows).
      let data;
      const fh = fs.openSync(realPath, fs.constants.O_RDONLY | NOFOLLOW);
      try {
        data = fs.readFileSync(fh);
      } finally {
        fs.closeSync(fh);
      }
      // Return exactly the file's bytes. fs.readFileSync can hand back a Buffer
      // that is a view into a larger shared pool (for small files), so exposing
      // `data.buffer` directly would leak unrelated pooled bytes and corrupt the
      // read. Slice the backing ArrayBuffer to this Buffer's exact window.
      const exact = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return { success: true, data: exact };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { success: false, error: 'Attachment not found' };
      }
      logMainError('[KYUTXO] read-attachment failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to read attachment') };
    }
  });

  ipcMain.handle('delete-attachment', async (event, relativePath) => {
    try {
      if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) {
        return { success: false, error: 'Invalid relative path' };
      }
      const filePath = path.join(attachmentsDir, stripAttachmentsPrefix(relativePath));
      const resolvedPath = path.resolve(filePath);
      const resolvedAttachmentsDir = path.resolve(attachmentsDir);
      if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep) && resolvedPath !== resolvedAttachmentsDir) {
        return { success: false, error: 'Path traversal detected' };
      }
      // Symlink containment: unlinking THROUGH a symlinked directory component
      // would delete a file outside the attachments root. Missing files stay
      // an idempotent success (lexical lstat, not existsSync, so a dangling
      // symlink is seen and refused rather than followed).
      if (lexistsSync(filePath)) {
        const realPath = realpathContainedSync(attachmentsDir, filePath);
        if (!realPath) {
          return { success: false, error: 'Access denied' };
        }
        fs.unlinkSync(realPath);
      }
      return { success: true };
    } catch (error) {
      logMainError('[KYUTXO] delete-attachment failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to delete attachment') };
    }
  });

  ipcMain.handle('list-attachments', async (event, identifier) => {
    try {
      const sanitizedIdentifier = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
      const recordDir = path.join(attachmentsDir, sanitizedIdentifier);
      
      if (!lexistsSync(recordDir)) {
        return { success: true, files: [] };
      }
      
      // Symlink containment: a planted link at the identifier directory must
      // not turn this listing into a disclosure of OUTSIDE directory contents.
      const realDir = realpathContainedSync(attachmentsDir, recordDir);
      if (!realDir) {
        return { success: false, error: 'Access denied' };
      }
      
      // Regular files only — planted links/sockets/subdirs are skipped.
      const files = fs
        .readdirSync(realDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
      return { success: true, files };
    } catch (error) {
      logMainError('[KYUTXO] list-attachments failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to list attachments') };
    }
  });

  ipcMain.handle('rename-attachment', async (event, { oldPath, newPath }) => {
    try {
      if (!oldPath || oldPath.includes('..') || path.isAbsolute(oldPath)) {
        return { success: false, error: 'Invalid old path' };
      }
      if (!newPath || newPath.includes('..') || path.isAbsolute(newPath)) {
        return { success: false, error: 'Invalid new path' };
      }

      const oldFilePath = path.join(attachmentsDir, stripAttachmentsPrefix(oldPath));
      const newFilePath = path.join(attachmentsDir, stripAttachmentsPrefix(newPath));

      const resolvedOld = path.resolve(oldFilePath);
      const resolvedNew = path.resolve(newFilePath);
      const resolvedBase = path.resolve(attachmentsDir);
      if (!resolvedOld.startsWith(resolvedBase + path.sep) || !resolvedNew.startsWith(resolvedBase + path.sep)) {
        return { success: false, error: 'Path traversal detected' };
      }

      if (!lexistsSync(oldFilePath)) {
        return { success: false, error: 'Source file not found' };
      }

      const newDir = path.dirname(newFilePath);
      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }

      // Symlink containment, checked AT OPERATION TIME (not validate-then-act)
      // so a directory swapped for a symlink after the checks above cannot
      // redirect the rename outside the attachments root (TOCTOU window).
      const baseReal = fs.realpathSync(attachmentsDir);
      const oldReal = realpathContainedSync(attachmentsDir, oldFilePath, baseReal);
      const newDirReal = realpathContainedSync(attachmentsDir, newDir, baseReal);
      if (!oldReal || !newDirReal) {
        return { success: false, error: 'Access denied' };
      }

      const destination = path.join(newDirReal, path.basename(newFilePath));
      try {
        // Atomic no-replace move: link fails with EEXIST for every existing
        // destination type and therefore can never overwrite attachment bytes.
        // Unlink only after the destination name safely references the source.
        try {
          fs.linkSync(oldReal, destination);
        } catch (error) {
          if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
            throw error;
          }
          // Portable FAT/exFAT volumes and mount boundaries may reject hard
          // links. Exclusive copy keeps the same no-clobber guarantee, and the
          // source is removed only after the full copy succeeds.
          fs.copyFileSync(oldReal, destination, fs.constants.COPYFILE_EXCL);
        }
      } catch (error) {
        if (error.code === 'EEXIST') {
          return { success: false, error: 'Destination file already exists' };
        }
        throw error;
      }
      fs.unlinkSync(oldReal);

      // Try to remove old directory if empty
      const oldDir = path.dirname(oldFilePath);
      try {
        const remaining = fs.readdirSync(oldDir);
        if (remaining.length === 0) {
          fs.rmdirSync(oldDir);
        }
      } catch {
        // Ignore cleanup errors
      }

      return { success: true };
    } catch (error) {
      logMainError('[KYUTXO] rename-attachment failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to rename attachment') };
    }
  });

  // List ALL attachments recursively (for backup)
  ipcMain.handle('list-all-attachments', async () => {
    try {
      const result = [];
      // Exact total bytes of every attachment FILE on disk. Stored uncompressed
      // in the backup ZIP, so this is the true number of bytes a restore writes —
      // the backup export records it in the manifest for an exact restore
      // disk-space estimate (more reliable than DB metadata, which can miss the
      // legacy root-level files this walk still includes).
      let totalBytes = 0;
      
      if (!fs.existsSync(attachmentsDir)) {
        return { success: true, files: [], totalBytes: 0 };
      }
      
      // Get all subdirectories (record identifiers)
      const entries = fs.readdirSync(attachmentsDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(attachmentsDir, entry.name);
          // withFileTypes so SYMLINKS inside the directory are visible as
          // links: a planted link to an outside file must be skipped, not
          // followed (statSync would follow it and leak the target's bytes
          // into the backup listing and size total).
          const files = fs.readdirSync(subDir, { withFileTypes: true });
          
          for (const file of files) {
            if (!file.isFile()) continue; // skips symlinks, sockets, subdirs
            // Return relative paths like "identifier/filename.ext"
            result.push(path.join(entry.name, file.name));
            try {
              totalBytes += fs.statSync(path.join(subDir, file.name)).size;
            } catch {
              // File vanished between readdir and stat — skip its bytes.
            }
          }
        } else if (entry.isFile()) {
          // Root-level (single-segment) legacy files. Without this branch they
          // are invisible to backups and the attachment audit, which makes them
          // look "missing" even though they are still on disk.
          result.push(entry.name);
          try {
            totalBytes += fs.statSync(path.join(attachmentsDir, entry.name)).size;
          } catch {
            // File vanished between readdir and stat — skip its bytes.
          }
        }
      }
      
      return { success: true, files: result, totalBytes };
    } catch (error) {
      logMainError('[KYUTXO] list-all-attachments failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to list attachments') };
    }
  });

  // Write attachment from backup (for restore)
  ipcMain.handle('write-attachment', async (event, { relativePath, data }) => {
    try {
      // Security: Validate relative path doesn't contain path traversal
      if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) {
        return { success: false, error: 'Invalid relative path' };
      }
      
      const filePath = path.join(attachmentsDir, stripAttachmentsPrefix(relativePath));
      
      // Security: Ensure resolved path is within attachmentsDir
      const resolvedPath = path.resolve(filePath);
      const resolvedAttachmentsDir = path.resolve(attachmentsDir);
      if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep) && resolvedPath !== resolvedAttachmentsDir) {
        return { success: false, error: 'Path traversal detected' };
      }
      
      const buffer = Buffer.from(data);
      if (buffer.byteLength > maxAttachmentBytesLimit) {
        // Distinct code so the restore writer can map this to the typed
        // AttachmentTooLargeError and skip just this file (parity with the
        // web endpoint's HTTP 413) instead of failing the whole restore.
        return {
          success: false,
          code: 'ATTACHMENT_TOO_LARGE',
          error: `Attachment exceeds the maximum size of ${maxAttachmentBytesLimit} bytes`,
        };
      }
      
      const dir = path.dirname(filePath);
      
      // Create directory if needed
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Symlink containment, checked AFTER mkdir (which follows symlinked
      // components) on the FULL target path: proves the directory being
      // written into is inside the root AND rejects a dangling symlink at the
      // target (a following write would create the linked file outside).
      const realFile = realpathContainedSync(attachmentsDir, filePath);
      if (!realFile) {
        return { success: false, error: 'Access denied' };
      }
      
      // O_NOFOLLOW: the open itself refuses a symlink swapped in at the final
      // component after the containment check (no-op on Windows).
      const fh = fs.openSync(
        realFile,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW,
      );
      try {
        fs.writeFileSync(fh, buffer);
      } finally {
        fs.closeSync(fh);
      }
      
      return { success: true };
    } catch (error) {
      logMainError('[KYUTXO] write-attachment failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to write attachment') };
    }
  });

  // Report free/total disk space on the filesystem that holds the attachments
  // directory. Used as a pre-flight check before a destructive restore so the
  // user can free space BEFORE the existing vault is cleared, instead of hitting
  // a disk-full failure mid-write (after the vault is already gone).
  ipcMain.handle('get-disk-space', async () => {
    try {
      // statfs needs an existing path; fall back to the parent if the
      // attachments dir has not been created yet on a fresh install.
      let target = attachmentsDir;
      if (!fs.existsSync(target)) {
        target = path.dirname(target);
      }
      const stats = await fs.promises.statfs(target);
      // bavail = blocks available to unprivileged users; bsize = block size.
      const freeBytes = stats.bavail * stats.bsize;
      const totalBytes = stats.blocks * stats.bsize;
      return { success: true, freeBytes, totalBytes };
    } catch (error) {
      logMainError('[KYUTXO] get-disk-space failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to check disk space') };
    }
  });

  // Sum the byte sizes of every attachment file on disk. Used as the dominant
  // term in a pre-flight export size estimate: attachment files are stored
  // UNCOMPRESSED in the v3 backup ZIP, so their total size is a solid lower
  // bound on the bytes a streaming export will write to disk. Lets the user be
  // warned about low disk space BEFORE a partial/truncated archive is written.
  ipcMain.handle('get-attachments-size', async () => {
    try {
      if (!fs.existsSync(attachmentsDir)) {
        return { success: true, totalBytes: 0, fileCount: 0 };
      }
      let totalBytes = 0;
      let fileCount = 0;
      const entries = await fs.promises.readdir(attachmentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(attachmentsDir, entry.name);
          let dirents;
          try {
            // withFileTypes so planted SYMLINKS are skipped, not followed
            // (statSync would follow a link and count outside bytes).
            dirents = await fs.promises.readdir(subDir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const dirent of dirents) {
            if (!dirent.isFile()) continue;
            try {
              const stat = await fs.promises.stat(path.join(subDir, dirent.name));
              if (stat.isFile()) {
                totalBytes += stat.size;
                fileCount += 1;
              }
            } catch {
              // Skip files that vanished or cannot be stat'd.
            }
          }
        } else if (entry.isFile()) {
          try {
            const stat = await fs.promises.stat(path.join(attachmentsDir, entry.name));
            totalBytes += stat.size;
            fileCount += 1;
          } catch {
            // Skip files that vanished or cannot be stat'd.
          }
        }
      }
      return { success: true, totalBytes, fileCount };
    } catch (error) {
      logMainError('[KYUTXO] get-attachments-size failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to measure attachments size') };
    }
  });

  // Write an orphaned attachment to the Needs Review folder under its original
  // filename, de-duping name collisions by appending _1, _2, ... before the
  // extension. Returns the saved (possibly de-duped) filename.
  ipcMain.handle('write-needs-review', async (event, { filename, data }) => {
    try {
      if (!filename || typeof filename !== 'string') {
        return { success: false, error: 'Invalid filename' };
      }
      // Sanitize: strip any path separators so callers cannot escape the folder.
      const safeName = path.basename(filename);
      if (!safeName) {
        return { success: false, error: 'Invalid filename' };
      }

      // Ensure the Needs Review folder exists (it may have been removed by the
      // user or not yet created on first run).
      if (!lexistsSync(needsReviewDir)) {
        fs.mkdirSync(needsReviewDir, { recursive: true });
      }
      const reviewRoot = getNeedsReviewRoot();
      if (!reviewRoot) {
        return { success: false, error: 'Access denied' };
      }

      // De-duplicate: if <name> already exists, try <stem>_1<ext>, _2, ...
      // lexistsSync (lstat) so a DANGLING SYMLINK at a candidate name counts
      // as taken — existsSync would follow the link, report it absent, and a
      // following write would land OUTSIDE the folder.
      const ext = path.extname(safeName);
      const stem = safeName.slice(0, safeName.length - ext.length);
      let candidate = safeName;
      let counter = 0;
      const buffer = Buffer.from(data);
      if (buffer.byteLength > maxAttachmentBytesLimit) {
        // Distinct code so the restore writer can map this to the typed
        // AttachmentTooLargeError and skip just this orphaned file (parity
        // with write-attachment) instead of failing the whole restore.
        return {
          success: false,
          code: 'ATTACHMENT_TOO_LARGE',
          error: `Attachment exceeds the maximum size of ${maxAttachmentBytesLimit} bytes`,
        };
      }
      // O_EXCL + O_NOFOLLOW: never overwrite or follow an existing candidate,
      // including one substituted after the lstat collision check.
      for (;;) {
        const dest = path.join(reviewRoot, candidate);
        try {
          const fh = fs.openSync(
            dest,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
            0o600,
          );
          try {
            fs.writeFileSync(fh, buffer);
          } finally {
            fs.closeSync(fh);
          }
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          counter++;
          candidate = `${stem}_${counter}${ext}`;
        }
      }
      // Return the folder-relative name only; absolute paths stay main-side.
      return { success: true, savedName: candidate };
    } catch (error) {
      logMainError('[KYUTXO] write-needs-review failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to save file to the Needs Review folder') };
    }
  });

  // Open the Needs Review folder in the OS file manager.
  ipcMain.handle('open-needs-review-folder', async () => {
    try {
      if (!lexistsSync(needsReviewDir)) {
        fs.mkdirSync(needsReviewDir, { recursive: true });
      }
      const reviewRoot = getNeedsReviewRoot();
      if (!reviewRoot) {
        return { success: false, error: 'Access denied' };
      }
      const { shell } = require('electron');
      await shell.openPath(reviewRoot);
      return { success: true };
    } catch (error) {
      logMainError('[KYUTXO] open-needs-review-folder failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to open the Needs Review folder') };
    }
  });

  // List the orphaned attachment files currently in the Needs Review folder.
  // Returns one entry per regular file with its name, byte size, and the time
  // it was routed there (mtime — written once on route, never touched after).
  ipcMain.handle('list-needs-review', async () => {
    try {
      const reviewRoot = getNeedsReviewRoot();
      if (reviewRoot === undefined) {
        return { success: true, files: [] };
      }
      if (reviewRoot === null) {
        return { success: false, error: 'Access denied' };
      }
      const names = await fs.promises.readdir(reviewRoot);
      const files = [];
      for (const name of names) {
        const full = path.join(reviewRoot, name);
        try {
          const stat = await fs.promises.lstat(full);
          if (!stat.isFile()) continue;
          files.push({
            name,
            size: stat.size,
            routedAt: stat.mtimeMs,
          });
        } catch {
          // Skip entries that vanished or cannot be stat'd between readdir and stat.
        }
      }
      // Newest first so the most recently routed orphans surface at the top.
      files.sort((a, b) => b.routedAt - a.routedAt);
      return { success: true, files };
    } catch (error) {
      logMainError('[KYUTXO] list-needs-review failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to list Needs Review files') };
    }
  });

  // Read the raw bytes of a single Needs Review file (for re-attaching it to a
  // record). The name is sanitized so callers cannot escape the folder.
  ipcMain.handle('read-needs-review', async (event, { name }) => {
    try {
      if (!isLiteralNeedsReviewName(name)) {
        return { success: false, error: 'Invalid filename' };
      }
      const reviewRoot = getNeedsReviewRoot();
      if (reviewRoot === undefined) {
        return { success: false, error: 'File not found' };
      }
      if (reviewRoot === null) {
        return { success: false, error: 'Access denied' };
      }
      const target = path.join(reviewRoot, name);
      try {
        fs.lstatSync(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { success: false, error: 'File not found' };
      }
      const realTarget = realpathContainedSync(reviewRoot, target, reviewRoot);
      if (!realTarget) {
        return { success: false, error: 'Access denied' };
      }
      const fh = await fs.promises.open(realTarget, fs.constants.O_RDONLY | NOFOLLOW);
      let data;
      try {
        data = await fh.readFile();
      } finally {
        await fh.close();
      }
      // Slice to this file's own bytes — never hand back the pooled Buffer's
      // underlying ArrayBuffer, which may include unrelated neighbouring bytes.
      return {
        success: true,
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      };
    } catch (error) {
      logMainError('[KYUTXO] read-needs-review failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to read Needs Review file') };
    }
  });

  // Delete a single Needs Review file (after the user resolves it). The name is
  // sanitized so callers cannot escape the folder.
  ipcMain.handle('delete-needs-review', async (event, { name }) => {
    try {
      if (!isLiteralNeedsReviewName(name)) {
        return { success: false, error: 'Invalid filename' };
      }
      const reviewRoot = getNeedsReviewRoot();
      if (reviewRoot === undefined) {
        return { success: true };
      }
      if (reviewRoot === null) {
        return { success: false, error: 'Access denied' };
      }
      const target = path.join(reviewRoot, name);
      try {
        fs.lstatSync(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Already gone — treat as success so the UI converges to a clean state.
        return { success: true };
      }
      const realTarget = realpathContainedSync(reviewRoot, target, reviewRoot);
      if (!realTarget) {
        return { success: false, error: 'Access denied' };
      }
      await fs.promises.unlink(realTarget);
      return { success: true };
    } catch (error) {
      logMainError('[KYUTXO] delete-needs-review failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to delete Needs Review file') };
    }
  });

  // --- One-click demo vault (presenters) -------------------------------------
  // The demo vault zip (kyutxo-demo-vault.zip) is intentionally NOT bundled
  // with the app. A presenter can instead drop an on-disk copy in one of two
  // documented locations, checked in this order:
  //   1. Next to the executable:   <dir of the app binary>/kyutxo-demo-vault.zip
  //   2. In the data directory:    <dataDir>/kyutxo-demo-vault.zip
  //      (dataDir is userData in installed builds, ./kyutxo-data in portable mode)
  // When present, the renderer's "Load demo vault" button skips the file picker
  // and streams the zip straight through these handlers. Only this fixed
  // filename in these two fixed locations is ever readable — no renderer-chosen
  // paths cross the bridge.
  const DEMO_VAULT_FILENAME = 'kyutxo-demo-vault.zip';
  const DEMO_VAULT_CHUNK_BYTES = 4 * 1024 * 1024;

  const findDemoVault = () => {
    const candidates = [
      path.join(path.dirname(process.execPath), DEMO_VAULT_FILENAME),
      path.join(dataDir, DEMO_VAULT_FILENAME),
    ];
    for (const candidate of candidates) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          return { filePath: candidate, size: stat.size };
        }
      } catch {
        // Not present at this candidate — try the next.
      }
    }
    return null;
  };

  // Presence probe: lets the renderer decide between one-click load (present)
  // and the web-style file picker (absent) without reading any bytes.
  ipcMain.handle('check-demo-vault', () => {
    try {
      const found = findDemoVault();
      if (!found) return { present: false };
      // Absolute paths never cross the IPC bridge; presence + size suffice.
      return { present: true, size: found.size };
    } catch (error) {
      logMainError('[KYUTXO] check-demo-vault failed', error);
      return { present: false, error: sanitizeIpcError(error, 'Failed to check for the demo vault') };
    }
  });

  // Stateless chunked read: the renderer pulls sequential windows so the whole
  // zip never has to be buffered in main-process memory. The path is
  // re-resolved per call (cheap; chunks are 4 MB) so no open-handle state can
  // leak if the renderer abandons a read mid-stream.
  ipcMain.handle('read-demo-vault', async (event, { offset }) => {
    try {
      if (!Number.isInteger(offset) || offset < 0) {
        return { success: false, error: 'Invalid offset' };
      }
      const found = findDemoVault();
      if (!found) {
        return { success: false, error: 'Demo vault file not found' };
      }
      const handle = await fs.promises.open(found.filePath, 'r');
      try {
        const buffer = Buffer.alloc(DEMO_VAULT_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, DEMO_VAULT_CHUNK_BYTES, offset);
        // Slice to exactly the bytes read — never expose a Buffer's backing
        // ArrayBuffer directly (pooled Buffers share it with unrelated data).
        const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead);
        return {
          success: true,
          data,
          bytesRead,
          eof: offset + bytesRead >= found.size || bytesRead === 0,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      logMainError('[KYUTXO] read-demo-vault failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to read the demo vault') };
    }
  });

  // --- Streaming backup writer (for export) ---------------------------------
  // The renderer streams ZIP byte-chunks straight to a user-chosen file via a
  // Node write stream, so the full archive never has to be buffered in memory.
  // This is the scale-safe desktop path and does not depend on the browser's
  // File System Access API (which may be unavailable inside Electron).
  const backupStreams = new Map();
  let backupSeq = 0;

  ipcMain.handle('backup-open', async (event, { suggestedName }) => {
    try {
      const { dialog, BrowserWindow } = require('electron');
      const win = BrowserWindow.fromWebContents(event.sender);
      const defaultName =
        typeof suggestedName === 'string' && suggestedName ? suggestedName : 'kyutxo-backup.zip';
      const result = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters: [{ name: 'KYUTXO Backup', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
      const stream = fs.createWriteStream(result.filePath);
      await new Promise((resolve, reject) => {
        stream.once('open', resolve);
        stream.once('error', reject);
      });
      const id = `backup_${++backupSeq}`;
      backupStreams.set(id, { stream, filePath: result.filePath });
      // The absolute save path stays main-side; the renderer only needs the
      // opaque stream id.
      return { success: true, id };
    } catch (error) {
      logMainError('[KYUTXO] backup-open failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to open the backup file for writing') };
    }
  });

  ipcMain.handle('backup-write', async (event, { id, data }) => {
    try {
      const entry = backupStreams.get(id);
      if (!entry) return { success: false, error: 'Unknown backup stream' };
      const buffer = Buffer.from(data);
      await new Promise((resolve, reject) => {
        entry.stream.write(buffer, (err) => (err ? reject(err) : resolve()));
      });
      return { success: true };
    } catch (error) {
      logMainError('[KYUTXO] backup-write failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to write to the backup file') };
    }
  });

  ipcMain.handle('backup-close', async (event, { id }) => {
    try {
      const entry = backupStreams.get(id);
      if (!entry) return { success: false, error: 'Unknown backup stream' };
      await new Promise((resolve, reject) => {
        entry.stream.end((err) => (err ? reject(err) : resolve()));
      });
      backupStreams.delete(id);
      return { success: true };
    } catch (error) {
      logMainError('[KYUTXO] backup-close failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to finalize the backup file') };
    }
  });

  ipcMain.handle('backup-abort', async (event, { id }) => {
    try {
      const entry = backupStreams.get(id);
      if (!entry) return { success: true };
      entry.stream.destroy();
      backupStreams.delete(id);
      try {
        fs.unlinkSync(entry.filePath);
      } catch {
        // Best effort: the partial file may already be gone.
      }
      return { success: true };
    } catch (error) {
      logMainError('[KYUTXO] backup-abort failed', error);
      return { success: false, error: sanitizeIpcError(error, 'Failed to abort the backup') };
    }
  });
}

module.exports = { registerFileHandlers };
