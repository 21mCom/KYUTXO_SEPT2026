// Shared scaffolding for the injected `window.electronAPI.engine` bridge used
// by the engine-served browser checks (Tasks #1859/#1866; see
// .agents/memory/browser-engine-bridge-mock.md). It builds the addInitScript
// STRING both checks feed to Playwright, so the common bridge semantics live
// in exactly one place and cannot silently drift between checks:
//   - inert until the page sets localStorage.__engineMockEnabled = '1'
//   - status/init report READY; dbInfo reports non-portable
//   - seedBegin/seedBatch/seedFinish/clear are accepted as no-ops so an
//     incidental seedAll can never wedge (the mirror is live-IDB-backed)
//   - getEngineSchemaVersion echoes localStorage.__engineMockSchemaVersion
//     (stamp the app's own ENGINE_SCHEMA_VERSION there from page context)
//   - unimplemented queries return { ok:false, error } envelopes — production
//     treats that as engine failure → Dexie fallback, safe by construction
//   - any handler throw is recorded in state.queryErrors and returned as an
//     error envelope
//   - deliberately NO isElectron flag: isEngineAvailable() only needs
//     window.electronAPI.engine, while isElectron() checks the flag — so no
//     other desktop-only code path (attachments, routing, ...) activates
//
// Shared in-bridge helpers available to per-check code (helpers/handlers):
//   env(result) / errEnv(error)      — IPC result envelopes
//   openIdb() / withDb(fn)           — open the live KYUTXODatabase IndexedDB
//   cursorMax(source, extract)       — max over an index/store ('prev' cursor)
//   storeCount(store)                — IDBObjectStore.count() as a promise
//   getAllRows(idb, storeName)       — full-store getAll ([] when missing)
//   recordsFingerprint()             — { count, maxId, maxUpdatedAt } from the
//                                      live records store (same fields the
//                                      Dexie getRecordsFingerprint reports),
//                                      so the mirror is fresh by construction
//
// Per-check code plugs in via buildEngineBridgeInitScript options:
//   stateFields   — extra `window.__engineMock` state properties
//                   (instrumentation counters/call logs), e.g.
//                   `pageReads: 0, pageCalls: [],`
//   helpers       — extra function/const definitions (may use shared helpers)
//   queryHandlers — the body of the query dispatcher: a series of
//                   `if (name === '...') { ...; return env(...); }` blocks.
//                   Runs inside the shared try/catch AFTER the shared
//                   getEngineSchemaVersion case; fall-through hits the shared
//                   not-implemented error envelope (recorded in
//                   state.unsupported when that array exists in stateFields).

/**
 * Build the init-script string for an injected engine bridge.
 * @param {object} opts
 * @param {string} [opts.stateFields] extra state-object literal fields
 * @param {string} [opts.helpers] extra helper definitions
 * @param {string} opts.queryHandlers per-check `if (name === ...)` blocks
 * @param {boolean} [opts.alwaysEnabled] install without the localStorage opt-in
 * @returns {string} script for `context.addInitScript(...)`
 */
export function buildEngineBridgeInitScript({
  stateFields = '',
  helpers = '',
  queryHandlers,
  alwaysEnabled = false,
}) {
  if (typeof queryHandlers !== 'string' || queryHandlers.trim() === '') {
    throw new Error('buildEngineBridgeInitScript: queryHandlers is required');
  }
  return `(() => {
  let enabled = ${alwaysEnabled ? 'true' : 'false'};
  ${alwaysEnabled ? '' : "try { enabled = localStorage.getItem('__engineMockEnabled') === '1'; } catch {}"}
  if (!enabled) return;

  const state = { queryErrors: [], ${stateFields} };
  window.__engineMock = state;

  const env = (result) => ({ ok: true, result });
  const errEnv = (error) => ({ ok: false, error });
  const snapshot = () => ({ state: 'READY', ready: true });

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('KYUTXODatabase');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('mock: IndexedDB open failed'));
      req.onblocked = () => reject(new Error('mock: IndexedDB open blocked'));
    });
  }

  async function withDb(fn) {
    const idb = await openIdb();
    try { return await fn(idb); } finally { idb.close(); }
  }

  function cursorMax(source, extract) {
    return new Promise((resolve, reject) => {
      const req = source.openCursor(null, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        resolve(c ? extract(c) : 0);
      };
      req.onerror = () => reject(req.error || new Error('mock: cursor failed'));
    });
  }

  function storeCount(store) {
    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('mock: count failed'));
    });
  }

  function getAllRows(idb, store) {
    return new Promise((resolve, reject) => {
      if (!idb.objectStoreNames.contains(store)) { resolve([]); return; }
      const tx = idb.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('mock: getAll failed'));
    });
  }

  // Same fields the Dexie getRecordsFingerprint reports, computed straight
  // from the SAME IndexedDB — so the mirror is fresh by construction, like a
  // mirror that finished seeding an instant ago with no writes since.
  async function recordsFingerprint() {
    return withDb(async (idb) => {
      if (!idb.objectStoreNames.contains('records')) throw new Error('mock: no records store');
      const tx = idb.transaction('records', 'readonly');
      const store = tx.objectStore('records');
      const [count, maxId, maxUpdatedAt] = await Promise.all([
        storeCount(store),
        cursorMax(store, (c) => Number(c.value?.id ?? c.primaryKey) || 0),
        cursorMax(store.index('updatedAt'), (c) => Number(c.value?.updatedAt) || 0),
      ]);
      return { count, maxId, maxUpdatedAt };
    });
  }

${helpers}

  const engine = {
    init: async () => env(snapshot()),
    status: async () => env(snapshot()),
    dbInfo: async () => env({ portableMode: false }),
    // Seed calls are accepted as no-ops so an incidental seedAll (e.g. launch
    // bootstrap or a maintenance surface) can never wedge; the mirror is
    // live-IDB-backed and fresh by construction.
    seedBegin: async () => env(null),
    seedBatch: async () => env(null),
    seedFinish: async () => env(null),
    clear: async () => env(snapshot()),
    query: async (name, opts) => {
      try {
        if (name === 'getEngineSchemaVersion') {
          const v = localStorage.getItem('__engineMockSchemaVersion');
          return env(v === null ? -1 : Number(v));
        }
${queryHandlers}
        if (Array.isArray(state.unsupported)) state.unsupported.push(String(name));
        return errEnv('mock: query not implemented: ' + name);
      } catch (e) {
        state.queryErrors.push(String((e && e.message) || e));
        return errEnv('mock: ' + String((e && e.message) || e));
      }
    },
  };

  // Deliberately NO isElectron flag: isEngineAvailable() only needs
  // window.electronAPI.engine, while isElectron() checks the flag — so no
  // other desktop-only code path (attachments, routing, ...) is activated.
  window.electronAPI = { engine };
})();`;
}
