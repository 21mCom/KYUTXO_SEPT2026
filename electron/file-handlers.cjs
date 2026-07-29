const path = require('path');
const fs = require('fs');

function registerFileHandlers(ipcMain, { dataDir, attachmentsDir, needsReviewDir, portableMode }) {
  // Stored attachment paths may or may not carry an `attachments/` prefix
  // depending on which backend wrote them: the Express server stores paths WITH
  // the prefix (relative to the data dir), while Electron stores them WITHOUT it
  // (relative to attachmentsDir). Strip a leading prefix so both forms resolve
  // here instead of producing an unreadable `attachmentsDir/attachments/...`.
  const stripAttachmentsPrefix = (p) =>
    typeof p === 'string' && p.startsWith('attachments/')
      ? p.slice('attachments/'.length)
      : p;

  ipcMain.handle('get-app-data-path', () => {
    return require('electron').app.getPath('userData');
  });

  ipcMain.handle('get-data-path', () => {
    return dataDir;
  });

  ipcMain.handle('get-attachments-path', () => {
    return attachmentsDir;
  });

  ipcMain.handle('is-portable-mode', () => {
    return portableMode;
  });

  ipcMain.handle('save-attachment', async (event, { identifier, filename, data }) => {
    try {
      const sanitizedIdentifier = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
      const recordDir = path.join(attachmentsDir, sanitizedIdentifier);
      
      if (!fs.existsSync(recordDir)) {
        fs.mkdirSync(recordDir, { recursive: true });
      }
      
      // Add 3-character random suffix to prevent overwrites
      const randomSuffix = Math.random().toString(36).substring(2, 5);
      const ext = path.extname(filename);
      const baseName = path.basename(filename, ext);
      const uniqueFilename = `${baseName}_${randomSuffix}${ext}`;
      
      const filePath = path.join(recordDir, uniqueFilename);
      const buffer = Buffer.from(data);
      fs.writeFileSync(filePath, buffer);
      
      return { success: true, path: path.join(sanitizedIdentifier, uniqueFilename) };
    } catch (error) {
      return { success: false, error: error.message };
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
      const data = fs.readFileSync(filePath);
      // Return exactly the file's bytes. fs.readFileSync can hand back a Buffer
      // that is a view into a larger shared pool (for small files), so exposing
      // `data.buffer` directly would leak unrelated pooled bytes and corrupt the
      // read. Slice the backing ArrayBuffer to this Buffer's exact window.
      const exact = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return { success: true, data: exact };
    } catch (error) {
      return { success: false, error: error.message };
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
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('list-attachments', async (event, identifier) => {
    try {
      const sanitizedIdentifier = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
      const recordDir = path.join(attachmentsDir, sanitizedIdentifier);
      
      if (!fs.existsSync(recordDir)) {
        return { success: true, files: [] };
      }
      
      const files = fs.readdirSync(recordDir);
      return { success: true, files };
    } catch (error) {
      return { success: false, error: error.message };
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

      if (!fs.existsSync(oldFilePath)) {
        return { success: false, error: 'Source file not found' };
      }

      const newDir = path.dirname(newFilePath);
      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }

      fs.renameSync(oldFilePath, newFilePath);

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
      return { success: false, error: error.message };
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
          const files = fs.readdirSync(subDir);
          
          for (const file of files) {
            // Return relative paths like "identifier/filename.ext"
            result.push(path.join(entry.name, file));
            try {
              totalBytes += fs.statSync(path.join(subDir, file)).size;
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
      return { success: false, error: error.message };
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
      
      const dir = path.dirname(filePath);
      
      // Create directory if needed
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const buffer = Buffer.from(data);
      fs.writeFileSync(filePath, buffer);
      
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
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
      return { success: false, error: error.message };
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
          let names;
          try {
            names = await fs.promises.readdir(subDir);
          } catch {
            continue;
          }
          for (const name of names) {
            try {
              const stat = await fs.promises.stat(path.join(subDir, name));
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
      return { success: false, error: error.message };
    }
  });

  // Get the path of the Needs Review folder (for display in UI after restore).
  ipcMain.handle('get-needs-review-path', () => {
    return needsReviewDir;
  });

  // Write an orphaned attachment to the Needs Review folder under its original
  // filename, de-duping name collisions by appending _1, _2, ... before the
  // extension. Returns the absolute path of the file that was written.
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
      if (!fs.existsSync(needsReviewDir)) {
        fs.mkdirSync(needsReviewDir, { recursive: true });
      }

      // De-duplicate: if <name> already exists, try <stem>_1<ext>, _2, ...
      const ext = path.extname(safeName);
      const stem = safeName.slice(0, safeName.length - ext.length);
      let candidate = safeName;
      let counter = 0;
      while (fs.existsSync(path.join(needsReviewDir, candidate))) {
        counter++;
        candidate = `${stem}_${counter}${ext}`;
      }

      const dest = path.join(needsReviewDir, candidate);
      const buffer = Buffer.from(data);
      fs.writeFileSync(dest, buffer);
      return { success: true, savedPath: dest };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Open the Needs Review folder in the OS file manager.
  ipcMain.handle('open-needs-review-folder', async () => {
    try {
      if (!fs.existsSync(needsReviewDir)) {
        fs.mkdirSync(needsReviewDir, { recursive: true });
      }
      const { shell } = require('electron');
      await shell.openPath(needsReviewDir);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // List the orphaned attachment files currently in the Needs Review folder.
  // Returns one entry per regular file with its name, byte size, and the time
  // it was routed there (mtime — written once on route, never touched after).
  ipcMain.handle('list-needs-review', async () => {
    try {
      if (!fs.existsSync(needsReviewDir)) {
        return { success: true, files: [] };
      }
      const names = await fs.promises.readdir(needsReviewDir);
      const files = [];
      for (const name of names) {
        const full = path.join(needsReviewDir, name);
        try {
          const stat = await fs.promises.stat(full);
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
      return { success: false, error: error.message };
    }
  });

  // Read the raw bytes of a single Needs Review file (for re-attaching it to a
  // record). The name is sanitized so callers cannot escape the folder.
  ipcMain.handle('read-needs-review', async (event, { name }) => {
    try {
      if (!name || typeof name !== 'string') {
        return { success: false, error: 'Invalid filename' };
      }
      const safeName = path.basename(name);
      if (!safeName) {
        return { success: false, error: 'Invalid filename' };
      }
      const target = path.join(needsReviewDir, safeName);
      if (!fs.existsSync(target)) {
        return { success: false, error: 'File not found' };
      }
      const data = await fs.promises.readFile(target);
      // Slice to this file's own bytes — never hand back the pooled Buffer's
      // underlying ArrayBuffer, which may include unrelated neighbouring bytes.
      return {
        success: true,
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Delete a single Needs Review file (after the user resolves it). The name is
  // sanitized so callers cannot escape the folder.
  ipcMain.handle('delete-needs-review', async (event, { name }) => {
    try {
      if (!name || typeof name !== 'string') {
        return { success: false, error: 'Invalid filename' };
      }
      const safeName = path.basename(name);
      if (!safeName) {
        return { success: false, error: 'Invalid filename' };
      }
      const target = path.join(needsReviewDir, safeName);
      if (!fs.existsSync(target)) {
        // Already gone — treat as success so the UI converges to a clean state.
        return { success: true };
      }
      await fs.promises.unlink(target);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
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
      return { present: true, path: found.filePath, size: found.size };
    } catch (error) {
      return { present: false, error: error.message };
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
      return { success: false, error: error.message };
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
      return { success: true, id, filePath: result.filePath };
    } catch (error) {
      return { success: false, error: error.message };
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
      return { success: false, error: error.message };
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
      return { success: false, error: error.message };
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
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerFileHandlers };
