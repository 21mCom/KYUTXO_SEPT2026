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
    console.error('Upload error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Upload failed' });
  }
});

// List ALL attachments recursively (for backup) - MUST be before wildcard routes
router.get('/list-all', async (req, res) => {
  try {
    await ensureDir(ATTACHMENTS_DIR);
    
    const result: string[] = [];
    
    try {
      const entries = await fs.readdir(ATTACHMENTS_DIR, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(ATTACHMENTS_DIR, entry.name);
          const files = await fs.readdir(subDir);
          
          for (const file of files) {
            // Return relative paths like "identifier/filename.ext"
            result.push(path.join(entry.name, file));
          }
        }
      }
    } catch (error) {
      // Directory doesn't exist yet - return empty
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.json({ success: true, files: [] });
      }
      throw error;
    }
    
    res.json({ success: true, files: result });
  } catch (error) {
    console.error('List all attachments error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'List failed' });
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
    const filePath = path.join(ATTACHMENTS_DIR, relativePath);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(ATTACHMENTS_DIR))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create directory if needed
    const dir = path.dirname(filePath);
    await ensureDir(dir);
    
    // Write file
    await fs.writeFile(filePath, file.buffer);

    res.json({ success: true });
  } catch (error) {
    console.error('Write attachment error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Write failed' });
  }
});

// Rewrite attachment (for password change re-encryption) - overwrites existing file
router.post('/rewrite', upload.single('file'), async (req: Request, res) => {
  try {
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { objectPath } = req.body;
    
    if (!objectPath) {
      return res.status(400).json({ error: 'Object path is required' });
    }

    // Security check: ensure path stays within DATA_DIR
    const filePath = path.join(DATA_DIR, objectPath);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(DATA_DIR))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check file exists before overwriting
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Overwrite file with new encrypted content
    await fs.writeFile(filePath, file.buffer);

    res.json({ success: true });
  } catch (error) {
    console.error('Rewrite attachment error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Rewrite failed' });
  }
});

// Download attachment
router.get('/download/:path(*)', async (req, res) => {
  try {
    const relativePath = req.params.path;
    const filePath = path.join(DATA_DIR, relativePath);

    // Security check: ensure path is within DATA_DIR
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(DATA_DIR))) {
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
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Download failed' });
  }
});

// Delete attachment
router.delete('/:path(*)', async (req, res) => {
  try {
    const relativePath = req.params.path;
    const filePath = path.join(DATA_DIR, relativePath);

    // Security check: ensure path is within DATA_DIR
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(DATA_DIR))) {
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
    console.error('Delete error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Delete failed' });
  }
});

export default router;
