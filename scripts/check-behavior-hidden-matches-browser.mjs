#!/usr/bin/env node
// Real-browser end-to-end guard for the Records page's behavior-only
// hidden-matches path (Task #1827 follow-up).
//
// jsdom tests pin the behavior-recount effect with a mocked count helper;
// this script proves the full path in headless Chromium against real
// IndexedDB:
//   1. creates a fresh vault
//   2. seeds four address rows:
//        - two HIDDEN (blockchain-discovered tier) rows whose cached stats
//          classify as "dormant" (synced, txs, last activity years ago)
//        - one HIDDEN row that is NOT dormant (never synced → not-enough-data)
//        - one visible curated row that is NOT dormant (control)
//   3. on the Records page, with NO search text and NO column filters,
//      selects only the "Dormant" behavior label
//   4. asserts the "2 matches are hidden among blockchain-discovered records"
//      notice appears (behavior-only narrowing must trigger the count)
//   5. clicks "Show hidden matches" and asserts exactly the two dormant
//      hidden rows render (the non-dormant hidden row stays filtered out)
//
// Everything runs offline against local IndexedDB — no network requests.
// Usage: node scripts/check-behavior-hidden-matches-browser.mjs
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
const SETUP_PASSWORD = 'behavior-hidden-check-123';

// Unique identifiers — first 8 chars differ (testid slicing rule).
const ADDR_DORMANT_1 = 'bc1qbhdorm1000000000001checkaddr';
const ADDR_DORMANT_2 = 'bc1qbhdorm2000000000002checkaddr';
const ADDR_HIDDEN_OTHER = 'bc1qbhother000000000003checkaddr';
const ADDR_VISIBLE = 'bc1qbhvisible0000000004checkaddr';
// Last activity: 2017-01-01 — far beyond the 3-year dormancy threshold.
const DORMANT_LAST_ACTIVITY = 1483228800;

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
  console.log(`[behavior-hidden-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[behavior-hidden-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[behavior-hidden-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[behavior-hidden-browser] dev server ready at ${BASE_URL}`);
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
        `[behavior-hidden-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
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
        console.log(`[behavior-hidden-browser][page-console] ${msg.text()}`);
      }
    });

    // ── 1. Create the vault ─────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000, label: 'behavior-hidden-browser' });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── 2. Seed the four rows via the live Vite CRUD singletons ────────────
    const seed = await page.evaluate(
      async ({ addrD1, addrD2, addrOther, addrVisible, dormantLastActivity }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        // Cached-stat fields that classify as "dormant": synced, has txs,
        // last activity far in the past (behaviorLabelFromCachedStats rule 2).
        const dormantStats = {
          statsComputedAt: Date.now(),
          cachedBalanceSats: 50_000,
          cachedTxCount: 3,
          cachedUtxoCount: 1,
          cachedLastActivityTime: dormantLastActivity,
        };

        const idD1 = await recordCrud.createRecord({
          type: 'address',
          inputString: addrD1,
          label: 'BH dormant hidden 1',
          addressImportance: 'blockchain-discovered',
        });
        const idD2 = await recordCrud.createRecord({
          type: 'address',
          inputString: addrD2,
          label: 'BH dormant hidden 2',
          addressImportance: 'blockchain-discovered',
        });
        // Hidden but NOT dormant: never synced → 'not-enough-data'.
        const idOther = await recordCrud.createRecord({
          type: 'address',
          inputString: addrOther,
          label: 'BH non-dormant hidden',
          addressImportance: 'blockchain-discovered',
        });
        // Visible curated control row, also not dormant.
        const idVisible = await recordCrud.createRecord({
          type: 'address',
          inputString: addrVisible,
          label: 'BH visible control',
        });

        // Stamp cached stats directly (stands in for the stats recompute
        // write path; CRUD create doesn't accept cached-stat fields).
        await db.records.update(idD1, dormantStats);
        await db.records.update(idD2, dormantStats);

        const rD1 = await db.records.get(idD1);
        const rD2 = await db.records.get(idD2);
        const rOther = await db.records.get(idOther);
        const rVisible = await db.records.get(idVisible);
        return {
          idD1,
          idD2,
          idOther,
          idVisible,
          d1Tier: rD1?.addressImportance,
          d2Tier: rD2?.addressImportance,
          otherTier: rOther?.addressImportance,
          visibleTier: rVisible?.addressImportance,
          d1Synced: rD1?.statsComputedAt != null,
          d1LastActivity: rD1?.cachedLastActivityTime,
          otherSynced: rOther?.statsComputedAt != null,
        };
      },
      {
        addrD1: ADDR_DORMANT_1,
        addrD2: ADDR_DORMANT_2,
        addrOther: ADDR_HIDDEN_OTHER,
        addrVisible: ADDR_VISIBLE,
        dormantLastActivity: DORMANT_LAST_ACTIVITY,
      },
    );
    steps.push({
      name: 'seed: 2 hidden dormant rows + 1 hidden non-dormant row + 1 visible control row',
      passed:
        seed.d1Tier === 'blockchain-discovered' &&
        seed.d2Tier === 'blockchain-discovered' &&
        seed.otherTier === 'blockchain-discovered' &&
        seed.visibleTier !== 'blockchain-discovered' &&
        seed.d1Synced === true &&
        seed.d1LastActivity === DORMANT_LAST_ACTIVITY &&
        seed.otherSynced === false,
      detail: JSON.stringify(seed),
    });

    // ── 3. Records page: default view shows only the visible control row ───
    await page.goto(`${BASE_URL}records`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000, label: 'behavior-hidden-browser' });
    const visibleRow = page.getByTestId(`row-record-${seed.idVisible}`);
    await visibleRow.waitFor({ state: 'visible', timeout: 45_000 });
    const d1Before = await page.getByTestId(`row-record-${seed.idD1}`).isVisible().catch(() => false);
    steps.push({
      name: 'default view lists the curated row and hides the discovery-tier rows',
      passed: !d1Before,
      detail: `visible control listed; dormant hidden row visible=${d1Before}`,
    });

    // No hidden-matches notice before any narrowing is applied.
    const noticeBefore = await page
      .getByTestId('notice-hidden-matches')
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'no hidden-matches notice before any filter is applied',
      passed: !noticeBefore,
      detail: `notice visible=${noticeBefore}`,
    });

    // ── 4. Select ONLY the "Dormant" behavior label (no search, no filters) ─
    await page.getByTestId('button-toggle-behavior-filter').click();
    const dormantOption = page.getByTestId('option-behavior-dormant');
    await dormantOption.waitFor({ state: 'visible', timeout: 15_000 });
    // The Radix popover can render outside the headless viewport, which makes
    // a coordinate click retry forever ("element is outside of the viewport").
    // Dispatch the click programmatically on the checkbox instead.
    await page.getByTestId('checkbox-behavior-dormant').dispatchEvent('click');
    // The selected-label chip confirms the toggle actually landed.
    await page.getByTestId('chip-behavior-dormant').waitFor({ state: 'visible', timeout: 15_000 });
    // Close the popover so it can't cover the notice/button.
    await page.keyboard.press('Escape');

    const notice = page.getByTestId('notice-hidden-matches');
    const noticeVisible = await notice
      .waitFor({ state: 'visible', timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    const noticeText = noticeVisible ? ((await notice.textContent()) ?? '').trim() : '';
    steps.push({
      name: 'behavior-only filter surfaces the "2 matches are hidden" notice',
      passed:
        noticeVisible &&
        /2\s*matches are\s*hidden\s*among blockchain-discovered records/i.test(
          noticeText.replace(/\s+/g, ' '),
        ),
      detail: noticeVisible ? `notice text: ${JSON.stringify(noticeText)}` : 'notice never appeared',
    });

    // The dormant hidden rows must NOT be listed yet.
    const d1Listed = await page.getByTestId(`row-record-${seed.idD1}`).isVisible().catch(() => false);
    const d2Listed = await page.getByTestId(`row-record-${seed.idD2}`).isVisible().catch(() => false);
    steps.push({
      name: 'hidden dormant rows are not listed before clicking the button',
      passed: !d1Listed && !d2Listed,
      detail: `d1 visible=${d1Listed} d2 visible=${d2Listed}`,
    });

    // ── 5. One-click reveal: both dormant rows appear, non-dormant ones don't
    if (noticeVisible) {
      await page.getByTestId('button-show-hidden-matches').click();
      const d1Shown = await page
        .getByTestId(`row-record-${seed.idD1}`)
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      const d2Shown = await page
        .getByTestId(`row-record-${seed.idD2}`)
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      const otherShown = await page
        .getByTestId(`row-record-${seed.idOther}`)
        .isVisible()
        .catch(() => false);
      const visibleShown = await page
        .getByTestId(`row-record-${seed.idVisible}`)
        .isVisible()
        .catch(() => false);
      steps.push({
        name: '"Show hidden matches" reveals exactly the two dormant hidden rows',
        passed: d1Shown && d2Shown && !otherShown && !visibleShown,
        detail: `d1=${d1Shown} d2=${d2Shown} nonDormantHidden=${otherShown} nonDormantVisible=${visibleShown}`,
      });
    } else {
      steps.push({
        name: '"Show hidden matches" reveals exactly the two dormant hidden rows',
        passed: false,
        detail: 'skipped — notice never appeared',
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

  console.log(`[behavior-hidden-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[behavior-hidden-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[behavior-hidden-browser] PASSED: a behavior-only filter surfaces the bounded hidden-match notice and the one-click reveal shows exactly the matching hidden rows in a real browser.',
  );
}

main().catch((err) => {
  console.error('[behavior-hidden-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
