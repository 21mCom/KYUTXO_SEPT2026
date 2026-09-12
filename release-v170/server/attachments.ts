import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { pipeline } from 'stream/promises';
import attachmentListingModule from '../shared/attachment-listing.cjs';

// O_NOFOLLOW (Linux/macOS) makes the OPEN itself refuse a symlink at the final
// path component, closing the check-then-open race for that component; it is
// undefined on Windows, where the realpath containment checks still apply.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

// THREAT MODEL: these routes defend against PLANTED symlinks — links placed in
// the attachments tree by a crafted backup/restore or by earlier tampering —
// which are rejected (realpath containment) at operation time, with O_NOFOLLOW
// making the final open refuse a link swapped in after the check. A CONCURRENT
// local attacker racing the check-then-act interval on intermediate path
// components is OUT OF SCOPE: such an attacker already has write access to the
// data directory and can read/modify attachments directly, so no pathname
// check could stop them.

const router = Router();

// Hard cap on a single attachment's bytes. Uploads stream to a temp file on
// disk (diskStorage), so server memory stays flat regardless of file size or
// concurrency; `limits.fileSize` still makes multer abort the stream (and
// remove the partial temp file) as soon as the cap is exceeded. The same cap
// covers the restore write path (which shares the upload middleware).
// Override via env for tests.
export const MAX_ATTACHMENT_BYTES =
  Number(process.env.KYUTXO_MAX_ATTACHMENT_BYTES) > 0
    ? Number(process.env.KYUTXO_MAX_ATTACHMENT_BYTES)
    : 100 * 1024 * 1024; // 100 MiB

// Wraps multer so a rejected upload (oversized file, too many fields) becomes a
// clean JSON 413/400 instead of an Express default 500 HTML error page.
function singleFileUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Attachment exceeds the maximum size of ${MAX_ATTACHMENT_BYTES} bytes`
          : `Upload rejected: ${err.message}`;
      res.status(status).json({ error: message });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

// Data directory for local file storage
const DATA_DIR = process.env.KYUTXO_DATA_DIR || path.join(process.cwd(), 'data');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

// Staging area for streamed uploads. Lives inside the data root (same
// filesystem as ATTACHMENTS_DIR, so the final rename/link is atomic and never
// falls back to a copy) but OUTSIDE the attachments tree, so partial/orphaned
// temp files can never appear in list-all, backups, or the attachment audit.
const UPLOAD_TMP_DIR = path.join(DATA_DIR, 'attachments-tmp');

// Ensure attachments directory exists
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
}

// Disk-based streaming storage: multer pipes the request body straight to a
// temp file, so the whole attachment is never materialized as a Buffer in
// server memory (concurrent 100 MiB uploads/restores stay O(1) in RAM). The
// temp name is self-generated (crypto-random) — the client-supplied filename
// is never used on disk here. On a limit violation multer aborts the stream
// and removes the partial temp file itself.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(UPLOAD_TMP_DIR, { recursive: true })
        .then(() => cb(null, UPLOAD_TMP_DIR))
        .catch((err) => cb(err as Error, UPLOAD_TMP_DIR));
    },
    filename: (_req, _file, cb) => {
      cb(null, `upload_${Date.now()}_${randomBytes(8).toString('hex')}.tmp`);
    },
  }),
  limits: {
    fileSize: MAX_ATTACHMENT_BYTES,
    files: 1,
    fields: 20,
  },
});

// Best-effort removal of a streamed upload's temp file. Called on EVERY exit
// path of the upload/write handlers so rejected or failed requests cannot
// accumulate orphaned temp files in the staging dir.
async function discardTempFile(file: { path?: string } | undefined): Promise<void> {
  if (!file?.path) return;
  try {
    await fs.unlink(file.path);
  } catch {
    // Already gone (moved into place or cleaned up by multer) — fine.
  }
}

// A temp file this old cannot belong to an in-flight upload (requests are
// bounded well below this), so it must be an orphan left by a crash/power
// loss mid-stream. Kept generous so slow links never race the sweep.
export const STALE_UPLOAD_TMP_MS = 60 * 60 * 1000; // 1 hour

// Best-effort startup sweep of orphaned upload temp files. Every normal
// request path removes its own temp file (discardTempFile / multer abort),
// but a crash or power loss mid-upload strands the partial file forever.
// Only files STRICTLY older than the threshold are removed, so in-flight
// uploads are never touched. Errors are logged WITHOUT paths (see
// logServerError) and never propagate — a failed sweep must not affect
// startup. Returns the number of files removed (for tests/diagnostics).
export async function sweepStaleUploadTempFiles(
  options: { dir?: string; maxAgeMs?: number; now?: number } = {},
): Promise<number> {
  const dir = options.dir ?? UPLOAD_TMP_DIR;
  const maxAgeMs = options.maxAgeMs ?? STALE_UPLOAD_TMP_MS;
  const now = options.now ?? Date.now();
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // ENOENT: staging dir not created yet — nothing to sweep.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logServerError('Upload temp sweep error', error);
    }
    return 0;
  }
  for (const entry of entries) {
    // Only plain files: the staging dir should contain nothing else, and the
    // sweep must never recurse or follow/delete anything unexpected.
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile()) continue;
      // mtime is the staleness signal: every write to a file still being
      // streamed advances it, so an in-flight upload always looks fresh.
      // ctime/birthtime are deliberately excluded — ctime changes on
      // metadata-only touches and birthtime is unreliable across filesystems.
      const lastActivity = stat.mtimeMs;
      if (now - lastActivity <= maxAgeMs) continue; // in-flight or fresh — leave it
      await fs.unlink(filePath);
      removed++;
    } catch (error) {
      // File vanished (its request finished) or unlink failed — best effort.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logServerError('Upload temp sweep error', error);
      }
    }
  }
  return removed;
}

// The desktop app can keep one server process alive for days or weeks, so the
// startup sweep alone would let a client-crash orphan linger until the next
// launch. Re-sweep on a coarse interval; the 1-hour strictly-older-than mtime
// rule (reused unchanged) keeps in-flight uploads untouchable.
export const UPLOAD_TMP_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Schedule the periodic re-sweep. The timer is unref'd so it never keeps the
// process alive at shutdown, and each tick is fire-and-forget (the sweep
// catches/logs its own errors and never throws). Returns the timer so tests
// (or a caller) can clear it. `sweep` is injectable for interval-wiring tests.
export function scheduleUploadTempSweep(
  options: {
    intervalMs?: number;
    sweep?: () => Promise<number>;
  } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? UPLOAD_TMP_SWEEP_INTERVAL_MS;
  const sweep = options.sweep ?? sweepStaleUploadTempFiles;
  const timer = setInterval(() => {
    // sweepStaleUploadTempFiles never rejects, but an injected sweep might —
    // swallow so a single failed tick can never surface as an unhandled
    // rejection or stop future ticks.
    void sweep().catch(() => {});
  }, intervalMs);
  timer.unref();
  return timer;
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

// Filesystem-level containment: resolveAttachmentPath is LEXICAL only, so a
// symlink planted inside the attachments tree (e.g. `attachments/evil ->
// /etc`) would redirect reads/writes/deletes outside the data root even though
// the lexical checks pass. This helper rejects symlinks and verifies the REAL
// location stays inside the real attachments root:
//   - A symlink AT the target is ALWAYS rejected (lstat), even one pointing
//     back inside the root — otherwise read/delete/rename would act on the
//     link's TARGET under a different attachment's path (cross-attachment
//     disclosure/loss), and a write would truncate that target.
//   - If the target exists, its realpath must be inside the root (a symlinked
//     directory component pointing outside fails here).
//   - If it does not exist (a write target), the nearest existing ancestor's
//     realpath must be inside the root.
// Returns the canonical absolute path when contained, null when the path is a
// link or escapes. `baseReal` is realpath(baseDir); pass it in when checking
// several paths against the same root in one operation.
export async function containedRealPath(
  baseDir: string,
  absPath: string,
  baseReal?: string,
): Promise<string | null> {
  const base = baseReal ?? (await fs.realpath(baseDir));
  // Reject a symlink AT the target before any realpath resolution. lstat sees
  // the link itself (including dangling links), so this single check covers
  // both existing and dangling symlinks.
  try {
    if ((await fs.lstat(absPath)).isSymbolicLink()) return null;
  } catch {
    // ENOENT: genuinely absent — the normal write-target case.
  }
  // Existing target: realpath resolves any intermediate symlink components.
  try {
    const real = await fs.realpath(absPath);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Non-existent target: walk up to the nearest existing ancestor and verify
  // ITS real location (a symlinked directory component pointing outside fails
  // here). `tail` accumulates path components root-first (unshift prepends
  // each parent), so it is joined as-is — reversing it would write to the
  // WRONG location (basename/dir instead of dir/basename).
  let dir = path.dirname(absPath);
  const tail: string[] = [path.basename(absPath)];
  for (;;) {
    try {
      const realDir = await fs.realpath(dir);
      if (realDir !== base && !realDir.startsWith(base + path.sep)) return null;
      return path.join(realDir, ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root — not contained
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

// Combined guard for paths that must already exist and be real (read/delete/
// rename-source): lexical resolve + realpath containment. Returns null when
// unsafe OR when the path does not exist.
export async function resolveExistingAttachmentPath(
  relativePath: unknown,
): Promise<string | null> {
  const lexical = resolveAttachmentPath(relativePath);
  if (!lexical) return null;
  await ensureDir(ATTACHMENTS_DIR);
  return containedRealPath(ATTACHMENTS_DIR, lexical);
}

// Combined guard for write targets (upload/restore-write/rename-destination):
// lexical resolve + containment of the nearest existing ancestor + dangling-
// symlink rejection. The parent directory is NOT created here; callers must
// re-check containment AFTER creating directories and immediately before
// writing so a validate-then-act gap cannot be exploited (see rename).
export async function resolveWriteAttachmentPath(
  relativePath: unknown,
): Promise<string | null> {
  const lexical = resolveAttachmentPath(relativePath);
  if (!lexical) return null;
  await ensureDir(ATTACHMENTS_DIR);
  return containedRealPath(ATTACHMENTS_DIR, lexical);
}

// Cryptographically random filename suffix (8 hex chars = 32 bits of entropy,
// vs. the previous 3-char Math.random() suffix) to make collisions/overwrites
// practically impossible. Callers still retry on EEXIST via the 'wx' flag.
function randomSuffix(): string {
  return randomBytes(4).toString('hex');
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
router.post('/upload', singleFileUpload, async (req: Request, res) => {
  const file = (req as any).file as
    | { path: string; originalname: string; mimetype: string; size: number }
    | undefined;
  try {
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

    // Containment: a symlink planted at (or above) the identifier directory
    // would redirect the write outside the attachments root even though every
    // name here is self-generated. Verify the REAL directory location first.
    const realDir = await containedRealPath(ATTACHMENTS_DIR, attachmentDir);
    if (!realDir) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Unique filename: crypto-random suffix + hard-link with collision retry.
    // link(2) fails with EEXIST when the destination exists (O_EXCL
    // semantics) and never follows a symlink at the destination's final
    // component, so an existing file can never be overwritten or raced into.
    // The bytes were already streamed to the temp file, so no copy happens
    // here — link + unlink is an atomic move on the same filesystem.
    const safeFilename = file.originalname.replace(/[<>:"/\\|?*]/g, '_');
    const ext = path.extname(safeFilename);
    const baseName = path.basename(safeFilename, ext);
    let filename = '';
    let wrote = false;
    for (let attempt = 0; attempt < 10 && !wrote; attempt++) {
      filename = `${baseName}_${randomSuffix()}${ext}`;
      try {
        await fs.link(file.path, path.join(realDir, filename));
        wrote = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!wrote) {
      return res.status(500).json({ error: 'Could not allocate a unique filename' });
    }

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
  } finally {
    // Remove the staging temp file on every exit path (after a successful
    // link this deletes the temp name, completing the atomic move).
    await discardTempFile(file);
  }
});

let attachmentTraversalVisits = 0;
export function resetAttachmentTraversalVisitsForTest(): void {
  attachmentTraversalVisits = 0;
}
export function getAttachmentTraversalVisitsForTest(): number {
  return attachmentTraversalVisits;
}

const { createAttachmentListing } = attachmentListingModule;
const attachmentListing = createAttachmentListing({
  attachmentsDir: ATTACHMENTS_DIR,
  onFileVisited: () => { attachmentTraversalVisits += 1; },
});
attachmentListing.startReaper();

// List ALL attachments recursively (for backup) - MUST be before wildcard routes
router.get('/list-all', async (req, res) => {
  try {
    await ensureDir(ATTACHMENTS_DIR);
    const result = await attachmentListing.list({
      limit: Number(req.query.limit),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      closeCursor: typeof req.query.closeCursor === 'string' ? req.query.closeCursor : undefined,
      summaryOnly: req.query.summaryOnly === '1',
    });
    if (!result.success) {
      const status = result.code === 'EXPIRED' ? 410 : 429;
      return res.status(status).json({ error: result.error });
    }
    res.json(result);
  } catch (error) {
    logServerError('List all attachments error', error);
    res.status(500).json({ error: 'List failed' });
  }
});

// Write attachment from backup (for restore) - MUST be before wildcard routes
router.post('/write', singleFileUpload, async (req: Request, res) => {
  const file = (req as any).file as { path: string } | undefined;
  try {
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { relativePath } = req.body;
    
    if (!relativePath) {
      return res.status(400).json({ error: 'Relative path is required' });
    }

    // Security check: ensure path stays within ATTACHMENTS_DIR — lexically AND
    // through any planted symlinks (containment of the nearest existing
    // ancestor + dangling-symlink rejection at the target).
    const filePath = resolveAttachmentPath(relativePath);
    if (!filePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create directory if needed, then RE-CHECK containment of the FULL target
    // path: mkdir -p follows symlinked components, so the re-check is what
    // proves the directory being written into is really inside the root, and
    // it also catches a dangling symlink at the target itself.
    const dir = path.dirname(filePath);
    await ensureDir(dir);
    const realFile = await containedRealPath(ATTACHMENTS_DIR, filePath);
    if (!realFile) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Write file (restore legitimately overwrites colliding paths). O_NOFOLLOW
    // makes the open itself refuse a symlink swapped in at the final component
    // after the containment check (no-op on Windows). The bytes stream from
    // the staging temp file to the destination — never through a Buffer.
    const fh = await fs.open(
      realFile,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW,
    );
    // Both streams own their FileHandles (autoClose): pipeline destroys both
    // ends on success or failure, so neither fd can leak.
    const src = (await fs.open(file.path, fsConstants.O_RDONLY)).createReadStream({
      autoClose: true,
    });
    await pipeline(src, fh.createWriteStream({ autoClose: true }));

    res.json({ success: true });
  } catch (error) {
    logServerError('Write attachment error', error);
    res.status(500).json({ error: 'Write failed' });
  } finally {
    await discardTempFile(file);
  }
});

// Rename/move an attachment file (for path migration)
router.post('/rename', async (req: Request, res) => {
  try {
    const { oldPath, newPath } = req.body;
    
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'Both oldPath and newPath are required' });
    }

    // Lexical check first (keeps the historical 404 vs 403 split).
    const oldLexical = resolveAttachmentPath(oldPath);
    const newFilePath = await resolveWriteAttachmentPath(newPath);
    if (!oldLexical || !newFilePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    try {
      await fs.lstat(oldLexical);
    } catch {
      return res.status(404).json({ error: 'Source file not found' });
    }

    // Symlink-aware containment for BOTH endpoints. The source must really
    // live inside the root; the destination's nearest existing ancestor must
    // be inside the root and the destination must not be a (dangling) symlink.
    const oldFilePath = await containedRealPath(
      ATTACHMENTS_DIR,
      oldLexical,
      await fs.realpath(ATTACHMENTS_DIR),
    );
    if (!oldFilePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const newDir = path.dirname(newFilePath);
    await ensureDir(newDir);

    // TOCTOU: re-verify containment of BOTH paths immediately before the
    // rename, so a directory swapped for a symlink AFTER the checks above is
    // caught at operation time instead of slipping through the
    // validate-then-act window.
    const baseReal = await fs.realpath(ATTACHMENTS_DIR);
    const [oldReal, newDirReal] = await Promise.all([
      containedRealPath(ATTACHMENTS_DIR, oldFilePath, baseReal),
      containedRealPath(ATTACHMENTS_DIR, newDir, baseReal),
    ]);
    if (!oldReal || !newDirReal) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const destination = path.join(newDirReal, path.basename(newFilePath));
    try {
      // link(2) is the portable no-replace primitive available through Node:
      // it atomically fails with EEXIST when the destination is already present
      // (including a symlink), so migration can never overwrite attachment
      // bytes. Only after the new directory entry exists do we remove the old
      // one. If unlink fails, both names still reference the same intact bytes.
      try {
        await fs.link(oldReal, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) {
          throw error;
        }
        // FAT/exFAT and mount boundaries may not support hard links. Fall back
        // to an exclusive copy: COPYFILE_EXCL preserves no-overwrite semantics,
        // and the source remains untouched until the full copy succeeds.
        await fs.copyFile(oldReal, destination, fsConstants.COPYFILE_EXCL);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return res.status(409).json({ error: 'Destination file already exists' });
      }
      throw error;
    }
    await fs.unlink(oldReal);

    // Try to remove old directory if empty
    const oldDir = path.dirname(oldReal);
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
    // carries an `attachments/` prefix (Electron stores without it).
    const filePath = resolveAttachmentPath(relativePath);
    if (!filePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Missing reads are NOT successful empty files. Keep the not-found response
    // distinct from DELETE's idempotent already-missing success so callers
    // cannot archive JSON error bytes as if they were attachment content.
    try {
      await fs.lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      throw error;
    }
    const realPath = await containedRealPath(ATTACHMENTS_DIR, filePath);
    if (!realPath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // O_NOFOLLOW: the open itself refuses a symlink swapped in at the final
    // component after the containment check (no-op on Windows).
    const fh = await fs.open(realPath, fsConstants.O_RDONLY | NOFOLLOW);
    const filename = path.basename(realPath);
    try {
      const { size } = await fh.stat();
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', toContentDisposition(filename));
      res.set('Content-Length', String(size));
    } catch (error) {
      await fh.close();
      throw error;
    }

    // Stream from disk instead of buffering the whole file in memory: a
    // 100 MiB attachment (or several concurrent downloads) must not
    // materialize as Buffers on the server. pipeline (unlike .pipe) destroys
    // the read stream — and via autoClose the FileHandle — when the response
    // closes early (client abort/disconnect), so aborted downloads cannot
    // leak file descriptors.
    const stream = fh.createReadStream({ autoClose: true });
    try {
      await pipeline(stream, res);
    } catch (error) {
      // Client aborts surface as ERR_STREAM_PREMATURE_CLOSE — routine, and
      // pipeline has already destroyed both ends; disk read errors mid-stream
      // are logged, and destroying the response makes the client see a
      // truncated transfer instead of a silent short file.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logServerError('Download stream error', error);
      }
      if (!res.writableEnded) res.destroy();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !res.headersSent) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    logServerError('Download error', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    } else if (!res.writableEnded) {
      res.destroy();
    }
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

    // Symlink containment: unlinking THROUGH a symlinked directory component
    // would delete a file outside the attachments root. (Deleting a symlink
    // AT the target only removes the link itself, but we still refuse it —
    // attachment paths must be real files.) Missing files stay an idempotent
    // success, so check existence lexically first.
    try {
      await fs.lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.json({ success: true, alreadyDeleted: true });
      }
      throw error;
    }
    const realPath = await containedRealPath(ATTACHMENTS_DIR, filePath);
    if (!realPath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await fs.unlink(realPath);

    res.json({ success: true });
  } catch (error) {
    logServerError('Delete error', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

export default router;
