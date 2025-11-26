import { Router, type Request } from 'express';
import multer from 'multer';
import { Client } from '@replit/object-storage';

const router = Router();
const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
if (!bucketId) {
  throw new Error('DEFAULT_OBJECT_STORAGE_BUCKET_ID environment variable is not set');
}
const storage = new Client({ bucketId });
const upload = multer({ storage: multer.memoryStorage() });

// Upload attachment
router.post('/upload/:recordId', upload.single('file'), async (req: Request, res) => {
  try {
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { recordId } = req.params;
    const objectPath = `attachments/${recordId}/${Date.now()}-${file.originalname}`;

    const result = await storage.uploadFromBytes(objectPath, file.buffer);

    if (!result.ok) {
      return res.status(500).json({ error: result.error?.message || 'Upload failed' });
    }

    res.json({
      objectStoragePath: objectPath,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Upload failed' });
  }
});

// Download attachment
router.get('/download/:path(*)', async (req, res) => {
  try {
    const objectPath = req.params.path;

    const result = await storage.downloadAsBytes(objectPath);

    if (!result.ok) {
      return res.status(404).json({ error: 'File not found' });
    }

    const buffer = result.value;
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${objectPath.split('/').pop()}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Download failed' });
  }
});

// Delete attachment
router.delete('/:path(*)', async (req, res) => {
  try {
    const objectPath = req.params.path;

    const result = await storage.delete(objectPath);

    // Treat "not found" as success for idempotent deletes
    if (!result.ok && result.error?.message?.includes('not found')) {
      return res.json({ success: true, alreadyDeleted: true });
    }

    if (!result.ok) {
      return res.status(500).json({ error: result.error?.message || 'Delete failed' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    // Treat not found errors as success
    if (error instanceof Error && error.message.includes('not found')) {
      return res.json({ success: true, alreadyDeleted: true });
    }
    res.status(500).json({ error: error instanceof Error ? error.message : 'Delete failed' });
  }
});

export default router;
