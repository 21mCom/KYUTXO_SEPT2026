/**
 * Electron main-process bridge to the native read-engine worker.
 *
 * Owns a single worker_thread (the esbuild bundle at engine/engine-worker.bundle.cjs)
 * and forwards a FIXED set of IPC channels to it with correlation-id request/
 * response. The renderer can never pass arbitrary SQL or file paths: the db path
 * is decided here from the app's dataDir (the USB in portable mode), and the
 * worker only accepts a closed enum of query names.
 *
 * The bundle is produced by scripts/build-native-engine.mjs. better-sqlite3 is
 * external + asarUnpack'd so the native addon loads from disk in production.
 */
const path = require('path');
const { Worker } = require('worker_threads');

let worker = null;
let dbPath = '';
let nextId = 1;
const pending = new Map();
let getWindowRef = null;

function workerScriptPath() {
  return path.join(__dirname, 'engine', 'engine-worker.bundle.cjs');
}

function rejectAllPending(err) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

// Forward a pushed finalize-progress event from the worker to the renderer.
// Best-effort: the seed itself never depends on the UI receiving these.
function forwardFinalizeProgress(progress) {
  try {
    const win = typeof getWindowRef === 'function' ? getWindowRef() : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('engine:finalizeProgress', progress);
    }
  } catch (err) {
    console.error('[KYUTXO][engine] failed to forward finalize progress:', err);
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(workerScriptPath(), { workerData: { dbPath } });

  worker.on('message', (res) => {
    // Un-correlated push events (e.g. finalize progress) carry a `kind` and no id.
    if (res && res.kind === 'finalizeProgress') {
      forwardFinalizeProgress(res.progress);
      return;
    }
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error || 'Engine worker error'));
  });
  worker.on('error', (err) => {
    console.error('[KYUTXO][engine] worker error:', err);
    rejectAllPending(err);
    worker = null; // allow a fresh spawn on the next call
  });
  worker.on('exit', (code) => {
    if (code !== 0) console.error(`[KYUTXO][engine] worker exited with code ${code}`);
    rejectAllPending(new Error(`Engine worker exited (code ${code})`));
    worker = null;
  });

  return worker;
}

function call(type, extra) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = ensureWorker();
    } catch (err) {
      reject(err);
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, ...(extra || {}) });
  });
}

/**
 * Register the fixed engine IPC surface.
 * @param ipcMain Electron ipcMain
 * @param {{ dataDir: string, portableMode?: boolean, getWindow?: () => import('electron').BrowserWindow | null }} opts
 *   `getWindow` returns the live main window so pushed worker events (finalize
 *   progress) can be forwarded to the renderer.
 */
function registerEngineHandlers(ipcMain, { dataDir, portableMode, getWindow }) {
  dbPath = path.join(dataDir, 'engine.sqlite');
  getWindowRef = typeof getWindow === 'function' ? getWindow : null;
  console.log('[KYUTXO][engine] db path:', dbPath);

  // Every handler returns a uniform envelope so the renderer never has to catch
  // a rejected invoke — it inspects { ok, result, error } instead.
  const wrap = (fn) => async (_event, payload) => {
    try {
      return { ok: true, result: await fn(payload) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };

  ipcMain.handle('engine:init', wrap(() => call('init')));
  ipcMain.handle('engine:status', wrap(() => call('status')));
  ipcMain.handle('engine:seedBegin', wrap(() => call('seedBegin')));
  ipcMain.handle('engine:seedBatch', wrap((p) => {
    const { table, rows } = p || {};
    if (typeof table !== 'string') throw new Error('seedBatch requires a table name');
    if (!Array.isArray(rows)) throw new Error('seedBatch requires a rows array');
    return call('seedBatch', { table, rows });
  }));
  ipcMain.handle('engine:seedFinish', wrap((p) => {
    const { sourceCounts } = p || {};
    if (!sourceCounts || typeof sourceCounts !== 'object') throw new Error('seedFinish requires sourceCounts');
    return call('seedFinish', { sourceCounts });
  }));
  ipcMain.handle('engine:query', wrap((p) => {
    const { name, args } = p || {};
    if (typeof name !== 'string') throw new Error('query requires a name');
    return call('query', { name, args });
  }));
  ipcMain.handle('engine:benchmark', wrap(() => call('benchmark')));
  ipcMain.handle('engine:reopen', wrap(() => call('reopen')));
  ipcMain.handle('engine:integrityCheck', wrap(() => call('integrityCheck')));
  ipcMain.handle('engine:clear', wrap(() => call('clear')));
  ipcMain.handle('engine:generateSynthetic', wrap((p) => {
    const { spec } = p || {};
    if (!spec || typeof spec !== 'object') throw new Error('generateSynthetic requires a spec object');
    return call('generateSynthetic', { spec });
  }));
  ipcMain.handle('engine:dbInfo', wrap(() => ({ dbPath, portableMode: !!portableMode })));
}

async function stopEngineWorker() {
  if (!worker) return;
  try {
    await worker.terminate();
  } catch (err) {
    console.error('[KYUTXO][engine] error terminating worker:', err);
  } finally {
    worker = null;
    rejectAllPending(new Error('Engine worker terminated'));
  }
}

module.exports = { registerEngineHandlers, stopEngineWorker };
