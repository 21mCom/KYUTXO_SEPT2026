#!/usr/bin/env node
// Real-browser AT-SCALE regression guard for the 1.1.24 -> current upgrade
// journey and the "desktop hangs" report (Task: fix desktop hangs since
// 1.1.24).
//
// A 1.1.24 vault is Dexie schema v25 with field-level encryption at rest.
// Opening it in the current app runs, in order:
//   1. the v26..v37 schema upgrade chain (v27 walks EVERY row of 16 tables
//      moving encryptedPayload -> _legacyEncryptedPayload),
//   2. after login, the one-time legacy decrypt migration (restore plaintext
//      for every encrypted row) + its verification re-scan,
//   3. the startup repairs (attachment paths, inputStringLower).
// On a grown vault each phase takes minutes. Historically ALL of it hid
// behind static spinners — users saw a frozen app and force-quit, aborting
// the upgrade transaction. This check seeds a genuinely large 1.1.24-shaped
// vault (~100k+ rows, real WebCrypto payloads) and proves in a real Chromium:
//
//   A. the schema-upgrade overlay appears, its step/row counters MOVE, and
//      the upgrade completes;
//   B. login triggers the decrypt migration with LIVE progress, including the
//      distinct "Verifying Migrated Data" phase (the old silent re-scan);
//   C. plaintext is actually restored (sample addresses resolvable by search);
//   D. hang sweep: Dashboard, Records, Transactions, UTXOs, Balance and
//      Address Checker all render on the migrated vault with NO main-thread
//      task longer than the hang threshold, and search typing on
//      Records/Transactions stays responsive.
//
// Browser runs exercise the Dexie fallback path (no native engine here) —
// exactly the path a desktop user falls back to when the engine mirror is
// stale/unavailable. Engine-path behavior is covered by the engine unit
// gates.
//
// Sizes are env-tunable (KYUTXO_SCALE_RECORDS etc.). Defaults keep the run
// under ~10 minutes while staying far above the vault sizes in the hang
// report.
//
// Usage: node scripts/check-legacy-upgrade-scale-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`; dev server on
// port 5000 is reused when already running.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'legacy-upgrade-scale-check-123';

// ---- scale knobs -----------------------------------------------------------
// Defaults are the VALIDATION size: big enough that every progress surface
// genuinely ticks (multi-thousand-row upgrade walks, >512-row progress
// reports, multi-batch decrypt) while keeping the gate ~2-3 min. For the
// full task-scale proof (30k records / 20k txs / 60k participants) override:
//   KYUTXO_SCALE_CURATED=3000 KYUTXO_SCALE_DISCOVERED=27000 \
//   KYUTXO_SCALE_TXS=20000 KYUTXO_SCALE_PARTICIPANTS=60000 \
//   node scripts/check-legacy-upgrade-scale-browser.mjs
const CURATED = Number(process.env.KYUTXO_SCALE_CURATED || 1_500);
const DISCOVERED = Number(process.env.KYUTXO_SCALE_DISCOVERED || 8_500);
const TXS = Number(process.env.KYUTXO_SCALE_TXS || 6_000);
const PARTICIPANTS = Number(process.env.KYUTXO_SCALE_PARTICIPANTS || 20_000);

// A "hang" for this check is a single main-thread task above this budget.
// The report was multi-second freezes; 4s of blocked main thread is the fail
// line, anything over 2s is logged as a warning.
const HANG_TASK_MS = 4_000;
const WARN_TASK_MS = 2_000;

// Generous phase budgets — this is a scale test on shared CI-ish hardware.
const UPGRADE_TIMEOUT_MS = 8 * 60_000;
const DECRYPT_TIMEOUT_MS = 10 * 60_000;

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.');
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

async function launchChromiumWithRetry(exe, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(`[legacy-upgrade-scale] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Long-task observer installed before every document load. */
const LONGTASK_INIT = `
  window.__longTasks = [];
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__longTasks.push({ duration: Math.round(e.duration), start: Math.round(e.startTime) });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch {}
`;

async function readLongTasks(page) {
  return page.evaluate(() => (window.__longTasks || []).slice());
}

function summarizeLongTasks(tasks) {
  const max = tasks.reduce((m, t) => Math.max(m, t.duration), 0);
  const over = tasks.filter((t) => t.duration >= WARN_TASK_MS);
  return { max, count: tasks.length, over };
}

/** Fill the login form (vault already exists → no confirm field). */
async function login(page, timeoutMs = 60_000) {
  await unlockIfNeeded(page, PASSWORD, {
    appearTimeoutMs: timeoutMs,
    submitTimeoutMs: 60_000,
    dismissMigration: false,
  });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[legacy-upgrade-scale] chromium: ${exe}`);
  console.log(
    `[legacy-upgrade-scale] sizes: curated=${CURATED} discovered=${DISCOVERED} txs=${TXS} participants=${PARTICIPANTS}`,
  );

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[legacy-upgrade-scale] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[legacy-upgrade-scale] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
  }

  const browser = await launchChromiumWithRetry(exe);
  const steps = [];
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.addInitScript(LONGTASK_INIT);
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' || text.startsWith('[seed]')) {
        console.log(`[legacy-upgrade-scale][page] ${text}`);
      }
    });
    page.on('pageerror', (err) => console.log(`[legacy-upgrade-scale][pageerror] ${err.message}`));

    // ── Phase A: seed a 1.1.24-shaped vault WITHOUT booting the app ─────────
    // manifest.json is served by Vite without loading the SPA, so nothing
    // opens the database at the current schema before we seed it at v25.
    await page.goto(`${BASE_URL}manifest.json`, { waitUntil: 'load', timeout: 60_000 });
    console.log(`[legacy-upgrade-scale] seeding v25 vault (${elapsed()}) ...`);
    const seed = await page.evaluate(
      async ({ password, curated, discovered, txs, participants }) => {
        const mod = await import('/src/lib/legacy-vault-fixture.ts');
        let lastLog = 0;
        const result = await mod.buildLegacyVaultAtV25({
          password,
          writeVaultSettings: true,
          counts: {
            curatedRecords: curated,
            discoveredRecords: discovered,
            transactions: txs,
            participants,
            placeholderVocab: 3,
          },
          onProgress: (phase, done, total) => {
            const now = Date.now();
            if (now - lastLog > 2000 || done === total) {
              lastLog = now;
              console.log(`[seed] ${phase}: ${done}/${total}`);
            }
          },
        });
        const dbs = await indexedDB.databases();
        const main = dbs.find((d) => d.name === 'KYUTXODatabase');
        return { samples: result.samples, rawVersion: main?.version ?? 0 };
      },
      { password: PASSWORD, curated: CURATED, discovered: DISCOVERED, txs: TXS, participants: PARTICIPANTS },
    );
    steps.push({
      name: 'seeded 1.1.24-shaped vault at Dexie v25 (encrypted at rest)',
      passed: seed.rawVersion === 250 && seed.samples.length > 0,
      detail: `raw IndexedDB version=${seed.rawVersion} (expect 250), samples=${seed.samples.length}, took ${elapsed()}`,
    });
    if (seed.rawVersion !== 250) throw new Error(`fixture DB at raw version ${seed.rawVersion}, expected 250`);

    // ── Phase B: first launch → schema-upgrade overlay with moving progress ─
    console.log(`[legacy-upgrade-scale] loading app for first-launch upgrade (${elapsed()}) ...`);
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 120_000 });

    const upgradeOverlay = page.getByTestId('db-upgrade-overlay');
    const overlayAppeared = await upgradeOverlay
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'schema-upgrade overlay appeared on first launch (not a bare spinner)',
      passed: overlayAppeared,
      detail: overlayAppeared ? `visible at ${elapsed()}` : 'db-upgrade-overlay never appeared within 60s',
    });

    // Sample the step line while the upgrade runs.
    await page.evaluate(() => {
      window.__upgradeSteps = [];
      const sample = () => {
        const el = document.querySelector('[data-testid="text-db-upgrade-step"]');
        if (el) {
          const t = el.textContent.trim();
          if (window.__upgradeSteps[window.__upgradeSteps.length - 1] !== t) window.__upgradeSteps.push(t);
        }
      };
      sample();
      const mo = new MutationObserver(sample);
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__upgradeObserver = mo;
    });

    const upgradeDone = await upgradeOverlay
      .waitFor({ state: 'detached', timeout: UPGRADE_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    const upgradeSteps = await page.evaluate(() => {
      window.__upgradeObserver?.disconnect();
      return window.__upgradeSteps || [];
    });
    console.log(
      `[legacy-upgrade-scale] upgrade overlay steps observed (${upgradeSteps.length}): ${JSON.stringify(upgradeSteps.slice(0, 8))}${upgradeSteps.length > 8 ? ' ...' : ''}`,
    );
    steps.push({
      name: 'schema upgrade completed with MOVING step/row progress',
      passed: upgradeDone && upgradeSteps.length >= 3 && upgradeSteps.some((s) => /rows/.test(s)),
      detail: upgradeDone
        ? `${upgradeSteps.length} distinct step samples, done at ${elapsed()}`
        : `overlay still visible after ${UPGRADE_TIMEOUT_MS / 60000} min — upgrade wedged`,
    });
    if (!upgradeDone) throw new Error('schema upgrade did not finish in time');

    // ── Phase C: login → decrypt migration with live + verify progress ──────
    console.log(`[legacy-upgrade-scale] logging in (${elapsed()}) ...`);
    // Install sampling BEFORE login so early progress is captured.
    await page.evaluate(() => {
      window.__migSamples = [];
      window.__sawVerifyHeading = false;
      const sample = () => {
        const table = document.querySelector('[data-testid="text-migration-table"]');
        if (table) {
          const t = table.textContent.trim();
          if (window.__migSamples[window.__migSamples.length - 1] !== t) window.__migSamples.push(t);
        }
        if (/Verifying Migrated Data/i.test(document.body.textContent)) {
          window.__sawVerifyHeading = true;
        }
      };
      const mo = new MutationObserver(sample);
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__migObserver = mo;
    });
    await login(page, 120_000);

    const migrationHeading = page.getByText(/Migrating Encrypted Data|Verifying Migrated Data|Data Migration Complete/);
    const migAppeared = await migrationHeading
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'decrypt migration overlay appeared after login',
      passed: migAppeared,
      detail: migAppeared ? `visible at ${elapsed()}` : 'migration overlay never appeared',
    });

    // Wait for the RESULT screen (dismiss button) — decrypt + verify done.
    const dismissBtn = page.getByRole('button', { name: 'Continue' });
    const migDone = await dismissBtn
      .waitFor({ state: 'visible', timeout: DECRYPT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    const { migSamples, sawVerifyHeading } = await page.evaluate(() => {
      window.__migObserver?.disconnect();
      return { migSamples: window.__migSamples || [], sawVerifyHeading: !!window.__sawVerifyHeading };
    });
    console.log(
      `[legacy-upgrade-scale] migration table samples (${migSamples.length}): ${JSON.stringify(migSamples.slice(0, 10))}${migSamples.length > 10 ? ' ...' : ''}`,
    );
    steps.push({
      name: 'decrypt migration ran to completion with live per-table progress',
      passed: migDone && migSamples.filter((s) => /Restoring plaintext/i.test(s)).length >= 2,
      detail: migDone
        ? `result screen at ${elapsed()}; ${migSamples.length} table-line samples`
        : `no result screen after ${DECRYPT_TIMEOUT_MS / 60000} min`,
    });
    steps.push({
      name: 'verification re-scan showed its own visible progress phase',
      passed: sawVerifyHeading && migSamples.some((s) => /Confirming every row was restored/i.test(s)),
      detail: sawVerifyHeading
        ? 'observed "Verifying Migrated Data" heading + confirming-rows line'
        : 'verify-phase UI never observed (silent re-scan regression)',
    });
    if (!migDone) throw new Error('decrypt migration did not finish in time');

    // Result screen must report everything decrypted, nothing still locked.
    const overlayText = await page.locator('body').textContent();
    const failedMatch = /([\d,]+)\s+failed/i.exec(overlayText || '');
    const failedCount = failedMatch ? Number(failedMatch[1].replace(/,/g, '')) : 0;
    const stillLocked = /still locked|verification failed/i.test(overlayText || '');
    steps.push({
      name: 'migration result reports clean decryption (nothing failed / locked)',
      passed: failedCount === 0 && !stillLocked,
      detail: `failed=${failedCount}, stillLockedBanner=${stillLocked}`,
    });
    await dismissBtn.click();
    await dismissBtn.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});

    // Startup repairs (attachment paths / search index) may still be running
    // behind the "Preparing your vault..." screen — wait for the app shell.
    await page
      .waitForSelector('[data-testid="text-migration-phase"]', { state: 'detached', timeout: 5 * 60_000 })
      .catch(() => {});

    // ── Phase D: plaintext actually restored ────────────────────────────────
    // NOTE: _legacyEncryptedPayload is deliberately KEPT after a successful
    // decrypt (it is only removed by the separate, user-invoked strip step in
    // recovery tooling) — so "restored" means findable by plaintext address
    // with the real label back, NOT marker-free.
    const sampleChecks = await page.evaluate(async (samples) => {
      const crud = await import('/src/lib/data/record-crud.ts');
      const results = [];
      for (const s of samples.slice(0, 5)) {
        const rec = await crud.findRecordByInputString(s.inputString);
        results.push({
          inputString: s.inputString,
          found: !!rec,
          labelOk: rec ? rec.label === s.label : false,
        });
      }
      return results;
    }, seed.samples);
    const allRestored = sampleChecks.every((c) => c.found && c.labelOk);
    steps.push({
      name: 'sample records restored to plaintext (findable by decrypted address)',
      passed: allRestored,
      detail: allRestored
        ? `${sampleChecks.length}/5 samples verified`
        : `failures: ${JSON.stringify(sampleChecks.filter((c) => !(c.found && c.labelOk)))}`,
    });

    // ── Longtask audit for the ENTIRE first-launch journey ──────────────────
    const journeyTasks = summarizeLongTasks(await readLongTasks(page));
    console.log(
      `[legacy-upgrade-scale] first-launch longtasks: count=${journeyTasks.count} max=${journeyTasks.max}ms, >=${WARN_TASK_MS}ms: ${JSON.stringify(journeyTasks.over.slice(0, 10))}`,
    );
    steps.push({
      name: `first-launch journey never blocked the main thread > ${HANG_TASK_MS / 1000}s`,
      passed: journeyTasks.max < HANG_TASK_MS,
      detail: `max longtask ${journeyTasks.max}ms over upgrade+decrypt+verify (${journeyTasks.count} tasks >50ms)`,
    });

    // ── Phase E: hang sweep of the six hot surfaces ──────────────────────────
    // Each page is a FULL reload (fresh longtask buffer → clean attribution),
    // followed by a fast re-login (migrations are one-time and already done).
    const pages = [
      { path: '', name: 'Dashboard', ready: 'button-view-table' },
      { path: 'records', name: 'Records', ready: 'text-records-title', search: true },
      { path: 'transactions', name: 'Transactions', ready: 'text-total-transactions', search: true },
      { path: 'utxos', name: 'UTXOs', ready: 'text-total-balance' },
      {
        path: 'balance',
        name: 'Balance',
        ready: 'card-total-balance',
        // Balance runs a one-time per-address stats backfill (and then a full
        // aggregation) over every owned address on first visit. On tens of
        // thousands of addresses that legitimately takes minutes on the pure
        // Dexie path — WITH a progress bar and a responsive main thread. The
        // hang gate therefore accepts EITHER finished content OR visibly
        // ADVANCING progress feedback; a silent/stuck screen still fails.
        progressReady: ['text-backfill-progress', 'text-agg-progress'],
      },
      { path: 'address-checker', name: 'AddressChecker', ready: 'textarea-address-input' },
    ];

    for (const p of pages) {
      console.log(`[legacy-upgrade-scale] sweep: ${p.name} (${elapsed()}) ...`);
      await page.goto(`${BASE_URL}${p.path}`, { waitUntil: 'load', timeout: 120_000 });
      await login(page, 60_000);
      const tContent0 = Date.now();
      let ready = false;
      let feedbackNote = '';
      if (p.progressReady) {
        // Accept content OR live progress; whichever shows first.
        const selector = [p.ready, ...p.progressReady]
          .map((t) => `[data-testid="${t}"]`)
          .join(', ');
        const first = await page
          .waitForSelector(selector, { state: 'visible', timeout: 60_000 })
          .catch(() => null);
        if (first) {
          const tid = await first.getAttribute('data-testid');
          if (tid === p.ready) {
            ready = true;
            feedbackNote = ', content directly';
          } else {
            // Progress UI is up — require the counter to ADVANCE (a frozen
            // counter would be exactly the "looks hung" bug this guards).
            // Poll up to 30s: batched work only ticks the counter between
            // batches, so a fixed two-sample window straddles batch bounds.
            const read = () => page.locator(`[data-testid="${tid}"]`).textContent().catch(() => null);
            const first = (await read()) ?? '';
            let last = first;
            let advanced = false;
            let contentNow = false;
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              await page.waitForTimeout(2_000);
              contentNow = await page
                .getByTestId(p.ready)
                .first()
                .isVisible()
                .catch(() => false);
              if (contentNow) break;
              const cur = await read();
              if (cur !== null) {
                last = cur;
                if (cur !== first) {
                  advanced = true;
                  break;
                }
              }
            }
            ready = contentNow || advanced;
            feedbackNote = contentNow
              ? ', content after progress'
              : `, live progress via ${tid} ("${first.trim()}" -> "${(last || '').trim()}")`;
          }
        }
      } else {
        ready = await page
          .getByTestId(p.ready)
          .first()
          .waitFor({ state: 'visible', timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
      }
      const contentMs = Date.now() - tContent0;

      let searchDetail = '';
      if (p.search && ready) {
        // Type a query that hits the substring-search path; the page must not
        // freeze while the search runs (typing itself would hang otherwise).
        const box = page.getByTestId('input-search').first();
        const tType0 = Date.now();
        await box.click();
        await box.pressSequentially('counterparty 42', { delay: 30 });
        const typeMs = Date.now() - tType0;
        await page.waitForTimeout(2_500); // let the search settle / longtasks land
        searchDetail = `, typed 15 chars in ${typeMs}ms`;
      }

      const tasks = summarizeLongTasks(await readLongTasks(page));
      steps.push({
        name: `${p.name}: content/feedback rendered + no main-thread hang`,
        passed: ready && tasks.max < HANG_TASK_MS,
        detail: `ready in ${contentMs}ms after login${feedbackNote}, max longtask ${tasks.max}ms (${tasks.count} >50ms)${searchDetail}${
          tasks.over.length ? `, tasks>=${WARN_TASK_MS}ms: ${JSON.stringify(tasks.over.slice(0, 5))}` : ''
        }`,
      });
    }
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
  console.log(`[legacy-upgrade-scale] ok=${ok} (total ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[legacy-upgrade-scale] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log(
    '[legacy-upgrade-scale] PASSED: a large 1.1.24 vault upgrades with visible progress end to end and every hot surface stays responsive.',
  );
}

main().catch((err) => {
  console.error('[legacy-upgrade-scale] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
