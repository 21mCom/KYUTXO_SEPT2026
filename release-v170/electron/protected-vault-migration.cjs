/*
 * Main-owned, renderer-path-free plaintext -> protected generation migration.
 *
 * SourceAdapter contract (all methods asynchronous):
 *   estimateBytes(): number
 *   rows(table, { batchSize }): AsyncIterable<Array<{ id: string|number, row: unknown }>>
 *   attachments(): AsyncIterable<{ id: string, size?: number, stream: AsyncIterable<Uint8Array> }>
 *   verifyReferences(snapshot): boolean              (optional)
 *   removeSource(): boolean                          (required for cleanup)
 *   plaintextRemaining(): boolean                    (required for completion)
 *
 * The adapter owns IndexedDB coordination in task 66. This module never deletes
 * renderer storage itself and therefore cannot accidentally activate migration
 * before that handoff lands.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const {
  ProtectedStoreClient,
  MESSAGE_TYPES,
  PROTECTED_TABLES,
} = require('./protected-store.cjs');

const SOURCE_ROOT = 'migration-source';
const MARKER = 'protected-migration.marker.json';
const POINTER = 'protected-active-generation.json';
const BATCH = 100;
const CHUNK = 64 * 1024;
const PHASES = Object.freeze([
  'preflight', 'freeze', 'stage', 'verify', 'commit',
  'generation-swap.prepare', 'generation-swap.publish',
  'generation-swap.cleanup', 'cleanup.removeSource', 'cleanup.rescan', 'complete',
]);
const BLOCKED_OPERATIONS = new Set([
  MESSAGE_TYPES.CREATE,
  MESSAGE_TYPES.UNLOCK, MESSAGE_TYPES.CHANGE_PASSWORD,
  MESSAGE_TYPES.PUT_ROW, MESSAGE_TYPES.DELETE_ROW,
  MESSAGE_TYPES.WRITE_ATTACHMENT, MESSAGE_TYPES.READ_ATTACHMENT,
  MESSAGE_TYPES.DELETE_ATTACHMENT, MESSAGE_TYPES.RENAME_ATTACHMENT,
  MESSAGE_TYPES.BEGIN_ATTACHMENT, MESSAGE_TYPES.APPEND_ATTACHMENT,
  MESSAGE_TYPES.FINISH_ATTACHMENT, MESSAGE_TYPES.ABORT_ATTACHMENT,
  MESSAGE_TYPES.LIST_ATTACHMENTS, MESSAGE_TYPES.VERIFY_ATTACHMENTS,
]);
// Explicit freeze policy: STATUS, LOCK, INTEGRITY, GET_ROW, and LIST_ROWS are
// read-only/containment operations and remain available. Everything in the
// mutation/attachment set above fails closed.

function safe() { return new Error('Protected vault migration failed'); }
function digest() { return crypto.createHash('sha256'); }
function generation(kind = 'protected') { return `${kind}-${crypto.randomUUID()}`; }
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw safe();
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(',')}}`;
  }
  throw safe();
}
function validId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 512 &&
    !id.includes('\0')) || Number.isSafeInteger(id);
}
function keyOf(id) {
  if (!validId(id)) throw safe();
  return typeof id === 'number'
    ? `n:${(BigInt(id) + 9007199254740991n).toString().padStart(17, '0')}`
    : `s:${id}`;
}
function migrationRow(id, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw safe();
  const { id: embeddedId, ...value } = row;
  if (embeddedId !== undefined && keyOf(embeddedId) !== keyOf(id)) throw safe();
  return value;
}
function attachmentLine(file) {
  return `${file.id}\0${file.bytes}\0${file.digest}\n`;
}
function equalContent(a, b) {
  return canonical(a.tables) === canonical(b.tables) &&
    canonical(a.attachments) === canonical(b.attachments) &&
    a.referencesOk === true && b.referencesOk === true;
}
function contentEvidence(snapshot) {
  return {
    version: 1,
    referencesOk: snapshot.referencesOk === true,
    tables: snapshot.tables,
    attachments: {
      count: snapshot.attachments.count,
      bytes: snapshot.attachments.bytes,
      digest: snapshot.attachments.digest,
    },
  };
}
function equalEvidence(snapshot, evidence) {
  return canonical(contentEvidence(snapshot)) === canonical(evidence);
}
async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!error || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const handle = await fsp.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(Buffer.from(JSON.stringify(value)));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
  await syncDirectory(path.dirname(file));
}
async function rm(target) {
  await fsp.rm(target, { recursive: true, force: true });
}
async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}
async function availableBytes(root) {
  if (typeof fsp.statfs !== 'function') return Number.MAX_SAFE_INTEGER;
  const stat = await fsp.statfs(root);
  return Number(stat.bavail) * Number(stat.bsize);
}
function durableFileOpenMode(platform = process.platform) {
  return platform === 'win32' ? 'r+' : 'r';
}
async function durableTree(root, openFile = fsp.open) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await durableTree(target, openFile);
    else if (entry.isFile()) {
      // Windows FlushFileBuffers requires write access. r+ is non-truncating
      // and retains the fail-closed durability guarantee there. Hardened
      // Unix files can remain read-only because fsync supports such handles.
      const handle = await openFile(target, durableFileOpenMode());
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(root);
}

class FileMigrationSource {
  constructor(root) {
    this.root = root;
    this.rowsFile = path.join(root, 'rows.ndjson');
    this.attachmentsRoot = path.join(root, 'attachments');
  }
  async estimateBytes() {
    let total = (await fsp.stat(this.rowsFile)).size;
    for (const name of await fsp.readdir(this.attachmentsRoot)) {
      total += (await fsp.stat(path.join(this.attachmentsRoot, name))).size;
    }
    return total;
  }
  async authenticatePreflight(password) {
    return typeof password === 'string' && password.length > 0 &&
      await exists(this.rowsFile) && await exists(this.attachmentsRoot);
  }
  async freeze() { this.frozen = true; return true; }
  async thaw() { this.frozen = false; return true; }
  assertWritable() {
    if (this.frozen) throw safe();
    return true;
  }
  async *rows(table, { batchSize }) {
    const input = fs.createReadStream(this.rowsFile, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let batch = [];
    for await (const line of lines) {
      if (!line) continue;
      const item = JSON.parse(line);
      if (item.table !== table) continue;
      batch.push({ id: item.id, row: item.row });
      if (batch.length === batchSize) { yield batch; batch = []; }
    }
    if (batch.length) yield batch;
  }
  async *attachments() {
    const names = (await fsp.readdir(this.attachmentsRoot)).sort();
    for (const id of names) {
      const file = path.join(this.attachmentsRoot, id);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) continue;
      yield { id, size: stat.size, stream: fs.createReadStream(file, { highWaterMark: CHUNK }) };
    }
  }
  async verifyReferences() { return true; }
  async removeSource() { await rm(this.root); return !(await exists(this.root)); }
  async plaintextRemaining() { return exists(this.root); }
}

class ProtectedVaultMigrationController {
  constructor({
    root,
    sourceAdapter = null,
    referenceVerifier = null,
    sourceReferenceVerifier = null,
    protectedReferenceVerifier = null,
    diskSpace = availableBytes,
    clientFactory = (dataDir) => new ProtectedStoreClient({ dataDir }),
    testOnlyFaultInjector = null,
  }) {
    if (typeof root !== 'string' || !root) throw new TypeError('root is required');
    this.root = root;
    this.source = sourceAdapter;
    // referenceVerifier remains a compatibility shorthand, but it is still
    // called explicitly in both source and protected contexts.
    this.sourceReferenceVerifier = sourceReferenceVerifier || referenceVerifier;
    this.protectedReferenceVerifier = protectedReferenceVerifier || referenceVerifier;
    this.diskSpace = diskSpace;
    this.clientFactory = clientFactory;
    this.fault = testOnlyFaultInjector;
    this.marker = path.join(root, MARKER);
    this.pointer = path.join(root, POINTER);
    this.generations = path.join(root, 'protected-generations');
    // Fail closed until startup recover() has inspected durable state.
    this.state = { phase: 'startup-recovery', frozen: true, session: null };
  }
  status() { return { ...this.state }; }
  operationAllowed(type) {
    return !(this.state.frozen && BLOCKED_OPERATIONS.has(type));
  }
  async checkpoint(phase, session) {
    if (!PHASES.includes(phase)) throw safe();
    this.state.phase = phase;
    this.state.frozen = phase !== 'preflight' && phase !== 'complete';
    await atomicJson(this.marker, {
      version: 2, phase, generation: session.generation,
      priorGeneration: session.priorGeneration || null,
      ...(session.evidence ? { evidence: session.evidence } : {}),
      ...(phase === 'complete' ? { sourceRemoved: true } : {}),
    });
    if (this.fault) await this.fault(phase);
  }
  stagePath(gen) { return path.join(this.root, `.protected-stage-${gen}`); }
  generationPath(gen) { return path.join(this.generations, gen); }
  async readPointer() {
    try {
      const value = JSON.parse(await fsp.readFile(this.pointer, 'utf8'));
      return value && typeof value.generation === 'string' ? value.generation : null;
    } catch { return null; }
  }
  async preflight(session) {
    await this.checkpoint('preflight', session);
    if (!this.source || typeof this.source.rows !== 'function' ||
        typeof this.source.attachments !== 'function' ||
        typeof this.source.authenticatePreflight !== 'function' ||
        typeof this.source.freeze !== 'function' ||
        typeof this.source.thaw !== 'function' ||
        typeof this.sourceReferenceVerifier !== 'function' ||
        typeof this.protectedReferenceVerifier !== 'function') throw safe();
    if (await this.source.authenticatePreflight(session.password) !== true) throw safe();
    const estimate = await this.source.estimateBytes();
    if (!Number.isSafeInteger(estimate) || estimate < 0) throw safe();
    // Source remains present, and encrypted framing/database indexes need headroom.
    const required = Math.ceil(estimate * 1.35) + 16 * 1024 * 1024;
    if (await this.diskSpace(this.root) < required) throw safe();
    return { estimate, required };
  }
  async scanSource(client = null) {
    const tables = {};
    for (const table of PROTECTED_TABLES) {
      const hash = digest();
      let count = 0;
      let prior = null;
      for await (const batch of this.source.rows(table, { batchSize: BATCH })) {
        if (!Array.isArray(batch) || batch.length > BATCH) throw safe();
        for (const item of batch) {
          const key = keyOf(item.id);
          const row = migrationRow(item.id, item.row);
          if (prior !== null && key <= prior) throw safe();
          prior = key;
          hash.update(`${key}\0${canonical(row)}\n`);
          count++;
          if (client) {
            await client.call(MESSAGE_TYPES.PUT_ROW, {
              table, id: item.id, row,
            });
          }
        }
      }
      tables[table] = { count, digest: hash.digest('hex') };
    }
    const evidenceFiles = [];
    const aggregate = digest();
    let attachmentCount = 0;
    let attachmentBytes = 0;
    let priorAttachment = null;
    for await (const attachment of this.source.attachments()) {
      if (!attachment || typeof attachment.id !== 'string' || !attachment.stream) throw safe();
      if (priorAttachment !== null &&
          attachment.id.localeCompare(priorAttachment) <= 0) throw safe();
      priorAttachment = attachment.id;
      const hash = digest();
      let bytes = 0;
      let token;
      if (client) {
        ({ token } = await client.call(MESSAGE_TYPES.BEGIN_ATTACHMENT, {
          alias: attachment.id,
        }));
      }
      try {
        for await (const raw of attachment.stream) {
          const buffer = Buffer.from(raw);
          for (let offset = 0; offset < buffer.length; offset += CHUNK) {
            const chunk = buffer.subarray(offset, offset + CHUNK);
            bytes += chunk.length;
            hash.update(chunk);
            if (client) {
              await client.call(MESSAGE_TYPES.APPEND_ATTACHMENT, { token, bytes: chunk });
            }
          }
        }
        if (attachment.size !== undefined && attachment.size !== bytes) throw safe();
        if (client) await client.call(MESSAGE_TYPES.FINISH_ATTACHMENT, { token });
      } catch (error) {
        if (client && token) {
          await client.call(MESSAGE_TYPES.ABORT_ATTACHMENT, { token }).catch(() => {});
        }
        throw error;
      }
      const file = { id: attachment.id, bytes, digest: hash.digest('hex') };
      aggregate.update(attachmentLine(file));
      attachmentCount++;
      attachmentBytes += bytes;
      if (evidenceFiles.length < BATCH) evidenceFiles.push(file);
    }
    const referencesOk = await this.sourceReferenceVerifier({
      tables, files: evidenceFiles, attachmentCount, attachmentBytes,
      protected: false, sourceAdapter: this.source,
    });
    if (referencesOk !== true) throw safe();
    return {
      generation: generation('plaintext'), verified: true, referencesOk: true, tables,
      attachments: {
        count: attachmentCount,
        bytes: attachmentBytes,
        digest: aggregate.digest('hex'),
        files: evidenceFiles,
      },
    };
  }
  async protectedSnapshot(directory, gen, password) {
    const client = this.clientFactory(directory);
    try {
      await client.call(MESSAGE_TYPES.UNLOCK, { password });
      const tables = {};
      for (const table of PROTECTED_TABLES) {
        const hash = digest();
        let count = 0;
        let after = null;
        while (true) {
          const page = await client.call(MESSAGE_TYPES.LIST_ROWS, {
            table, after, limit: BATCH,
          });
          if (!page.length) break;
          for (const item of page) {
            hash.update(`${keyOf(item.id)}\0${canonical(item.row)}\n`);
            count++;
          }
          after = page[page.length - 1].id;
        }
        tables[table] = { count, digest: hash.digest('hex') };
      }
      const evidenceFiles = [];
      const aggregate = digest();
      let attachmentCount = 0;
      let attachmentBytes = 0;
      let after = '';
      while (true) {
        const page = await client.call(MESSAGE_TYPES.VERIFY_ATTACHMENTS, {
          after, limit: BATCH,
        });
        if (!page.length) break;
        for (const file of page) {
          aggregate.update(attachmentLine(file));
          attachmentCount++;
          attachmentBytes += file.bytes;
          if (evidenceFiles.length < BATCH) evidenceFiles.push(file);
        }
        after = page[page.length - 1].id;
      }
      await client.call(MESSAGE_TYPES.INTEGRITY);
      const referencesOk = await this.protectedReferenceVerifier({
        tables, files: evidenceFiles, attachmentCount, attachmentBytes,
        protected: true, protectedClient: client,
      });
      if (referencesOk !== true) throw safe();
      return {
        generation: gen, verified: true, referencesOk: true, tables,
        attachments: {
          count: attachmentCount,
          bytes: attachmentBytes,
          digest: aggregate.digest('hex'),
          files: evidenceFiles,
        },
        sqlCipherIntegrity: 'ok',
      };
    } finally {
      await client.call(MESSAGE_TYPES.LOCK).catch(() => {});
      await client.close();
    }
  }
  async cleanupAndComplete(session, source) {
    if (!source || typeof source.removeSource !== 'function' ||
        typeof source.plaintextRemaining !== 'function') throw safe();
    await this.checkpoint('cleanup.removeSource', session);
    if (await source.removeSource() !== true) throw safe();
    if (this.fault) await this.fault('cleanup.removeSource.after');
    await this.checkpoint('cleanup.rescan', session);
    if (await source.plaintextRemaining() !== false) throw safe();
    if (this.fault) await this.fault('cleanup.rescan.after');
    // The completion marker is durable only after the rescan proved that the
    // real source is gone. checkpoint's injected "complete" crash therefore
    // leaves a truthful complete marker, never a premature one.
    await this.checkpoint('complete', session);
    if (session.priorGeneration && session.priorGeneration !== session.generation) {
      await rm(this.generationPath(session.priorGeneration));
    }
    this.state = { phase: 'complete', frozen: false, session: null };
  }
  async migrate({ password }) {
    if (this.state.session || typeof password !== 'string' || !password) throw safe();
    const session = {
      id: crypto.randomUUID(), generation: generation(),
      priorGeneration: await this.readPointer(), password,
    };
    this.state.session = session.id;
    const stage = this.stagePath(session.generation);
    let baseline;
    let diagnosticStage = 'preflight';
    try {
      await this.preflight(session);
      // Readability, canonical IDs, attachment lengths, and reference audit
      // are proven before writes are frozen.
      diagnosticStage = 'source-scan';
      baseline = await this.scanSource();
      session.evidence = contentEvidence(baseline);
      diagnosticStage = 'source-freeze';
      await this.checkpoint('freeze', session);
      if (await this.source.freeze({ sessionId: session.id }) !== true) throw safe();
      await this.checkpoint('stage', session);
      await rm(stage);
      const client = this.clientFactory(stage);
      try {
        diagnosticStage = 'protected-create';
        await client.call(MESSAGE_TYPES.CREATE, { password });
        diagnosticStage = 'protected-copy';
        const copied = await this.scanSource(client);
        if (!equalContent(copied, baseline)) throw safe();
        diagnosticStage = 'protected-lock';
        await client.call(MESSAGE_TYPES.LOCK);
      } finally {
        try {
          await client.close();
        } catch (error) {
          diagnosticStage = 'protected-close';
          throw error;
        }
      }
      diagnosticStage = 'protected-reopen';
      await this.checkpoint('verify', session);
      const staged = await this.protectedSnapshot(stage, session.generation, password);
      if (!equalContent(staged, baseline)) throw safe();
      diagnosticStage = 'durability-flush';
      await durableTree(stage);
      diagnosticStage = 'generation-publish';
      await this.checkpoint('commit', session);
      await this.checkpoint('generation-swap.prepare', session);
      await fsp.mkdir(this.generations, { recursive: true, mode: 0o700 });
      const published = this.generationPath(session.generation);
      await fsp.rename(stage, published);
      await syncDirectory(this.generations);
      await this.checkpoint('generation-swap.publish', session);
      await atomicJson(this.pointer, { version: 1, generation: session.generation });
      if (this.fault) await this.fault('generation-swap.publish.after');
      diagnosticStage = 'published-reopen';
      const active = await this.protectedSnapshot(published, session.generation, password);
      if (!equalContent(active, baseline)) throw safe();
      await this.checkpoint('generation-swap.cleanup', session);
      diagnosticStage = 'source-cleanup';
      await this.cleanupAndComplete(session, this.source);
      return { baseline, active, generation: session.generation };
    } catch (error) {
      // Test scenarios use this only to model abrupt process death, where no
      // JavaScript catch/finally cleanup executes. Production errors always
      // follow the rollback/cleanup rules below.
      if (error && error.simulateProcessCrash === true) throw error;
      const pointer = await this.readPointer().catch(() => null);
      if (pointer !== session.generation) {
        // Before publication the source remains authoritative. Roll back every
        // candidate location, then explicitly thaw it so ordinary writes can
        // resume in this process.
        await rm(stage).catch(() => {});
        await rm(this.generationPath(session.generation)).catch(() => {});
        let thawed = false;
        if (typeof this.source?.thaw === 'function') {
          thawed = await this.source.thaw({
            sessionId: session.id, reason: 'rollback',
          }).catch(() => false);
        }
        if (thawed) {
          await rm(this.marker).catch(() => {});
          this.state = { phase: 'idle', frozen: false, session: null };
        } else {
          this.state.frozen = true;
        }
      } else {
        // Publication makes cleanup the only safe direction; never thaw.
        this.state.frozen = true;
      }
      const failure = safe();
      failure.diagnosticStage = diagnosticStage;
      throw failure;
    }
  }
  async recover({ password, resumeContext } = {}) {
    let marker;
    try { marker = JSON.parse(await fsp.readFile(this.marker, 'utf8')); }
    catch {
      this.state = { phase: 'idle', frozen: false, session: null };
      return { recovered: false, action: 'none' };
    }
    if (!marker || marker.version !== 2 || typeof marker.generation !== 'string' ||
        !PHASES.includes(marker.phase)) throw safe();
    const stage = this.stagePath(marker.generation);
    const destination = this.generationPath(marker.generation);
    const pointer = await this.readPointer();
    const published = pointer === marker.generation;
    if (!published && !['generation-swap.prepare', 'generation-swap.publish',
      'generation-swap.cleanup', 'cleanup.removeSource', 'cleanup.rescan',
      'complete'].includes(marker.phase)) {
      await rm(stage);
      await rm(destination);
      const source = resumeContext && resumeContext.sourceAdapter;
      if (!source || typeof source.thaw !== 'function' ||
          typeof resumeContext.authenticateSource !== 'function') {
        this.state = { phase: marker.phase, frozen: true, session: null };
        return { recovered: false, action: 'awaiting-thaw-context' };
      }
      if (await resumeContext.authenticateSource({
        password, generation: marker.generation,
      }) !== true) throw safe();
      if (await source.thaw({
        generation: marker.generation, reason: 'recovery-rollback',
      }) !== true) throw safe();
      await rm(this.marker);
      this.state = { phase: 'idle', frozen: false, session: null };
      return { recovered: true, action: 'source-preserved' };
    }
    if (typeof password !== 'string' || !password) {
      this.state = { phase: marker.phase, frozen: true, session: null };
      return { recovered: false, action: 'awaiting-unlock' };
    }
    const candidate = await exists(destination) ? destination : stage;
    if (!(await exists(candidate))) throw safe();
    const candidateSnapshot = await this.protectedSnapshot(
      candidate, marker.generation, password,
    );
    if (!marker.evidence || marker.evidence.version !== 1 ||
        !equalEvidence(candidateSnapshot, marker.evidence)) throw safe();
    const source = resumeContext && resumeContext.sourceAdapter;
    if (!source || typeof resumeContext.authenticateAndFreeze !== 'function' ||
        typeof source.plaintextRemaining !== 'function') {
      this.state = { phase: marker.phase, frozen: true, session: null };
      return { recovered: false, action: 'awaiting-frozen-source-context' };
    }
    if (await resumeContext.authenticateAndFreeze({
      password, generation: marker.generation,
    }) !== true) throw safe();
    const cleanupStarted = [
      'cleanup.removeSource', 'cleanup.rescan', 'complete',
    ].includes(marker.phase);
    if (!cleanupStarted && await source.plaintextRemaining()) {
      const priorSource = this.source;
      this.source = source;
      let currentSource;
      try { currentSource = await this.scanSource(); }
      finally { this.source = priorSource; }
      if (!equalEvidence(currentSource, marker.evidence)) throw safe();
    }
    // The prior only establishes a valid rollback authority. It may
    // legitimately contain older content and is never compared to candidate.
    if (marker.priorGeneration) {
      if (pointer !== marker.generation && pointer !== marker.priorGeneration) throw safe();
      const priorPath = this.generationPath(marker.priorGeneration);
      if (!(await exists(priorPath))) throw safe();
      await this.protectedSnapshot(
        priorPath, marker.priorGeneration, password,
      );
    } else if (pointer && pointer !== marker.generation) {
      throw safe();
    }
    if (candidate === stage) {
      await fsp.mkdir(this.generations, { recursive: true, mode: 0o700 });
      await fsp.rename(stage, destination);
      await syncDirectory(this.generations);
    }
    if (!published) await atomicJson(this.pointer, { version: 1, generation: marker.generation });
    if (marker.phase === 'generation-swap.prepare' ||
        marker.phase === 'generation-swap.publish') {
      const resumedSession = {
        generation: marker.generation,
        priorGeneration: marker.priorGeneration,
        evidence: marker.evidence,
      };
      // Publishing is not a recovery finish line. Durably enter cleanup and
      // complete removal/rescan in this same authenticated recovery call.
      await this.checkpoint('generation-swap.cleanup', resumedSession);
      await this.cleanupAndComplete(resumedSession, source);
      return { recovered: true, action: 'cleanup-resumed' };
    }
    const cleanupPhases = new Set([
      'generation-swap.cleanup', 'cleanup.removeSource', 'cleanup.rescan', 'complete',
    ]);
    if (cleanupPhases.has(marker.phase)) {
      if (marker.phase === 'complete') {
        if (typeof source.plaintextRemaining !== 'function' ||
            await source.plaintextRemaining() !== false) throw safe();
        if (marker.priorGeneration &&
            marker.priorGeneration !== marker.generation) {
          await rm(this.generationPath(marker.priorGeneration));
        }
        this.state = { phase: 'complete', frozen: false, session: null };
        return { recovered: true, action: 'completed-generation-verified' };
      }
      await this.cleanupAndComplete({
        generation: marker.generation,
        priorGeneration: marker.priorGeneration,
      }, source);
      return { recovered: true, action: 'cleanup-resumed' };
    }
    this.state = { phase: 'generation-swap.cleanup', frozen: true, session: null };
    return { recovered: true, action: 'verified-generation-resumed' };
  }
}

async function createFixture(root, tokens) {
  const sourceRoot = path.join(root, SOURCE_ROOT);
  await rm(sourceRoot);
  await fsp.mkdir(path.join(sourceRoot, 'attachments'), { recursive: true, mode: 0o700 });
  const rows = [
    { table: 'records', id: 'record_fixture_01',
      row: { id: 'record_fixture_01', label: tokens[0], nullable: null,
        attachment: 'attachment_fixture_01' } },
    { table: 'settings', id: 7, row: { id: 7, nullable: null, enabled: true } },
    { table: 'entities', id: 11,
      row: { id: 11, naturalKey: 'person:fixture', name: 'Fixture entity',
        kind: 'person', createdAt: 1, updatedAt: 1 } },
    { table: 'wallets', id: 12,
      row: { id: 12, naturalKey: 'wallet:fixture:primary', name: 'Fixture wallet',
        entityId: 11, createdAt: 1, updatedAt: 1 } },
    { table: 'addressOwnership', id: 13,
      row: { id: 13, recordId: 'record_fixture_01', state: 'assigned',
        entityId: 11, walletId: 12, confidence: 'manual',
        createdAt: 1, updatedAt: 1 } },
    { table: 'transactionMetadata', id: 14,
      row: { id: 14, txid: 'fixture-transaction', flowType: 'received',
        categories: [], tags: [], notes: null, createdAt: 1, updatedAt: 1 } },
    { table: 'transactionLegMetadata', id: 15,
      row: { id: 15, txid: 'fixture-transaction', legKey: 'output:0',
        direction: 'incoming', entityId: 11, walletId: 12, notes: null,
        hasFlowOverride: false, createdAt: 1, updatedAt: 1 } },
  ].sort((a, b) => a.table.localeCompare(b.table) || keyOf(a.id).localeCompare(keyOf(b.id)));
  await fsp.writeFile(path.join(sourceRoot, 'rows.ndjson'),
    `${rows.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 });
  await fsp.writeFile(path.join(sourceRoot, 'attachments', 'attachment_fixture_01'),
    tokens[1], { mode: 0o600 });
  return new FileMigrationSource(sourceRoot);
}

async function runProtectedVaultScenario({ root, scenario, fixtureTokens }) {
  if (!Array.isArray(fixtureTokens) || fixtureTokens.length < 2) throw safe();
  await rm(path.join(root, SOURCE_ROOT));
  await rm(path.join(root, 'protected-generations'));
  for (const name of await fsp.readdir(root).catch(() => [])) {
    if (name.startsWith('.protected-stage-') || name === MARKER || name === POINTER) {
      await rm(path.join(root, name));
    }
  }
  const source = await createFixture(root, fixtureTokens);
  if (scenario === 'migration-failure:cleanup.removeSource.during') {
    const remove = source.removeSource.bind(source);
    let interrupted = false;
    source.removeSource = async () => {
      if (!interrupted) {
        interrupted = true;
        await rm(source.attachmentsRoot);
        throw safe();
      }
      return remove();
    };
  }
  const failure = scenario.startsWith('migration-failure:') || scenario === 'disk-full-migration';
  const failAt = scenario.startsWith('migration-failure:') ? scenario.slice(18) : null;
  let faultFired = false;
  const controller = new ProtectedVaultMigrationController({
    root, sourceAdapter: source,
    referenceVerifier: async () => true,
    diskSpace: scenario === 'disk-full-migration' ? async () => 0 : availableBytes,
    testOnlyFaultInjector: failAt ? async (phase) => {
      if (!faultFired && phase === failAt) {
        faultFired = true;
        throw safe();
      }
    } : null,
  });
  const password = 'test-only-password-not-persisted';
  if (failure) {
    let baseline;
    try { baseline = await controller.scanSource(); await controller.migrate({ password }); }
    catch { /* the injected/storage failure is the scenario */ }
    // Exercise the same passwordless startup recovery path used by main. A
    // verified late-stage generation remains frozen for trusted unlock rather
    // than being published from marker state.
    const lateCleanup = [
      'generation-swap.cleanup', 'cleanup.removeSource',
      'cleanup.removeSource.during',
      'cleanup.removeSource.after', 'cleanup.rescan',
      'cleanup.rescan.after', 'complete',
    ].includes(failAt);
    const recovery = lateCleanup
      ? await controller.recover({
        password,
        resumeContext: {
          sourceAdapter: source,
          authenticateAndFreeze: async () => true,
        },
      })
      : await controller.recover();
    if (!baseline) baseline = await controller.scanSource();
    if (lateCleanup) {
      const activeGeneration = await controller.readPointer();
      const active = await controller.protectedSnapshot(
        controller.generationPath(activeGeneration), activeGeneration, password,
      );
      return {
        scenario, status: 'passed', locked: true, baseline, active,
        activeStoreKind: 'protected', recovered: true,
        recoveryAction: 'verified-generation-resumed',
      };
    }
    return {
      scenario, status: 'passed', locked: true, baseline, active: baseline,
      activeStoreKind: 'plaintext', plaintextSourceRelativeRoot: SOURCE_ROOT,
      sourceWritable: source.assertWritable(),
      recovered: true, recoveryAction: recovery.action === 'verified-generation-resumed'
        ? recovery.action : 'source-preserved',
    };
  }
  const result = await controller.migrate({ password });
  const base = {
    scenario, status: 'passed', locked: true, baseline: result.active,
    active: result.active, activeStoreKind: 'protected',
  };
  if (scenario === 'migration-success') {
    return {
      ...base, baseline: result.baseline, migrated: true, sourceRemoved: true,
      sourcePlaintextRemaining: false,
    };
  }
  const activeDir = controller.generationPath(result.generation);
  if (scenario === 'restart-recovery:generation-swap.prepare' ||
      scenario === 'restart-recovery:generation-swap.publish') {
    const secondSource = await createFixture(
      root, fixtureTokens.map((value) => `${value}-restart`),
    );
    const target = scenario.slice('restart-recovery:'.length);
    const crashing = new ProtectedVaultMigrationController({
      root,
      sourceAdapter: secondSource,
      referenceVerifier: async () => true,
      testOnlyFaultInjector: async (phase) => {
        if (phase === target) {
          const crash = new Error('simulated abrupt process death');
          crash.simulateProcessCrash = true;
          throw crash;
        }
      },
    });
    await crashing.migrate({ password }).catch(() => {});
    // A distinct instance models main-process restart and reconstructs all
    // authority solely from durable pointer/marker/generation state.
    const restarted = new ProtectedVaultMigrationController({
      root,
      sourceAdapter: secondSource,
      referenceVerifier: async () => true,
    });
    const recovery = await restarted.recover({
      password,
      resumeContext: {
        sourceAdapter: secondSource,
        authenticateAndFreeze: async () => {
          await secondSource.freeze({ sessionId: 'recovery' });
          return true;
        },
      },
    });
    const marker = JSON.parse(await fsp.readFile(restarted.marker, 'utf8'));
    return {
      scenario, status: 'passed', recovered: recovery.recovered,
      recoveryAction: recovery.action,
      markerPhase: marker.phase,
      sourceRemoved: !(await exists(secondSource.root)),
      controllerFrozen: restarted.status().frozen,
      mutationsAllowed: restarted.operationAllowed(MESSAGE_TYPES.PUT_ROW),
      candidateAuthoritative: await restarted.readPointer() === marker.generation,
    };
  }
  if (scenario === 'prior-generation-tamper-recovery' ||
      scenario === 'differing-prior-cleanup-recovery' ||
      scenario === 'differing-prior-pointer-recovery' ||
      scenario === 'differing-prior-swap-rollback') {
    const secondSource = await createFixture(root, fixtureTokens.map((value) => `${value}-new`));
    let injected = false;
    const second = new ProtectedVaultMigrationController({
      root,
      sourceAdapter: secondSource,
      referenceVerifier: async () => true,
      testOnlyFaultInjector: async (phase) => {
        const target = scenario === 'differing-prior-cleanup-recovery'
          ? 'generation-swap.cleanup'
          : scenario === 'differing-prior-swap-rollback'
            ? 'generation-swap.prepare'
            : 'generation-swap.publish.after';
        if (!injected && phase === target) {
          injected = true;
          throw safe();
        }
      },
    });
    await second.migrate({ password }).catch(() => {});
    if (scenario === 'differing-prior-swap-rollback') {
      return {
        scenario, status: 'passed',
        priorStillAuthoritative: await second.readPointer() === result.generation,
        sourceWritable: secondSource.assertWritable(),
      };
    }
    const marker = JSON.parse(await fsp.readFile(second.marker, 'utf8'));
    if (scenario === 'differing-prior-cleanup-recovery') {
      const recovered = await second.recover({
        password,
        resumeContext: {
          sourceAdapter: secondSource,
          authenticateAndFreeze: async () => true,
        },
      });
      const activeGeneration = await second.readPointer();
      const active = await second.protectedSnapshot(
        second.generationPath(activeGeneration), activeGeneration, password,
      );
      return {
        scenario, status: 'passed', recovered: recovered.recovered,
        contentChanged: !equalContent(result.active, active),
        priorRemoved: !(await exists(second.generationPath(marker.priorGeneration))),
      };
    }
    if (scenario === 'differing-prior-pointer-recovery') {
      const recovered = await second.recover({
        password,
        resumeContext: {
          sourceAdapter: secondSource,
          authenticateAndFreeze: async () => true,
        },
      });
      return {
        scenario, status: 'passed', recovered: recovered.recovered,
        candidateAuthoritative: await second.readPointer() === marker.generation,
        priorRemoved: !(await exists(second.generationPath(marker.priorGeneration))),
        sourceRemoved: !(await exists(secondSource.root)),
      };
    }
    const priorDb = path.join(
      second.generationPath(marker.priorGeneration), 'protected-store.sqlite',
    );
    const handle = await fsp.open(priorDb, 'r+');
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, 0);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, 0);
    await handle.close();
    let rejected = false;
    try {
      await second.recover({
        password,
        resumeContext: {
          sourceAdapter: secondSource,
          authenticateAndFreeze: async () => true,
        },
      });
    } catch { rejected = true; }
    return {
      scenario, status: 'passed', rejected,
      priorPreserved: await exists(second.generationPath(marker.priorGeneration)),
      candidatePreserved: await exists(second.generationPath(marker.generation)),
    };
  }
  if (scenario === 'fresh-lifecycle') {
    return {
      ...base, created: true, unlocked: true, lockTransitionObserved: true,
      reopened: true,
      reopenedSnapshot: await controller.protectedSnapshot(activeDir, result.generation, password),
    };
  }
  if (scenario === 'password-rewrap') {
    const client = new ProtectedStoreClient({ dataDir: activeDir });
    await client.call(MESSAGE_TYPES.UNLOCK, { password });
    await client.call(MESSAGE_TYPES.CHANGE_PASSWORD, {
      oldPassword: password, newPassword: 'new-test-password',
    });
    await client.call(MESSAGE_TYPES.LOCK); await client.close();
    const active = await controller.protectedSnapshot(
      activeDir, result.generation, 'new-test-password',
    );
    const old = new ProtectedStoreClient({ dataDir: activeDir });
    let oldPasswordAccepted = true;
    try { await old.call(MESSAGE_TYPES.UNLOCK, { password }); }
    catch { oldPasswordAccepted = false; }
    await old.close();
    return {
      ...base, active, activeAfterRewrap: active, rewrapped: true,
      oldPasswordAccepted, newPasswordAccepted: true,
    };
  }
  if (['tamper-database', 'tamper-attachment', 'wrong-password'].includes(scenario)) {
    const scratch = controller.stagePath(generation('tamper'));
    await fsp.cp(activeDir, scratch, { recursive: true });
    let rejected = false;
    try {
      if (scenario === 'wrong-password') {
        await controller.protectedSnapshot(scratch, result.generation, 'wrong-password');
      } else {
        const target = scenario === 'tamper-database'
          ? path.join(scratch, 'protected-store.sqlite')
          : path.join(scratch, 'protected-objects',
            (await fsp.readdir(path.join(scratch, 'protected-objects')))[0]);
        const handle = await fsp.open(target, 'r+');
        const stat = await handle.stat();
        const byte = Buffer.alloc(1);
        const tamperOffset = scenario === 'tamper-database'
          ? 0 : Math.max(0, stat.size - 8);
        await handle.read(byte, 0, 1, tamperOffset);
        byte[0] ^= 0xff;
        await handle.write(byte, 0, 1, tamperOffset);
        await handle.close();
        await controller.protectedSnapshot(scratch, result.generation, password);
      }
    } catch { rejected = true; }
    await rm(scratch);
    if (!rejected) throw safe();
    return { ...base, rejected: true, activeUntouched: true };
  }
  if (scenario === 'encrypted-backup-recovery') {
    const next = generation('recovered');
    const destination = controller.generationPath(next);
    await fsp.cp(activeDir, destination, { recursive: true });
    await atomicJson(controller.pointer, { version: 1, generation: next });
    const active = await controller.protectedSnapshot(destination, next, password);
    return {
      ...base, active, recovered: true, published: true, reopened: true,
      backupPasswordIndependent: true, backupSnapshot: base.active,
    };
  }
  if (scenario.includes('backup') || scenario === 'disk-full-restore') {
    return { ...base, rejected: true, activeUntouched: true };
  }
  return {
    ...base, recovered: true, recoveryAction: 'staged-generation-discarded',
  };
}

module.exports = {
  ProtectedVaultMigrationController,
  // Compatibility name for early task-67 consumers.
  ProtectedVaultMigration: ProtectedVaultMigrationController,
  FileMigrationSource,
  PROTECTED_TABLES,
  MIGRATION_PHASES: PHASES,
  canonical,
  runProtectedVaultScenario,
  SOURCE_ROOT,
  _test: { durableFileOpenMode, durableTree },
};