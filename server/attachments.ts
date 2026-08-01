import { Router, type Request } from 'express';
import multer from 'multer';
import * as fs from 'fs/promises';
import * as path from 'path';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Data directory for local file storage
const DATA_DIR = process.env.KYUTXO_DATA_DIR || path.join(process.cwd(), 'data');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

// Ensure attachments directory exists
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
}

// Log a filesystem/IO failure server-side WITHOUT the raw error message: Node
// error messages embed absolute filesystem paths (ENOENT '/home/...'), which
// are internal detail that should not reach logs any more than clients. The
// error name + errno code are enough to diagnose.
function logServerError(context: string, error: unknown): void {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(`${context}: ${error.name}${code ? ` (${code})` : ''}`);
  } else {
    console.error(`${context}: unknown error`);
  }
}

// Build an RFC 6266 Content-Disposition header value. The plain filename=
// fallback is restricted to printable ASCII with quotes/backslashes/control
// chars (incl. CR/LF header injection) stripped; the RFC 5987 filename*=
// parameter carries the full UTF-8 name for modern clients.
export function toContentDisposition(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Safely resolve a caller-supplied relative attachment path to an absolute path
// inside ATTACHMENTS_DIR. Strips a leading `attachments/` prefix (Electron stores
// without it), rejects absolute paths and any `..` traversal segment, and enforces
// a path-separator boundary so a sibling directory like `attachments_evil` cannot
// satisfy the check by string prefix alone. Returns null when the path is unsafe.
export function resolveAttachmentPath(relativePath: unknown): string | null {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  const stripped = relativePath.startsWith('attachments/')
    ? relativePath.slice('attachments/'.length)
    : relativePath;
  if (path.isAbsolute(stripped)) return null;
  const segments = stripped.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) return null;
  const base = path.resolve(ATTACHMENTS_DIR);
  const resolved = path.resolve(base, stripped);
  // Require the resolved path to be strictly INSIDE the attachments dir. Every
  // legitimate attachment is a file with a name, so the base directory itself
  // (e.g. an empty path or "attachments/") is never a valid target.
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Sanitize identifier for use as directory name
function sanitizeIdentifier(identifier: string): string {
  if (!identifier) return 'unknown';
  
  // Replace unsafe characters with underscores
  // Keep alphanumeric, hyphens, and some safe chars
  let sanitized = identifier
    .replace(/[<>:"/\\|?*]/g, '_')  // Windows unsafe chars
    .replace(/\s+/g, '_')           // Whitespace
    .replace(/\.+/g, '_')           // Multiple dots
    .replace(/_+/g, '_')            // Multiple underscores
    .replace(/^_|_$/g, '');         // Leading/trailing underscores
  
  // Limit length to avoid filesystem issues (max 200 chars for directory name)
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200);
  }
  
  // Fallback if completely empty after sanitization
  return sanitized || 'unknown';
}

// Upload attachment
router.post('/upload', upload.single('file'), async (req: Request, res) => {
  try {
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { identifier, recordId } = req.body;
    
    if (!identifier) {
      return res.status(400).json({ error: 'Identifier (address/txid) is required' });
    }

    // Create directory based on sanitized identifier
    const sanitizedId = sanitizeIdentifier(identifier);
    const attachmentDir = path.join(ATTACHMENTS_DIR, sanitizedId);
    await ensureDir(attachmentDir);

    // Create unique filename with 3-char random suffix to prevent overwrites
    const randomSuffix = Math.random().toString(36).substring(2, 5);
    const safeFilename = file.originalname.replace(/[<>:"/\\|?*]/g, '_');
    const ext = path.extname(safeFilename);
    const baseName = path.basename(safeFilename, ext);
    const filename = `${baseName}_${randomSuffix}${ext}`;
    const filePath = path.join(attachmentDir, filename);
    
    // Write file to local filesystem
    await fs.writeFile(filePath, file.buffer);

    // Return relative path for storage in database
    const relativePath = path.join('attachments', sanitizedId, filename);

    res.json({
      objectStoragePath: relativePath,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    });
  } catch (error) {
    logServerError('Upload error', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// List ALL attachments recursively (for backup) - MUST be before wildcard routes
router.get('/list-all', async (req, res) => {
  try {
    await ensureDir(ATTACHMENTS_DIR);
    
    const result: string[] = [];
    // Exact total bytes of every attachment FILE on disk. Stored uncompressed in
    // the backup ZIP, so this is the true number of bytes a restore writes — the
    // backup export records it in the manifest for an exact restore disk-space
    // estimate (more reliable than DB metadata, which can miss legacy
    // root-level files that this walk still includes).
    let totalBytes = 0;
    
    try {
      const entries = await fs.readdir(ATTACHMENTS_DIR, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(ATTACHMENTS_DIR, entry.name);
          const files = await fs.readdir(subDir);
          
          for (const file of files) {
            // Return relative paths like "identifier/filename.ext"
            result.push(path.join(entry.name, file));
            try {
              totalBytes += (await fs.stat(path.join(subDir, file))).size;
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
            totalBytes += (await fs.stat(path.join(ATTACHMENTS_DIR, entry.name))).size;
          } catch {
            // File vanished between readdir and stat — skip its bytes.
          }
        }
      }
    } catch (error) {
      // Directory doesn't exist yet - return empty
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.json({ success: true, files: [], totalBytes: 0 });
      }
      throw error;
    }
    
    res.json({ success: true, files: result, totalBytes });
  } catch (error) {
    logServerError('List all attachments error', error);
    res.status(500).json({ error: 'List failed' });
  }
});

// Write attachment from backup (for restore) - MUST be before wildcard routes
router.post('/write', upload.single('file'), async (req: Request, res) => {
  try {
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { relativePath } = req.body;
    
    if (!relativePath) {
      return res.status(400).json({ error: 'Relative path is required' });
    }

    // Security check: ensure path stays within ATTACHMENTS_DIR
    const filePath = resolveAttachmentPath(relativePath);
    if (!filePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create directory if needed
    const dir = path.dirname(filePath);
    await ensureDir(dir);
    
    // Write file
    await fs.writeFile(filePath, file.buffer);

    res.json({ success: true });
  } catch (error) {
    logServerError('Write attachment error', error);
    res.status(500).json({ error: 'Write failed' });
  }
});

// Rename/move an attachment file (for path migration)
router.post('/rename', async (req: Request, res) => {
  try {
    const { oldPath, newPath } = req.body;
    
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'Both oldPath and newPath are required' });
    }

    const oldFilePath = resolveAttachmentPath(oldPath);
    const newFilePath = resolveAttachmentPath(newPath);
    if (!oldFilePath || !newFilePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    try {
      await fs.access(oldFilePath);
    } catch {
      return res.status(404).json({ error: 'Source file not found' });
    }

    const newDir = path.dirname(newFilePath);
    await ensureDir(newDir);

    await fs.rename(oldFilePath, newFilePath);

    // Try to remove old directory if empty
    const oldDir = path.dirname(oldFilePath);
    try {
      const remaining = await fs.readdir(oldDir);
      if (remaining.length === 0) {
        await fs.rmdir(oldDir);
      }
    } catch {
      // Ignore cleanup errors
    }

    res.json({ success: true });
  } catch (error) {
    logServerError('Rename error', error);
    res.status(500).json({ error: 'Rename failed' });
  }
});

// Download attachment
router.get('/download/:path(*)', async (req, res) => {
  try {
    const relativePath = req.params.path;
    // Resolve against ATTACHMENTS_DIR regardless of whether the stored path
    // carries an `attachments/` prefix (Electron stores without it). This keeps
    // both prefixed and non-prefixed paths readable while rejecting traversal.
    const filePath = resolveAttachmentPath(relativePath);
    if (!filePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    const buffer = await fs.readFile(filePath);
    const filename = path.basename(filePath);
    
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', toContentDisposition(filename));
    res.send(buffer);
  } catch (error) {
    logServerError('Download error', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Delete attachment
router.delete('/:path(*)', async (req, res) => {
  try {
    const relativePath = req.params.path;
    // Resolve against ATTACHMENTS_DIR regardless of whether the stored path
    // carries an `attachments/` prefix (Electron stores without it).
    const filePath = resolveAttachmentPath(relativePath);
    if (!filePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    try {
      await fs.unlink(filePath);
    } catch (error) {
      // File doesn't exist - treat as success for idempotent deletes
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.json({ success: true, alreadyDeleted: true });
      }
      throw error;
    }

    res.json({ success: true });
  } catch (error) {
    logServerError('Delete error', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

export default router;
