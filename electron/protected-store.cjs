/**
 * Narrow main-process client for the protected-store worker.  This module has
 * no Electron dependency so it is also usable by the Node integration tests.
 */
const path = require('path');
const { Worker } = require('worker_threads');

const MESSAGE_TYPES = Object.freeze({
  CREATE: 'create',
  UNLOCK: 'unlock',
  LOCK: 'lock',
  CHANGE_PASSWORD: 'changePassword',
  STATUS: 'status',
  INTEGRITY: 'integrity',
  PUT_ROW: 'putRow',
  GET_ROW: 'getRow',
  LIST_ROWS: 'listRows',
  DELETE_ROW: 'deleteRow',
  REPOSITORY: 'repository',
  WRITE_ATTACHMENT: 'writeAttachment',
  READ_ATTACHMENT: 'readAttachment',
  DELETE_ATTACHMENT: 'deleteAttachment',
  LIST_ATTACHMENTS: 'listAttachments',
  RENAME_ATTACHMENT: 'renameAttachment',
  BEGIN_ATTACHMENT: 'beginAttachment',
  APPEND_ATTACHMENT: 'appendAttachment',
  FINISH_ATTACHMENT: 'finishAttachment',
  ABORT_ATTACHMENT: 'abortAttachment',
  VERIFY_ATTACHMENTS: 'verifyAttachments',
});

// Canonical list shared by the worker, migration controller, and task-66
// repository handoff. New protected repository tables must be added here.
const PROTECTED_TABLES = Object.freeze([
  'records', 'attachments', 'tags', 'categories', 'owners', 'ownerResidencies', 'walletNames',
  'seedNames', 'walletSoftware', 'recordOrigins', 'customFields', 'settings',
  'priceData', 'blockchainTransactions', 'transactionParticipants',
  'addressSyncState', 'nodeSettings', 'derivationTemplates', 'utxoLineage',
  'custodySegments', 'lineageSnapshots', 'evidence', 'evidenceAttachments',
  'pausedSyncState', 'skippedAddresses', 'addressBlacklist',
  'partialExportBundles', 'trashedAttachments', 'privacyAuditHistory',
  'dustFlags', 'savedPsbts', 'adversaryScenarios', 'networkPrivacyActivity',
  'recordSearchIndex', 'recordSearchIndexState', 'vault',
  // v44 normalized record-model projection. These rows use the same encrypted
  // protected_rows boundary as legacy records; never route them to a sidecar.
  'entities', 'wallets', 'addressOwnership', 'transactionMetadata',
  'transactionLegMetadata', 'recordModelMigrationState',
  'ownershipReviewDecisions',
]);

const SAFE_ERROR = 'Protected store operation failed';

class ProtectedStoreClient {
  constructor({ dataDir, workerPath = path.join(__dirname, 'protected-store-worker.cjs') }) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
    this.workerPath = workerPath;
    this.dataDir = dataDir;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath, { workerData: { dataDir: this.dataDir } });
    worker.on('message', (message) => {
      const pending = this.pending.get(message && message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error('Protected store operation failed'));
    });
    const fail = () => {
      for (const [, pending] of this.pending) pending.reject(new Error('Protected store worker unavailable'));
      this.pending.clear();
      this.worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    this.worker = worker;
    return worker;
  }

  call(type, payload = {}) {
    if (!Object.values(MESSAGE_TYPES).includes(type)) {
      return Promise.reject(new TypeError('Unsupported protected-store operation'));
    }
    return new Promise((resolve, reject) => {
      const requestId = this.nextId++;
      this.pending.set(requestId, { resolve, reject });
      try {
        // Keep the correlation id and operation name outside the caller-owned
        // payload. Row ids named "id" must never overwrite the request id.
        this._ensureWorker().postMessage({ requestId, type, payload });
      } catch {
        this.pending.delete(requestId);
        reject(new Error('Protected store worker unavailable'));
      }
    });
  }

  async close() {
    if (!this.worker) return;
    const worker = this.worker;
    this.worker = null;
    await worker.terminate();
  }
}

function registerProtectedStoreHandlers(ipcMain, { dataDir, enabled, operationAllowed = () => true }) {
  const client = new ProtectedStoreClient({ dataDir });
  const handle = (channel, type, validate = () => true) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
       if ((!enabled || !operationAllowed(type)) && type !== MESSAGE_TYPES.STATUS) {
        return { ok: false, error: SAFE_ERROR };
      }
      if (!validate(payload || {})) return { ok: false, error: SAFE_ERROR };
      const result = type === MESSAGE_TYPES.STATUS && !enabled
        ? { mode: 'plaintext-fallback', available: false, exists: false, unlocked: false, verified: false, ready: false, version: 1 }
        : await client.call(type, payload || {});
      return { ok: true, result };
      } catch {
        return { ok: false, error: SAFE_ERROR };
      }
    });
  };
  const password = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096;

  handle('protected-store:status', MESSAGE_TYPES.STATUS);
  handle('protected-store:create', MESSAGE_TYPES.CREATE, (p) => password(p.password));
  handle('protected-store:unlock', MESSAGE_TYPES.UNLOCK, (p) => password(p.password));
  handle('protected-store:lock', MESSAGE_TYPES.LOCK);
  handle(
    'protected-store:changePassword',
    MESSAGE_TYPES.CHANGE_PASSWORD,
    (p) => password(p.oldPassword) && password(p.newPassword),
  );
  handle('protected-store:integrity', MESSAGE_TYPES.INTEGRITY);
  handle(
    'protected-store:putRow',
    MESSAGE_TYPES.PUT_ROW,
    (p) => typeof p.table === 'string' &&
      (typeof p.id === 'string' || Number.isSafeInteger(p.id)),
  );
  handle(
    'protected-store:getRow',
    MESSAGE_TYPES.GET_ROW,
    (p) => typeof p.table === 'string' &&
      (typeof p.id === 'string' || Number.isSafeInteger(p.id)),
  );
  handle(
    'protected-store:listRows',
    MESSAGE_TYPES.LIST_ROWS,
    (p) => typeof p.table === 'string',
  );
  handle(
    'protected-store:deleteRow',
    MESSAGE_TYPES.DELETE_ROW,
    (p) => typeof p.table === 'string' &&
      (typeof p.id === 'string' || Number.isSafeInteger(p.id)),
  );
  handle(
    'protected-store:repository',
    MESSAGE_TYPES.REPOSITORY,
    (p) => typeof p.repository === 'string' &&
      typeof p.collection === 'string' && typeof p.operation === 'string',
  );
  handle(
    'protected-store:writeAttachment',
    MESSAGE_TYPES.WRITE_ATTACHMENT,
    (p) => p.bytes instanceof ArrayBuffer || ArrayBuffer.isView(p.bytes),
  );
  handle(
    'protected-store:readAttachment',
    MESSAGE_TYPES.READ_ATTACHMENT,
    (p) =>
      typeof p.alias === 'string' ||
      (typeof p.name === 'string' && typeof p.id === 'string'),
  );
  handle(
    'protected-store:deleteAttachment',
    MESSAGE_TYPES.DELETE_ATTACHMENT,
    (p) => typeof p.alias === 'string' || typeof p.name === 'string',
  );
  handle('protected-store:listAttachments', MESSAGE_TYPES.LIST_ATTACHMENTS);
  handle(
    'protected-store:renameAttachment',
    MESSAGE_TYPES.RENAME_ATTACHMENT,
    (p) => typeof p.oldAlias === 'string' && typeof p.newAlias === 'string',
  );

  return {
    call: (type, payload) => enabled && operationAllowed(type)
      ? client.call(type, payload)
      : Promise.reject(new Error(SAFE_ERROR)),
    lock: () => enabled && operationAllowed(MESSAGE_TYPES.LOCK)
      ? client.call(MESSAGE_TYPES.LOCK).catch(() => undefined)
      : Promise.reject(new Error(SAFE_ERROR)),
    repository: (repository, collection, operation, payload = {}) => enabled
      && operationAllowed(MESSAGE_TYPES.REPOSITORY)
      ? client.call(MESSAGE_TYPES.REPOSITORY, { repository, collection, operation, ...payload })
      : Promise.reject(new Error(SAFE_ERROR)),
    close: () => client.close(),
  };
}

module.exports = {
  MESSAGE_TYPES,
  PROTECTED_TABLES,
  ProtectedStoreClient,
  registerProtectedStoreHandlers,
};