#!/usr/bin/env node
// Real-browser guard for the Dashboard's "Show hidden matches" reveal when the
// FAST READ-ENGINE serves the records window (Task #1859).
//
// NOTE for reviewers: the route exercised here is "/" — the records Dashboard
// (client/src/pages/Dashboard.tsx, see App.tsx `<Route path="/">`), NOT the
// /records page. The native SQLite read-engine only exists in the Electron
// desktop build (client/src/lib/engine/engine-client.ts: isEngineAvailable()
// requires window.electronAPI.engine), so every prior browser check of this
// page — including check-dashboard-hidden-matches-browser.mjs — exercised the
// Dexie fallback of fetchFilteredRecordPage (client/src/hooks/use-records.ts).
// This check closes that gap: it injects a minimal `window.electronAPI.engine`
// bridge into the page BEFORE the app boots. The bridge reports READY, echoes
// the app's own ENGINE_SCHEMA_VERSION, and answers getRecordsFingerprint /
// getRecordPageByUpdatedAt directly from the live IndexedDB vault — i.e. it
// behaves exactly like a freshly-seeded, perfectly-in-sync mirror. That drives
// the REAL production decision path end-to-end in a real browser:
//   evaluateEngineFreshness('records')  → ready + schema match + fingerprint
//                                         compare against Dexie → useEngine
//   fetchFilteredRecordPage             → engineGetRecordPageByUpdatedAt →
//                                         bulkGetRecords hydration
// while instrumenting the bridge so we can PROVE the window reads were served
// by the engine path (window.__engineMock.pageCalls) and that the revealed row
// was NOT in any engine-served window (out-of-window reveal).
//
// Flow:
//   1. create a fresh vault; seed 5,100 recently-updated visible fillers plus
//      ONE blockchain-discovered row whose updatedAt is older than every
//      filler (never inside the 5,000-row window, with or without discovered
//      tiers included); persist the app's ENGINE_SCHEMA_VERSION + an enable
//      flag to localStorage
//   2. reload (init-script bridge now active) and unlock; assert
//      evaluateEngineFreshness('records') === { useEngine:true, 'ready-fresh' }
//      and that the Dashboard's initial window read went through the engine
//   3. search a token that only matches the hidden row → "1 match is hidden"
//      notice → click "Show hidden matches" → the row renders exactly once
//   4. assert the post-click window read was engine-served with
//      includeBlockchainDiscovered=true and did NOT contain the hidden row's
//      id — proving the reveal's vault-wide fetch (getHiddenTierMatches), not
//      the engine window, surfaced it
//
// Everything runs offline against local IndexedDB — no network requests.
// Usage: node scripts/check-dashboard-hidden-matches-engine-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dash-hidden-engine-123';

// Unique identifiers — first 8 chars differ (testid slicing rule).
const ADDR_HIDDEN = 'bc1qdehidden0000000000001checkaddr';
// Search token that appears ONLY in the hidden row's label + walletName.
const HIDDEN_TOKEN = 'dehiddenenginetoken';
const FILLER_COUNT = 5_100;

// Injected before any app script on every navigation. Inert until the page
// sets localStorage.__engineMockEnabled = '1' (i.e. never during vault
// creation/seeding), so the app's first run is a plain browser session.
// The bridge implements ONLY the closed set of calls the records read path
// uses; every other query returns a failure envelope, which the production
// code treats as "fall back to Dexie" — exactly like a real engine error.
const ENGINE_BRIDGE_INIT = `(() => {
  let enabled = false;
  try { enabled = localStorage.getItem('__engineMockEnabled') === '1'; } catch {}
  if (!enabled) return;

  const state = { pageReads: 0, pageCalls: [], fingerprintReads: 0, queryErrors: [] };
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

  // Same fields getRecordsFingerprint (Dexie side) reports, computed straight
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

  // updatedAt DESC, id DESC (IDB 'prev' iterates descending key, then
  // descending primary key within equal keys) — the engine query's order.
  function recordPageByUpdatedAt(opts) {
    const includeBD = !!(opts && opts.includeBlockchainDiscovered);
    const offset = Math.max(0, Number(opts && opts.offset) || 0);
    const limit = Math.max(0, Number(opts && opts.limit) || 0);
    return withDb((idb) => new Promise((resolve, reject) => {
      if (!idb.objectStoreNames.contains('records')) {
        reject(new Error('mock: no records store'));
        return;
      }
      const rows = [];
      let skipped = 0;
      const tx = idb.transaction('records', 'readonly');
      const req = tx.objectStore('records').index('updatedAt').openCursor(null, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || rows.length >= limit) {
          resolve(rows);
          return;
        }
        const v = c.value || {};
        const tier = v.addressImportance;
        const excluded = !includeBD && (tier === 'blockchain-discovered' || tier === 'pending-review');
        if (!excluded) {
          if (skipped < offset) skipped++;
          else rows.push({ id: Number(v.id), updatedAt: Number(v.updatedAt) || 0, addressImportance: tier ?? null });
        }
        c.continue();
      };
      req.onerror = () => reject(req.error || new Error('mock: page cursor failed'));
    }));
  }

  const engine = {
    init: async () => env(snapshot()),
    status: async () => env(snapshot()),
    dbInfo: async () => env({ portableMode: false }),
    // Seed calls are accepted as no-ops so an incidental seedAll (e.g. a
    // maintenance surface) can never wedge; the mirror is live-IDB-backed.
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
        if (name === 'getRecordsFingerprint') {
          state.fingerprintReads++;
          return env(await recordsFingerprint());
        }
        if (name === 'getRecordPageByUpdatedAt') {
          const rows = await recordPageByUpdatedAt(opts);
          state.pageReads++;
          state.pageCalls.push({
            includeBlockchainDiscovered: !!(opts && opts.includeBlockchainDiscovered),
            offset: Number(opts && opts.offset) || 0,
            limit: Number(opts && opts.limit) || 0,
            ids: rows.map((r) => r.id),
          });
          return env(rows);
        }
        // Empty-vault tx/participant fingerprints so an 'allMirrors' probe on a
        // tx-less vault matches Dexie's zeros; anything else falls back to Dexie.
        if (name === 'getTransactionsFingerprint' || name === 'getParticipantsFingerprint') {
          const store = name === 'getTransactionsFingerprint' ? 'blockchainTransactions' : 'transactionParticipants';
          const count = await withDb((idb) =>
            idb.objectStoreNames.contains(store)
              ? new Promise((res, rej) => {
                  const tx = idb.transaction(store, 'readonly');
                  const req = tx.objectStore(store).count();
                  req.onsuccess = () => res(req.result);
                  req.onerror = () => rej(req.error);
                })
              : Promise.resolve(0),
          );
          if (count !== 0) return errEnv('mock: non-empty ' + store + ' not supported');
          return env(
            name === 'getTransactionsFingerprint'
              ? { count: 0, maxId: 0, maxBlockTime: 0 }
              : { count: 0, maxId: 0, resolvedPrevoutCount: 0 },
          );
        }
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

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.',
    );
  }
}

async function isServerUp(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[dash-hidden-engine] legacy-migration overlay detected; waiting it out ...');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await overlay.isVisible().catch(() => false))) return;
    const dismiss = page.getByTestId('button-dismiss-migration');
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  throw new Error('legacy-migration overlay did not clear within 60s');
}

async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await dismissMigrationOverlayIfPresent(page);
    return false;
  }
  await pwInput.fill(SETUP_PASSWORD);
  const confirmInput = page.getByTestId('input-confirm-password');
  if (await confirmInput.isVisible().catch(() => false)) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
  return true;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dash-hidden-engine] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dash-hidden-engine] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dash-hidden-engine] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[dash-hidden-engine] dev server ready at ${BASE_URL}`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel load.
  let browser = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(
        `[dash-hidden-engine] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(ENGINE_BRIDGE_INIT);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[dash-hidden-engine][page-console] ${msg.text()}`);
      }
    });

    // ── 1. Create the vault (engine bridge still inert) ─────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── 2. Seed: 5,100 recently-updated visible fillers + ONE hidden-tier row
    //        older than every filler (outside the 5,000-row window no matter
    //        which tiers are included). Then arm the engine bridge. ──────────
    const seed = await page.evaluate(
      async ({ addrHidden, hiddenToken, fillerCount }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');
        const { ENGINE_SCHEMA_VERSION } = await import('/src/lib/engine/engine-core.ts');

        const base = 2_000_000;
        const fillers = [];
        for (let i = 0; i < fillerCount; i++) {
          const inputString = `bc1qdefiller${String(i).padStart(6, '0')}fillerrowaddr`;
          fillers.push({
            type: 'address',
            inputString,
            inputStringLower: inputString.toLowerCase(),
            label: `Filler ${i}`,
            tags: [],
            categories: [],
            source: 'manual',
            addressImportance: 'manual',
            createdAt: base + i,
            updatedAt: base + i,
          });
        }
        // Bulk add for speed; direct table writes stand in for a big synced
        // vault's filler rows (they carry valid tiers + synced search keys).
        await db.records.bulkAdd(fillers);

        const idHidden = await recordCrud.createRecord({
          type: 'address',
          inputString: addrHidden,
          label: `Old discovered counterparty ${hiddenToken}`,
          walletName: hiddenToken,
          tags: [],
          categories: [],
          source: 'blockchain-sync',
          addressImportance: 'blockchain-discovered',
          createdAt: 1_000_000,
          updatedAt: 1_000_000,
        });

        const rHidden = await db.records.get(idHidden);
        const total = await db.records.count();

        // Arm the init-script engine bridge for the NEXT page load, stamping
        // the app's own current schema version so the schema gate passes.
        localStorage.setItem('__engineMockSchemaVersion', String(ENGINE_SCHEMA_VERSION));
        localStorage.setItem('__engineMockEnabled', '1');

        return { idHidden, hiddenTier: rHidden?.addressImportance, total, schemaVersion: ENGINE_SCHEMA_VERSION };
      },
      { addrHidden: ADDR_HIDDEN, hiddenToken: HIDDEN_TOKEN, fillerCount: FILLER_COUNT },
    );
    steps.push({
      name: 'seed: 5,100 visible fillers + one hidden-tier row older than all fillers (outside the load window)',
      passed: seed.hiddenTier === 'blockchain-discovered' && seed.total === FILLER_COUNT + 1,
      detail: JSON.stringify(seed),
    });

    // ── 3. Reload with the engine bridge active; unlock; verify the REAL
    //        freshness gate elects the engine for the records scope. ─────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const gate = await page.evaluate(async () => {
      const { isEngineAvailable } = await import('/src/lib/engine/engine-client.ts');
      const { evaluateEngineFreshness } = await import('/src/lib/engine/engine-freshness.ts');
      const decision = await evaluateEngineFreshness('records');
      return { available: isEngineAvailable(), decision };
    });
    steps.push({
      name: "engine bridge active: evaluateEngineFreshness('records') elects the engine (ready-fresh)",
      passed: gate.available && gate.decision.useEngine === true && gate.decision.reason === 'ready-fresh',
      detail: JSON.stringify(gate),
    });

    // The Dashboard's initial window read (mounted at unlock) must have been
    // served through the engine bridge, not the Dexie fallback.
    const initialRead = await page
      .waitForFunction(() => (window.__engineMock?.pageReads ?? 0) >= 1, null, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    const mockAfterMount = await page.evaluate(() => ({
      pageReads: window.__engineMock?.pageReads ?? 0,
      queryErrors: window.__engineMock?.queryErrors ?? ['__engineMock missing'],
    }));
    steps.push({
      name: 'the Dashboard records window is served by the engine read path',
      passed: initialRead && mockAfterMount.pageReads >= 1 && mockAfterMount.queryErrors.length === 0,
      detail: JSON.stringify(mockAfterMount),
    });

    // ── 4. Search → notice → reveal, all while the engine serves the window ─
    const searchInput = page.getByTestId('input-search');
    await searchInput.waitFor({ state: 'visible', timeout: 60_000 });

    const hiddenRow = page.getByTestId(`row-record-${seed.idHidden}`);
    const hiddenBeforeSearch = await hiddenRow.count();
    steps.push({
      name: 'hidden row is not listed in the default view',
      passed: hiddenBeforeSearch === 0,
      detail: `row-record-${seed.idHidden} count=${hiddenBeforeSearch}`,
    });

    await searchInput.fill(HIDDEN_TOKEN);

    const notice = page.getByTestId('notice-hidden-matches');
    const noticeVisible = await notice
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    const noticeText = noticeVisible ? ((await notice.textContent()) ?? '').trim() : '';
    steps.push({
      name: 'search matching only an out-of-window hidden row shows the "match is hidden" notice',
      passed: noticeVisible && /1\s*match is\s*hidden/i.test(noticeText.replace(/\s+/g, ' ')),
      detail: noticeVisible ? `notice text: ${JSON.stringify(noticeText)}` : 'notice never appeared',
    });

    const readsBeforeClick = await page.evaluate(() => window.__engineMock?.pageReads ?? 0);

    if (noticeVisible) {
      await page.getByTestId('button-show-hidden-matches').click();
      const shown = await hiddenRow
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      const rowCount = await hiddenRow.count();
      steps.push({
        name: '"Show hidden matches" reveals the out-of-window hidden row exactly once (engine-served window)',
        passed: shown && rowCount === 1,
        detail: `row-record-${seed.idHidden} visible=${shown} count=${rowCount} (count>1 would mean the union duplicated a window row)`,
      });
    } else {
      steps.push({
        name: '"Show hidden matches" reveals the out-of-window hidden row exactly once (engine-served window)',
        passed: false,
        detail: 'skipped — notice never appeared',
      });
    }

    // ── 5. Prove the reveal-time window was engine-served AND did not contain
    //        the hidden row (i.e. the vault-wide reveal fetch surfaced it). ───
    const revealWindowOk = await page
      .waitForFunction(
        () => (window.__engineMock?.pageCalls ?? []).some((c) => c.includeBlockchainDiscovered),
        null,
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    const mockFinal = await page.evaluate((hiddenId) => {
      const calls = window.__engineMock?.pageCalls ?? [];
      const bdCalls = calls.filter((c) => c.includeBlockchainDiscovered);
      return {
        pageReads: window.__engineMock?.pageReads ?? 0,
        bdCallCount: bdCalls.length,
        anyWindowContainedHiddenRow: calls.some((c) => c.ids.includes(hiddenId)),
        lastBdCall: bdCalls.length
          ? { offset: bdCalls[bdCalls.length - 1].offset, limit: bdCalls[bdCalls.length - 1].limit, rows: bdCalls[bdCalls.length - 1].ids.length }
          : null,
        queryErrors: window.__engineMock?.queryErrors ?? [],
      };
    }, seed.idHidden);
    steps.push({
      name: 'post-click window read is engine-served with discovered tiers included, and NO engine window ever contained the hidden row (reveal is vault-wide, not window luck)',
      passed:
        revealWindowOk &&
        mockFinal.pageReads > readsBeforeClick &&
        mockFinal.bdCallCount >= 1 &&
        mockFinal.anyWindowContainedHiddenRow === false &&
        mockFinal.queryErrors.length === 0,
      detail: JSON.stringify({ readsBeforeClick, ...mockFinal }),
    });
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }

  const ok = steps.every((s) => s.passed);

  console.log(`[dash-hidden-engine] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dash-hidden-engine] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dash-hidden-engine] PASSED: with the read-engine serving the Dashboard records window (READY + fingerprint-fresh), the "Show hidden matches" reveal still fetches the out-of-window hidden match vault-wide and renders it exactly once.',
  );
}

main().catch((err) => {
  console.error('[dash-hidden-engine] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
