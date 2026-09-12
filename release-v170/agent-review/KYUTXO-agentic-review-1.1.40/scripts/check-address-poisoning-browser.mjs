#!/usr/bin/env node
// Real-browser regression guard for the Address Poisoning page
// (/address-poisoning): the scan flow, the virtualized results table, the
// prefix/suffix highlight marks, and the tag-application flow against a live
// Dexie instance.
//
// The jsdom unit tests (client/src/lib/address-poisoning.test.ts,
// client/src/pages/AddressPoisoning.test.tsx) mock the virtualizer and the
// scan seams, so they cannot catch: the @tanstack/react-virtual rows failing
// to render in a real layout, the <mark> highlight runs regressing, or the
// tag write not round-tripping through the live useLiveQuery record lookup.
// This script drives a REAL headless Chromium against the running dev server:
//
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds, via the LIVE Vite module singletons (record-crud /
//      transaction-crud), a poisoning-shaped fixture: one owned victim
//      address, one dust-sized (800 sat) inbound output to it, and two input
//      counterparties on that tx — a same-family lookalike suspect (shares 10
//      leading + 4 trailing chars with the victim) and a different-family
//      decoy that must NOT match
//   3. navigates to /address-poisoning, clicks Scan, and asserts the summary
//      banner reports exactly 1 high-confidence suspect targeting 1 address
//   4. asserts the virtualized group + suspect rows render, the highlight
//      marks contain the exact shared leading/trailing runs, and the
//      confidence/heuristic badges are correct (unknown-sender +
//      one-time-counterparty => high)
//   5. asserts the decoy address appears nowhere in the results
//   6. clicks "Tag suspect" and verifies the suspected-poisoning tag badge
//      appears on the row and the button flips to "Tagged" (live Dexie
//      round-trip: applyPoisoningTags creates the record, useLiveQuery
//      refreshes the row)
//   7. clicks "Tag target" and verifies the poisoning-target badge appears on
//      the group header
//   8. seeds a SECOND fixture wave — two more victim addresses with three
//      lookalike suspects between them — re-runs the scan, and exercises the
//      bulk banner buttons: "Tag all suspects (3)" must tag every untagged
//      suspect row (badge appears on each, Dexie records round-trip, count
//      drops to 0 and the button disables), then "Tag all targets (2)" must
//      badge both remaining group headers and drop its count to 0
//
// NOTE for reviewers: the route /address-poisoning maps to
// client/src/pages/AddressPoisoning.tsx (see client/src/App.tsx), and the
// scan logic lives in client/src/lib/address-poisoning.ts.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-address-poisoning-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}address-poisoning`;
const SETUP_PASSWORD = 'address-poisoning-check-123';

// Fake-but-plausible identifiers: the scanner matches addresses by string
// equality only (no checksum validation on this path). The suspect shares the
// first 10 and last 4 characters with the victim (same bc1q family), so with
// the default Match >= 4 it is a lookalike. The decoy is a different script
// family (legacy '1…'), so it must never match.
const VICTIM_ADDR = 'bc1qpoisonvictimxxxxxxxxxxxxxxxxxxxxwxyz';
const SUSPECT_ADDR = 'bc1qpoisonlookalikeyyyyyyyyyyyyyyyyywxyz';
const DECOY_ADDR = '1DecoyLegacyCounterpartyZZZZZZZZZZ';
const SHARED_LEADING = 'bc1qpoison'; // 10 chars
const SHARED_TRAILING = 'wxyz'; // 4 chars
const DUST_TXID = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
const DUST_VOUT = 1;
const DUST_SATS = 800; // <= default 1000-sat dust threshold
const SUSPECT_TAG = 'suspected-poisoning'; // page default suspect tag
const TARGET_TAG = 'poisoning-target'; // page default target tag

// ── Second fixture wave for the bulk "Tag all" buttons ──────────────────────
// A lookalike match requires BOTH a shared leading run and a shared trailing
// run of >= matchLength (default 4). Every address below shares the 'bc1q'
// prefix (4 chars) with everything else, but the trailing 4 chars are unique
// per victim/suspect pair, so each suspect matches exactly its own victim and
// nothing cross-matches (incl. the first wave's 'wxyz' suffix).
const VICTIM2_ADDR = 'bc1qsecondvictimaaaaaaaaaaaaaaaaaaaaqrst';
const SUSPECT2A_ADDR = 'bc1qsecondvictlookalikeoneaaaaaaaaaaqrst';
const SUSPECT2B_ADDR = 'bc1qsecondviclookaliketwoaaaaaaaaaaaqrst';
const VICTIM3_ADDR = 'bc1qthirdvictimbbbbbbbbbbbbbbbbbbbbbmnop';
const SUSPECT3_ADDR = 'bc1qthirdvictlookalikeccccccccccccccmnop';
const DUST_TXID_2 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DUST_TXID_3 = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

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

/** chromium.launch can EAGAIN under parallel validation load — retry. */
async function launchWithRetry(exe, attempts = 3) {
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
      console.log(`[address-poisoning-browser] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[address-poisoning-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[address-poisoning-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[address-poisoning-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[address-poisoning-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => first load shows the vault setup
    // form. Block the PWA service worker so it cannot serve a stale bundle or
    // reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (msg.type() === 'error' || t.toLowerCase().includes('buffer is not defined')) {
        console.log(`[address-poisoning-browser][page-console] ${t}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    // Retry the first goto: under parallel validation load the dev server can
    // be slow to compile the initial bundle.
    let landed = false;
    for (let i = 0; i < 3 && !landed; i++) {
      landed = await page
        .goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!landed) await page.waitForTimeout(3000);
    }
    if (!landed) throw new Error(`Could not load ${PAGE_URL}`);
    await unlockIfNeeded(page, SETUP_PASSWORD);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed the poisoning-shaped fixture via the LIVE Vite singletons ──────
    // Same module URLs the app imported => same Dexie instance, so the scan
    // (which reads on click, not mount) sees the rows without a reload.
    const seed = await page.evaluate(
      async ({ victim, suspect, decoy, txid, vout, sats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: victim,
          label: 'Poisoning victim address',
        });
        const blockTime = Math.floor(Date.now() / 1000) - 86400;
        await txCrud.addTransaction({
          txid,
          blockHeight: 800000,
          blockTime,
          fee: 210,
          feeRate: 1,
          syncedAt: Date.now(),
        });
        // Dust-sized inbound output to the victim.
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: victim,
          amount: sats,
          vout,
          recordId,
        });
        // The lookalike suspect funds the tx (counterparty, no vault record).
        await txCrud.addParticipant({
          txid,
          role: 'input',
          address: suspect,
          amount: 5000,
          vout: 0,
        });
        // Different-family decoy counterparty — must never match.
        await txCrud.addParticipant({
          txid,
          role: 'input',
          address: decoy,
          amount: 3000,
          vout: 1,
        });
        return { recordId };
      },
      { victim: VICTIM_ADDR, suspect: SUSPECT_ADDR, decoy: DECOY_ADDR, txid: DUST_TXID, vout: DUST_VOUT, sats: DUST_SATS },
    );
    steps.push({
      name: 'seeded victim record + dust tx with lookalike and decoy counterparties',
      passed: Number.isInteger(seed.recordId) && seed.recordId > 0,
      detail: `recordId=${seed.recordId}, dust ${DUST_SATS} sats at ${DUST_TXID.slice(0, 12)}…:${DUST_VOUT}`,
    });

    // ── Run the scan ─────────────────────────────────────────────────────────
    const runBtn = page.getByTestId('button-run-scan');
    await runBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await runBtn.click();

    const summaryBanner = page.getByTestId('banner-summary');
    await summaryBanner.waitFor({ state: 'visible', timeout: 60_000 });
    const summaryText = ((await page.getByTestId('text-summary').textContent()) ?? '').replace(/\s+/g, ' ').trim();
    steps.push({
      name: 'scan completes and summary reports 1 high-confidence suspect targeting 1 address',
      passed:
        summaryText.includes('1 suspect address') &&
        summaryText.includes('targeting 1 of your address') &&
        summaryText.includes('1 high-confidence'),
      detail: `summary = ${JSON.stringify(summaryText)}`,
    });

    // ── Virtualized rows: group header + suspect row ─────────────────────────
    const groupRow = page.getByTestId(`group-${VICTIM_ADDR}`);
    const suspectRow = page.getByTestId(`row-suspect-${SUSPECT_ADDR}`);
    const groupVisible = await groupRow.isVisible().catch(() => false);
    const suspectVisible = await suspectRow.isVisible().catch(() => false);
    steps.push({
      name: 'virtualized results render the target group header and the suspect row',
      passed: groupVisible && suspectVisible,
      detail: `group visible=${groupVisible}, suspect row visible=${suspectVisible}`,
    });

    // ── Highlight marks: exact shared leading/trailing runs ──────────────────
    const highlight = await page.evaluate((suspect) => {
      const el = document.querySelector(`[data-testid="highlight-${suspect}"]`);
      if (!el) return null;
      const marks = Array.from(el.querySelectorAll('mark')).map((m) => m.textContent);
      return { marks, full: el.textContent };
    }, SUSPECT_ADDR);
    steps.push({
      name: 'highlight marks contain the exact shared leading/trailing runs',
      passed:
        !!highlight &&
        highlight.marks.length === 2 &&
        highlight.marks[0] === SHARED_LEADING &&
        highlight.marks[1] === SHARED_TRAILING &&
        highlight.full === SUSPECT_ADDR,
      detail: highlight
        ? `marks=[${highlight.marks.join(' | ')}], full=${highlight.full}`
        : 'highlight element not found',
    });

    // ── Confidence + heuristic badges ────────────────────────────────────────
    const confidence = ((await page.getByTestId(`badge-confidence-${SUSPECT_ADDR}`).textContent().catch(() => '')) ?? '').trim();
    const heuristicBadges = await Promise.all(
      ['dust-sized', 'lookalike', 'unknown-sender', 'one-time-counterparty'].map((h) =>
        page
          .getByTestId(`badge-heuristic-${SUSPECT_ADDR}-${h}`)
          .isVisible()
          .catch(() => false),
      ),
    );
    steps.push({
      name: 'suspect row shows high confidence with all four heuristic badges',
      passed: confidence === 'high' && heuristicBadges.every(Boolean),
      detail: `confidence=${JSON.stringify(confidence)}, heuristics visible=[${heuristicBadges.join(', ')}]`,
    });

    // ── Decoy must not appear anywhere in the results ────────────────────────
    const decoyCount = await page.locator(`[data-testid="row-suspect-${DECOY_ADDR}"]`).count();
    const decoyInDom = await page.evaluate((decoy) => document.body.innerText.includes(decoy), DECOY_ADDR);
    steps.push({
      name: 'different-family decoy counterparty is not reported as a suspect',
      passed: decoyCount === 0 && !decoyInDom,
      detail: `decoy suspect rows=${decoyCount}, decoy address anywhere in page=${decoyInDom}`,
    });

    // ── Tag the suspect and verify the tag badge appears ─────────────────────
    const tagSuspectBtn = page.getByTestId(`button-tag-suspect-${SUSPECT_ADDR}`);
    await tagSuspectBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await tagSuspectBtn.click();

    const suspectTagBadge = page.getByTestId(`badge-tag-${SUSPECT_ADDR}-${SUSPECT_TAG}`);
    const suspectBadgeAppeared = await suspectTagBadge
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const tagSuspectLabel = ((await tagSuspectBtn.textContent().catch(() => '')) ?? '').trim();
    const tagSuspectDisabled = await tagSuspectBtn.isDisabled().catch(() => false);
    steps.push({
      name: 'Tag suspect applies the tag: badge appears and button flips to disabled "Tagged"',
      passed: suspectBadgeAppeared && tagSuspectLabel === 'Tagged' && tagSuspectDisabled,
      detail: `badge=${suspectBadgeAppeared}, button=${JSON.stringify(tagSuspectLabel)}, disabled=${tagSuspectDisabled}`,
    });

    // Verify the tag write actually landed in Dexie (created a record for the
    // previously-unknown suspect address with the tag attached).
    const dbTag = await page.evaluate(
      async ({ suspect, tag }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const recs = await recordCrud.getRecordsByInputStrings([suspect]);
        return recs.length === 1 && Array.isArray(recs[0].tags) && recs[0].tags.includes(tag);
      },
      { suspect: SUSPECT_ADDR, tag: SUSPECT_TAG },
    );
    steps.push({
      name: 'suspect record round-trips in Dexie with the suspected-poisoning tag',
      passed: dbTag === true,
      detail: `record with tag present=${dbTag}`,
    });

    // ── Tag the target and verify the group-header badge appears ────────────
    const tagTargetBtn = page.getByTestId(`button-tag-target-${SUSPECT_ADDR}`);
    await tagTargetBtn.click();
    const targetTagBadge = page.getByTestId(`badge-target-tag-${VICTIM_ADDR}-${TARGET_TAG}`);
    const targetBadgeAppeared = await targetTagBadge
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'Tag target applies the tag: poisoning-target badge appears on the group header',
      passed: targetBadgeAppeared,
      detail: `target badge visible=${targetBadgeAppeared}`,
    });

    // ── Bulk "Tag all" buttons: seed a second wave and re-scan ──────────────
    // Two more victims with three lookalike suspects between them. The first
    // wave's suspect/target are already tagged, so after the re-scan the bulk
    // buttons must count exactly the 3 new suspects / 2 new targets.
    await page.evaluate(
      async ({ fixtures }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const blockTime = Math.floor(Date.now() / 1000) - 86400;
        for (const f of fixtures) {
          const recordId = await recordCrud.createRecord({
            type: 'address',
            inputString: f.victim,
            label: f.label,
          });
          await txCrud.addTransaction({
            txid: f.txid,
            blockHeight: 800001,
            blockTime,
            fee: 210,
            feeRate: 1,
            syncedAt: Date.now(),
          });
          await txCrud.addParticipant({
            txid: f.txid,
            role: 'output',
            address: f.victim,
            amount: 800,
            vout: 1,
            recordId,
          });
          let vin = 0;
          for (const suspect of f.suspects) {
            await txCrud.addParticipant({
              txid: f.txid,
              role: 'input',
              address: suspect,
              amount: 5000,
              vout: vin++,
            });
          }
        }
      },
      {
        fixtures: [
          {
            victim: VICTIM2_ADDR,
            label: 'Second poisoning victim',
            txid: DUST_TXID_2,
            suspects: [SUSPECT2A_ADDR, SUSPECT2B_ADDR],
          },
          {
            victim: VICTIM3_ADDR,
            label: 'Third poisoning victim',
            txid: DUST_TXID_3,
            suspects: [SUSPECT3_ADDR],
          },
        ],
      },
    );

    await runBtn.click();
    const tagAllSuspectsBtn = page.getByTestId('button-tag-all-suspects');
    const tagAllTargetsBtn = page.getByTestId('button-tag-all-targets');
    const suspectsCountReady = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="button-tag-all-suspects"]');
          return !!el && /\(3\)/.test(el.textContent ?? '');
        },
        undefined,
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    const tagAllSuspectsLabel = ((await tagAllSuspectsBtn.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    const tagAllTargetsLabel = ((await tagAllTargetsBtn.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    steps.push({
      name: 're-scan counts exactly the 3 new untagged suspects and 2 new untagged targets',
      passed: suspectsCountReady && /\(2\)/.test(tagAllTargetsLabel),
      detail: `suspects button=${JSON.stringify(tagAllSuspectsLabel)}, targets button=${JSON.stringify(tagAllTargetsLabel)}`,
    });

    // ── Tag all suspects: every new suspect row gains the badge ─────────────
    await tagAllSuspectsBtn.click();
    const newSuspects = [SUSPECT2A_ADDR, SUSPECT2B_ADDR, SUSPECT3_ADDR];
    const suspectBadgeResults = [];
    for (const addr of newSuspects) {
      const row = page.getByTestId(`row-suspect-${addr}`);
      await row.scrollIntoViewIfNeeded().catch(() => {});
      const badgeVisible = await page
        .getByTestId(`badge-tag-${addr}-${SUSPECT_TAG}`)
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      suspectBadgeResults.push(badgeVisible);
    }
    steps.push({
      name: 'Tag all suspects: every suspect row across both targets gains the tag badge',
      passed: suspectBadgeResults.every(Boolean),
      detail: `badges visible=[${suspectBadgeResults.join(', ')}] for [${newSuspects.map((a) => a.slice(0, 14) + '…').join(', ')}]`,
    });

    const bulkDbTags = await page.evaluate(
      async ({ suspects, tag }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const recs = await recordCrud.getRecordsByInputStrings(suspects);
        const byAddr = new Map(recs.map((r) => [r.inputString, r]));
        return suspects.map((s) => {
          const r = byAddr.get(s);
          return !!r && Array.isArray(r.tags) && r.tags.includes(tag);
        });
      },
      { suspects: newSuspects, tag: SUSPECT_TAG },
    );
    steps.push({
      name: 'all bulk-tagged suspects round-trip in Dexie with the suspected-poisoning tag',
      passed: Array.isArray(bulkDbTags) && bulkDbTags.length === 3 && bulkDbTags.every(Boolean),
      detail: `db tag presence=[${bulkDbTags.join(', ')}]`,
    });

    const suspectsCountZero = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="button-tag-all-suspects"]');
          return !!el && /\(0\)/.test(el.textContent ?? '');
        },
        undefined,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    const tagAllSuspectsDisabled = await tagAllSuspectsBtn.isDisabled().catch(() => false);
    steps.push({
      name: 'Tag all suspects count drops to 0 and the button disables',
      passed: suspectsCountZero && tagAllSuspectsDisabled,
      detail: `count=0 reached=${suspectsCountZero}, disabled=${tagAllSuspectsDisabled}`,
    });

    // ── Tag all targets: both new group headers gain the badge ──────────────
    await tagAllTargetsBtn.click();
    const newTargets = [VICTIM2_ADDR, VICTIM3_ADDR];
    const targetBadgeResults = [];
    for (const addr of newTargets) {
      const group = page.getByTestId(`group-${addr}`);
      await group.scrollIntoViewIfNeeded().catch(() => {});
      const badgeVisible = await page
        .getByTestId(`badge-target-tag-${addr}-${TARGET_TAG}`)
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      targetBadgeResults.push(badgeVisible);
    }
    steps.push({
      name: 'Tag all targets: both remaining group headers gain the poisoning-target badge',
      passed: targetBadgeResults.every(Boolean),
      detail: `badges visible=[${targetBadgeResults.join(', ')}]`,
    });

    const targetsCountZero = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="button-tag-all-targets"]');
          return !!el && /\(0\)/.test(el.textContent ?? '');
        },
        undefined,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    const tagAllTargetsDisabled = await tagAllTargetsBtn.isDisabled().catch(() => false);
    steps.push({
      name: 'Tag all targets count drops to 0 and the button disables',
      passed: targetsCountZero && tagAllTargetsDisabled,
      detail: `count=0 reached=${targetsCountZero}, disabled=${tagAllTargetsDisabled}`,
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

  console.log(`[address-poisoning-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[address-poisoning-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[address-poisoning-browser] PASSED: Address Poisoning scan, virtualized results, highlight marks, and suspect/target tagging all work end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[address-poisoning-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
