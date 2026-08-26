#!/usr/bin/env node
// Real-browser end-to-end guard for the hidden-search-matches hint on the
// Records page and the two Database Doctor repair buttons (Task #1740 UI).
//
// jsdom + Node tests already pin the notice rendering, the dynamic Dexie tier
// narrowing, and the provenance-aware repairs — but this repo has a history of
// browser-only failure classes (real IndexedDB semantics, stale bundles) that
// jsdom cannot catch. This script drives the real pages in headless Chromium:
//   1. creates a fresh vault
//   2. seeds three rows: a TAGGED blockchain-discovered (hidden-tier) row, a
//      row with an unrecognized legacy tier + desynced search key, and a row
//      with only a stale search key
//   3. searches on the Records page for a token that only matches the hidden
//      row, asserts the "N matches are hidden" notice appears, clicks the
//      one-click "Show hidden matches" button, and asserts the row appears
//   4. asserts the stale-key rows are unfindable via the search index
//   5. opens Database Doctor, runs the health check, clicks BOTH repair
//      buttons ("Rebuild search keys", "Normalize tiers"), and waits for the
//      repairs to land in IndexedDB
//   6. returns to Records and asserts both previously-unfindable rows are now
//      found via the exact-identifier search UI
//
// Everything runs offline against local IndexedDB — no network requests.
// Usage: node scripts/check-records-search-visibility-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'records-vis-check-123';

// Unique identifiers — first 8 chars differ (testid slicing rule).
const ADDR_HIDDEN = 'bc1qrvhidden000000000001checkaddr';
const ADDR_TIER = 'bc1qrvtiercorrupt0000002checkaddr';
const ADDR_KEY = 'bc1qrvkeycorrupt00000003checkaddr';
// Search token that appears ONLY in the hidden row's label.
const HIDDEN_TOKEN = 'rvhiddenmatchtoken';
const BAD_TIER = 'legacy-priority-high';
const STALE_KEY = 'zzz-rv-stale-search-key';
const REPAIR_WAIT_MS = 120_000;

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

async function main() {
  const exe = resolveChromium();
  console.log(`[records-vis-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[records-vis-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[records-vis-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[records-vis-browser] dev server ready at ${BASE_URL}`);
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
        `[records-vis-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[records-vis-browser][page-console] ${msg.text()}`);
      }
    });

    // ── 1. Create the vault ─────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000, label: 'records-vis-browser' });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── 2. Seed the three rows via the live Vite CRUD singletons ───────────
    const seed = await page.evaluate(
      async ({ addrHidden, addrTier, addrKey, hiddenToken, badTier, staleKey }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        // Tagged blockchain-discovered row: hidden from the default Records
        // view, but its label matches the search token — the #1 "my old
        // tagged record vanished" scenario the notice exists for.
        const idHidden = await recordCrud.createRecord({
          type: 'address',
          inputString: addrHidden,
          label: `Old tagged counterparty ${hiddenToken}`,
          tags: ['rv-check-tag'],
          addressImportance: 'blockchain-discovered',
        });

        const idTier = await recordCrud.createRecord({
          type: 'address',
          inputString: addrTier,
          label: 'RV tier-corrupt record',
        });
        const idKey = await recordCrud.createRecord({
          type: 'address',
          inputString: addrKey,
          label: 'RV key-corrupt record',
        });

        // Corrupt like restored old-backup rows (direct table writes stand in
        // for the raw restore write path; CRUD would normalize these fields).
        await db.records.update(idTier, {
          addressImportance: badTier,
          inputStringLower: staleKey + '-1',
        });
        await db.records.update(idKey, { inputStringLower: staleKey + '-2' });

        const rHidden = await db.records.get(idHidden);
        const rTier = await db.records.get(idTier);
        const rKey = await db.records.get(idKey);
        return {
          idHidden,
          idTier,
          idKey,
          hiddenTier: rHidden?.addressImportance,
          tierNow: rTier?.addressImportance,
          keyTierNow: rTier?.inputStringLower,
          keyKeyNow: rKey?.inputStringLower,
        };
      },
      {
        addrHidden: ADDR_HIDDEN,
        addrTier: ADDR_TIER,
        addrKey: ADDR_KEY,
        hiddenToken: HIDDEN_TOKEN,
        badTier: BAD_TIER,
        staleKey: STALE_KEY,
      },
    );
    steps.push({
      name: 'seed: hidden-tier tagged row + invalid-tier row + stale-search-key row',
      passed:
        seed.hiddenTier === 'blockchain-discovered' &&
        seed.tierNow === BAD_TIER &&
        seed.keyTierNow === `${STALE_KEY}-1` &&
        seed.keyKeyNow === `${STALE_KEY}-2`,
      detail: JSON.stringify(seed),
    });

    // Sanity: the stale-key rows must be unfindable via the identifier index.
    const preSearch = await page.evaluate(async ({ addrTier, addrKey }) => {
      const { db } = await import('/src/lib/database.ts');
      const a = await db.records.where('inputStringLower').equals(addrTier.toLowerCase()).count();
      const b = await db.records.where('inputStringLower').equals(addrKey.toLowerCase()).count();
      return { a, b };
    }, { addrTier: ADDR_TIER, addrKey: ADDR_KEY });
    steps.push({
      name: 'stale-key rows are unfindable via the search index before repair',
      passed: preSearch.a === 0 && preSearch.b === 0,
      detail: JSON.stringify(preSearch),
    });

    // ── 3. Records page: hidden-matches notice + one-click include ─────────
    await page.goto(`${BASE_URL}records`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000, label: 'records-vis-browser' });
    const searchInput = page.getByTestId('input-search');
    await searchInput.waitFor({ state: 'visible', timeout: 30_000 });
    await searchInput.fill(HIDDEN_TOKEN);

    const notice = page.getByTestId('notice-hidden-matches');
    const noticeVisible = await notice
      .waitFor({ state: 'visible', timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    const noticeText = noticeVisible ? ((await notice.textContent()) ?? '').trim() : '';
    steps.push({
      name: 'search matching only a hidden row shows the "matches are hidden" notice',
      passed: noticeVisible && /1\s*match is\s*hidden/i.test(noticeText.replace(/\s+/g, ' ')),
      detail: noticeVisible ? `notice text: ${JSON.stringify(noticeText)}` : 'notice never appeared',
    });

    // The hidden row itself must NOT be listed yet.
    const hiddenRow = page.getByTestId(`row-record-${seed.idHidden}`);
    const hiddenBefore = await hiddenRow.isVisible().catch(() => false);
    steps.push({
      name: 'hidden row is not listed before clicking the button',
      passed: !hiddenBefore,
      detail: `row-record-${seed.idHidden} visible=${hiddenBefore}`,
    });

    if (noticeVisible) {
      await page.getByTestId('button-show-hidden-matches').click();
      const shown = await hiddenRow
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'one-click "Show hidden matches" reveals the hidden tagged row',
        passed: shown,
        detail: `row-record-${seed.idHidden} visible=${shown}`,
      });
    } else {
      steps.push({
        name: 'one-click "Show hidden matches" reveals the hidden tagged row',
        passed: false,
        detail: 'skipped — notice never appeared',
      });
    }

    // ── 4. Database Doctor: run check, click both repair buttons ───────────
    await page.goto(`${BASE_URL}database-doctor`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000, label: 'records-vis-browser' });
    const runCheckBtn = page.getByTestId('button-run-check');
    await runCheckBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await runCheckBtn.click();
    const repairCard = page.getByTestId('card-repair-tools');
    await repairCard.waitFor({ state: 'visible', timeout: 60_000 });
    steps.push({
      name: 'Database Doctor health check completes and shows the repair tools',
      passed: true,
      detail: 'card-repair-tools visible',
    });

    // "Rebuild search keys" — wait until both stale keys are resynced in the DB.
    const keysBtn = page.getByTestId('button-repair-search-keys');
    await keysBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await keysBtn.click();
    const keysRepaired = await page.evaluate(async ({ idTier, idKey, addrTier, addrKey, timeoutMs }) => {
      const { db } = await import('/src/lib/database.ts');
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const rTier = await db.records.get(idTier);
        const rKey = await db.records.get(idKey);
        if (
          rTier?.inputStringLower === addrTier.toLowerCase() &&
          rKey?.inputStringLower === addrKey.toLowerCase()
        ) {
          return { ok: true, keyTier: rTier?.inputStringLower, keyKey: rKey?.inputStringLower };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const rTier = await db.records.get(idTier);
      const rKey = await db.records.get(idKey);
      return { ok: false, keyTier: rTier?.inputStringLower, keyKey: rKey?.inputStringLower };
    }, { idTier: seed.idTier, idKey: seed.idKey, addrTier: ADDR_TIER, addrKey: ADDR_KEY, timeoutMs: REPAIR_WAIT_MS });
    steps.push({
      name: '"Rebuild search keys" resyncs both stale search keys',
      passed: keysRepaired.ok,
      detail: JSON.stringify(keysRepaired),
    });

    // "Normalize tiers" — wait until the invalid tier is a recognized value
    // and the hidden row's tier is untouched (repairs never re-label rows
    // that already carry a valid tier).
    const tiersBtn = page.getByTestId('button-repair-tiers');
    // The button is disabled while the previous repair/check re-run is going;
    // playwright's click auto-waits for enabled.
    await tiersBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await tiersBtn.click();
    const tiersRepaired = await page.evaluate(async ({ idTier, idHidden, timeoutMs }) => {
      const { db } = await import('/src/lib/database.ts');
      const { isValidImportanceTier } = await import('/src/lib/db-types.ts');
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const rTier = await db.records.get(idTier);
        if (isValidImportanceTier(rTier?.addressImportance)) {
          const rHidden = await db.records.get(idHidden);
          return {
            ok: true,
            tier: rTier?.addressImportance,
            hiddenTier: rHidden?.addressImportance,
          };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const rTier = await db.records.get(idTier);
      return { ok: false, tier: rTier?.addressImportance };
    }, { idTier: seed.idTier, idHidden: seed.idHidden, timeoutMs: REPAIR_WAIT_MS });
    steps.push({
      name: '"Normalize tiers" fixes the invalid tier without touching the valid hidden tier',
      passed: tiersRepaired.ok && tiersRepaired.hiddenTier === 'blockchain-discovered',
      detail: JSON.stringify(tiersRepaired),
    });

    // ── 5. Records search UI now finds both repaired rows ──────────────────
    await page.goto(`${BASE_URL}records`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000, label: 'records-vis-browser' });
    const searchInput2 = page.getByTestId('input-search');
    await searchInput2.waitFor({ state: 'visible', timeout: 30_000 });

    await searchInput2.fill(ADDR_TIER);
    const tierRowFound = await page
      .getByTestId(`row-record-${seed.idTier}`)
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'repaired invalid-tier row is findable via Records search UI',
      passed: tierRowFound,
      detail: `row-record-${seed.idTier} visible=${tierRowFound}`,
    });

    await searchInput2.fill(ADDR_KEY);
    const keyRowFound = await page
      .getByTestId(`row-record-${seed.idKey}`)
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'repaired stale-key row is findable via Records search UI',
      passed: keyRowFound,
      detail: `row-record-${seed.idKey} visible=${keyRowFound}`,
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

  console.log(`[records-vis-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[records-vis-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[records-vis-browser] PASSED: hidden-search-matches notice + one-click include and both Database Doctor repair buttons work end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[records-vis-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
