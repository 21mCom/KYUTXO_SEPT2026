const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 10_000;
const MAX_SESSIONS = 8;
const SESSION_TTL_MS = 5 * 60_000;

function createAttachmentListing(options) {
  const {
    attachmentsDir,
    onFileVisited = () => {},
    now = () => Date.now(),
    randomUUID = () => crypto.randomUUID(),
    sessionTtlMs = SESSION_TTL_MS,
    maxSessions = MAX_SESSIONS,
  } = options;
  const sessions = new Map();

  async function closeCursor(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    await session.iterator.return(undefined);
  }

  async function reapExpired(currentTime = now()) {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= currentTime) await closeCursor(id);
    }
  }

  async function* iterateDirectory(relativeDirectory = '') {
    const entries = await fs.promises.opendir(path.join(attachmentsDir, relativeDirectory));
    for await (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        yield* iterateDirectory(relativePath);
      } else if (entry.isFile()) {
        onFileVisited();
        yield relativePath;
      }
    }
  }

  async function* iterateFiles() {
    yield* iterateDirectory();
  }

  async function summary() {
    let total = 0;
    let totalBytes = 0;
    const fingerprintBytes = Buffer.alloc(32);
    for await (const relativePath of iterateFiles()) {
      let fileHandle;
      try {
        const filePath = path.join(attachmentsDir, relativePath);
        fileHandle = await fs.promises.open(filePath, 'r');
        const before = await fileHandle.stat();
        const contentHash = crypto.createHash('sha256');
        const stream = fileHandle.createReadStream({ autoClose: false });
        for await (const chunk of stream) contentHash.update(chunk);
        const after = await fileHandle.stat();
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        ) {
          const error = new Error('Attachment changed during summary');
          error.code = 'ATTACHMENT_CHANGED';
          throw error;
        }
        const fileToken = crypto
          .createHash('sha256')
          .update(Buffer.from(relativePath, 'utf8'))
          .update(Buffer.from([0]))
          .update(contentHash.digest())
          .digest();
        for (let index = 0; index < fingerprintBytes.length; index++) {
          fingerprintBytes[index] ^= fileToken[index];
        }
        total += 1;
        totalBytes += before.size;
      } catch (error) {
        if (error && error.code === 'ATTACHMENT_CHANGED') throw error;
        // A file may vanish or become unreadable during the summary traversal.
      } finally {
        await fileHandle?.close().catch(() => undefined);
      }
    }
    return { total, totalBytes, fingerprint: fingerprintBytes.toString('hex') };
  }

  async function list(page = {}) {
    const limit = Number.isSafeInteger(page.limit) && page.limit > 0
      ? Math.min(page.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;
    const currentTime = now();
    await reapExpired(currentTime);

    if (page.summaryOnly) return { success: true, ...(await summary()) };
    if (typeof page.closeCursor === 'string') {
      await closeCursor(page.closeCursor);
      return { success: true };
    }

    let cursor = typeof page.cursor === 'string' ? page.cursor : null;
    let session = cursor ? sessions.get(cursor) : undefined;
    let initialSummary;
    if (!session) {
      if (cursor) return { success: false, code: 'EXPIRED', error: 'Attachment listing expired' };
      initialSummary = await summary();
      if (initialSummary.total === 0) {
        return { success: true, files: [], ...initialSummary, cursor: null };
      }
      if (sessions.size >= maxSessions) {
        return { success: false, code: 'TOO_MANY', error: 'Too many attachment listings' };
      }
      cursor = randomUUID();
      session = { iterator: iterateFiles(), expiresAt: currentTime + sessionTtlMs };
      sessions.set(cursor, session);
    }

    session.expiresAt = currentTime + sessionTtlMs;
    const files = [];
    let done = false;
    while (files.length < limit) {
      let next;
      try {
        next = await session.iterator.next();
      } catch (error) {
        await closeCursor(cursor).catch(() => undefined);
        throw error;
      }
      if (next.done) {
        done = true;
        break;
      }
      files.push(next.value);
    }
    if (done) {
      sessions.delete(cursor);
      cursor = null;
    }
    return { success: true, files, ...(initialSummary || {}), cursor };
  }

  function startReaper(intervalMs = 30_000) {
    const timer = setInterval(() => {
      void reapExpired();
    }, intervalMs);
    timer.unref();
    return timer;
  }

  return { list, summary, closeCursor, reapExpired, startReaper };
}

module.exports = {
  createAttachmentListing,
  ATTACHMENT_LIST_DEFAULT_LIMIT: DEFAULT_LIMIT,
  ATTACHMENT_LIST_MAX_LIMIT: MAX_LIMIT,
  ATTACHMENT_LIST_MAX_SESSIONS: MAX_SESSIONS,
  ATTACHMENT_LIST_SESSION_TTL_MS: SESSION_TTL_MS,
};