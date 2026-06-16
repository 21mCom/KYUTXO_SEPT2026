const path = require('path');
const fs = require('fs');

function registerFileHandlers(ipcMain, { dataDir, attachmentsDir, portableMode }) {
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
      return { success: true, data: data.buffer };
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
      
      if (!fs.existsSync(attachmentsDir)) {
        return { success: true, files: [] };
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
          }
        } else if (entry.isFile()) {
          // Root-level (single-segment) legacy files. Without this branch they
          // are invisible to backups and the attachment audit, which makes them
          // look "missing" even though they are still on disk.
          result.push(entry.name);
        }
      }
      
      return { success: true, files: result };
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
