#!/usr/bin/env node
// Real-browser end-to-end guard for the automatic startup search-visibility
// repair (task: "Confirm the automatic startup repair actually fixes an old
// restored vault in a real browser").
//
// Task #1742 added a background, once-per-vault startup pass (AuthContext →
// runSearchVisibilityRepair) that detects and repairs the two data classes
// that make old records unfindable in Records search — invalid/missing
// importance tiers and desynced inputStringLower search keys — re-armed after
// backup restores. Node tests pin the detection/repair logic; the full
// journey (fire-and-forget orchestration on login, vault flag DB, Records
// search UI) only shows in a real browser. This script:
//   1. creates a fresh vault (fresh flags => the pass no-ops on first login)
//   2. seeds records, then corrupts them exactly like an old restored backup
//      would: one gets an unrecognized importance tier + stale
//      inputStringLower, one gets only a stale search key
//   3. re-arms the vault flag (same call the restore paths make)
//   4. logs out via the app's Lock Vault button, logs back in, and waits for
//      the BACKGROUND pass to finish (vault
//      flag flips true) without any UI blocking
//   5. asserts both records were repaired (valid tier, resynced search key)
//      and that the previously-unfindable record now shows up in the Records
//      page search UI
//   6. corrupts a record again WITHOUT re-arming, logs out and in again, and
//      asserts the pass does NOT run again (flag stays true, corruption
//      stays — proving once-per-vault-generation semantics)
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-search-visibility-repair-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'search-vis-repair-check-123';

// Unique, searchable identifiers (must differ in first 8 chars — testid rule).
const ADDR_TIER = 'bc1qsvrtiercorrupt000001checkaddr';
const ADDR_KEY = 'bc1qsvrkeycorrupt0000002checkaddr';
const BAD_TIER = 'legacy-priority-high'; // unrecognized tier from an old backup
const STALE_KEY = 'zzz-stale-search-key-from-old-backup';
const REPAIR_WAIT_MS = 90_000;
// How long we watch for the pass NOT running on the second login. The first
// pass on this tiny vault completes in well under a second; 8s of silence is
// a decisive "did not run".
const NO_RUN_WATCH_MS = 8_000;

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
  const hasConfirm = await confirmInput.isVisible().catch(() => false);
  if (hasConfirm) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
  return true;
}

// Drive the app's real logout flow: click the header "Lock Vault" button and
// verify the password screen actually appears. This is a genuine session end
// (AuthContext.logout), not a page reload.
async function logoutViaUi(page) {
  const btn = page.getByTestId('button-logout');
  await btn.waitFor({ state: 'visible', timeout: 30_000 });
  await btn.click();
  await page.getByTestId('input-password').waitFor({ state: 'visible', timeout: 30_000 });
}

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[search-vis-repair-browser] legacy-migration overlay detected; waiting it out ...');
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

async function main() {
  const exe = resolveChromium();
  console.log(`[search-vis-repair-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[search-vis-repair-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[search-vis-repair-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[search-vis-repair-browser] dev server ready at ${BASE_URL}`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel
  // validation load.
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
        `[search-vis-repair-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    // Console lines from the repair pass ("[SearchVisibilityRepair] ...") are
    // our run/no-run signal alongside the vault flag and the data itself.
    const repairLogs = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[SearchVisibilityRepair]')) {
        repairLogs.push(text);
        console.log(`[search-vis-repair-browser][page] ${text}`);
      } else if (msg.type() === 'error') {
        console.log(`[search-vis-repair-browser][page-console] ${text}`);
      }
    });

    // ── 1. Create the vault (fresh vault => all repair flags start true) ────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── 2. Seed + corrupt like an old restored backup, then re-arm ─────────
    const seed = await page.evaluate(
      async ({ addrTier, addrKey, badTier, staleKey }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');
        const vault = await import('/src/lib/vault.ts');

        const idTier = await recordCrud.createRecord({
          type: 'address',
          inputString: addrTier,
          label: 'SVR tier-corrupt record',
        });
        const idKey = await recordCrud.createRecord({
          type: 'address',
          inputString: addrKey,
          label: 'SVR key-corrupt record',
        });

        // Corrupt exactly like restored old-backup rows: an unrecognized
        // importance tier (dropped by the Dexie anyOf tier narrowings) plus a
        // desynced search key on one row; only a stale key on the other.
        // (Direct table writes here stand in for the raw restore write path —
        // the CRUD insert path would normalize both fields.)
        await db.records.update(idTier, {
          addressImportance: badTier,
          inputStringLower: staleKey,
        });
        await db.records.update(idKey, { inputStringLower: staleKey + '-2' });

        // Same re-arm call the v3/legacy restore paths make.
        await vault.rearmSearchVisibilityRepair();

        const flag = await vault.isSearchVisibilityRepaired();
        const rTier = await db.records.get(idTier);
        const rKey = await db.records.get(idKey);
        return {
          idTier,
          idKey,
          flag,
          tierNow: rTier?.addressImportance,
          keyNow: rTier?.inputStringLower,
          key2Now: rKey?.inputStringLower,
        };
      },
      { addrTier: ADDR_TIER, addrKey: ADDR_KEY, badTier: BAD_TIER, staleKey: STALE_KEY },
    );
    steps.push({
      name: 'seeded corrupted rows and re-armed the vault flag',
      passed:
        seed.flag === false &&
        seed.tierNow === BAD_TIER &&
        seed.keyNow === STALE_KEY &&
        seed.key2Now === `${STALE_KEY}-2`,
      detail: JSON.stringify(seed),
    });

    // Sanity: with a stale search key the record must NOT be findable via the
    // exact-identifier index right now (this is the bug class being repaired).
    const preSearch = await page.evaluate(async ({ addrTier }) => {
      const { db } = await import('/src/lib/database.ts');
      return db.records.where('inputStringLower').equals(addrTier.toLowerCase()).count();
    }, { addrTier: ADDR_TIER });
    steps.push({
      name: 'corrupted record is unfindable via the search index before repair',
      passed: preSearch === 0,
      detail: `index matches=${preSearch}`,
    });

    // ── 3. Explicit logout (Lock Vault), log back in — the pass must run ───
    repairLogs.length = 0;
    await logoutViaUi(page);
    const loggedIn = await unlockIfNeeded(page);
    steps.push({
      name: 'second session required a login',
      passed: loggedIn,
      detail: `loggedIn=${loggedIn}`,
    });

    // Wait for the fire-and-forget pass: flag flips true only on full success.
    const repaired = await page.evaluate(async ({ timeoutMs }) => {
      const vault = await import('/src/lib/vault.ts');
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await vault.isSearchVisibilityRepaired()) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    }, { timeoutMs: REPAIR_WAIT_MS });
    steps.push({
      name: `background repair completed within ${REPAIR_WAIT_MS / 1000}s of login (vault flag set)`,
      passed: repaired,
      detail: `flagFlipped=${repaired}; repair console lines: ${JSON.stringify(repairLogs)}`,
    });

    // ── 4. Both rows repaired in the DB ─────────────────────────────────────
    const post = await page.evaluate(async ({ idTier, idKey, addrTier, addrKey }) => {
      const { db } = await import('/src/lib/database.ts');
      const { isValidImportanceTier } = await import('/src/lib/db-types.ts');
      const rTier = await db.records.get(idTier);
      const rKey = await db.records.get(idKey);
      const indexHit = await db.records
        .where('inputStringLower')
        .equals(addrTier.toLowerCase())
        .count();
      return {
        tier: rTier?.addressImportance,
        tierValid: isValidImportanceTier(rTier?.addressImportance),
        keyTier: rTier?.inputStringLower,
        keyKey: rKey?.inputStringLower,
        expectedKeyTier: addrTier.toLowerCase(),
        expectedKeyKey: addrKey.toLowerCase(),
        indexHit,
      };
    }, { idTier: seed.idTier, idKey: seed.idKey, addrTier: ADDR_TIER, addrKey: ADDR_KEY });
    steps.push({
      name: 'invalid tier normalized to a recognized tier and both search keys resynced',
      passed:
        post.tierValid &&
        post.keyTier === post.expectedKeyTier &&
        post.keyKey === post.expectedKeyKey &&
        post.indexHit === 1,
      detail: JSON.stringify(post),
    });

    // ── 5. Record is findable in the Records page search UI ────────────────
    // A full navigation drops the in-memory session, so unlock again if the
    // lock screen appears (the flag is already set, so no pass re-runs here).
    await page.goto(`${BASE_URL}records`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    const searchInput = page.getByTestId('input-search');
    await searchInput.waitFor({ state: 'visible', timeout: 30_000 });
    await searchInput.fill(ADDR_TIER);
    const row = page.getByTestId(`row-record-${seed.idTier}`);
    const foundInUi = await row
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'previously-unfindable record shows up in Records search UI after repair',
      passed: foundInUi,
      detail: `row-record-${seed.idTier} visible=${foundInUi}`,
    });

    // ── 6. Second login: pass must NOT run again (flag already set) ─────────
    // Corrupt a row again WITHOUT re-arming; if the pass wrongly ran on every
    // login it would "fix" this row and log again.
    await page.evaluate(async ({ idKey, staleKey }) => {
      const { db } = await import('/src/lib/database.ts');
      await db.records.update(idKey, { inputStringLower: staleKey + '-again' });
    }, { idKey: seed.idKey, staleKey: STALE_KEY });

    repairLogs.length = 0;
    await logoutViaUi(page);
    const secondLogin = await unlockIfNeeded(page);
    await page.waitForTimeout(NO_RUN_WATCH_MS);

    const second = await page.evaluate(async ({ idKey }) => {
      const { db } = await import('/src/lib/database.ts');
      const vault = await import('/src/lib/vault.ts');
      const rKey = await db.records.get(idKey);
      return {
        flag: await vault.isSearchVisibilityRepaired(),
        keyNow: rKey?.inputStringLower,
      };
    }, { idKey: seed.idKey });
    steps.push({
      name: 'repair does NOT run again on a second login (flag stays set, corruption untouched)',
      passed:
        secondLogin &&
        second.flag === true &&
        second.keyNow === `${STALE_KEY}-again` &&
        repairLogs.length === 0,
      detail: `login=${secondLogin} flag=${second.flag} key=${second.keyNow} repairLogs=${JSON.stringify(repairLogs)}`,
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

  console.log(`[search-vis-repair-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[search-vis-repair-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[search-vis-repair-browser] PASSED: the once-per-vault startup repair fixes restored-backup corruption in a real browser, the record is findable in Records search, and the pass does not re-run once the flag is set.',
  );
}

main().catch((err) => {
  console.error('[search-vis-repair-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
