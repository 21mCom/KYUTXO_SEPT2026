#!/usr/bin/env node
// Real-browser regression guard for the Privacy Audit **Adversary View** panel.
//
// The adversary view fires asynchronously AFTER the main privacy audit
// completes (`runAdversaryView` in PrivacyAudit.tsx) and renders a collapsible
// panel with a loading status, four summary stats, and per-category badges.
// The unit tests (`adversary-view.test.ts`) cover the engine with a synthetic
// context, but nothing proves the real page wiring: that the panel actually
// mounts after an audit, that the transient loading status is shown while the
// analysis runs, and that the header badges agree with the summary stats and
// section counts the engine produced.
//
// This script drives the actual page in a headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons — same
//      module graph the app uses) two owned address records that co-spend as
//      inputs in one confirmed transaction with two external outputs (ONE
//      exposure finding covering TWO owned addresses), plus a third owned
//      RECEIVE address (chainType ground truth) that is the smaller output of
//      a second tx — the adversary's amount + script-type change heuristics
//      both point at it, yielding ONE protective-confusion finding at the
//      "certain" tier. All bc1q seeds are 42 chars and the bc1p seed 62 chars
//      so getScriptType classifies them (short fake strings → "unknown" →
//      the script-type heuristic silently stops firing).
//   3. Installs a MutationObserver BEFORE clicking "Run Audit" so the
//      transient `text-adversary-status` loading message is captured even if
//      the analysis finishes in milliseconds.
//   4. Runs the audit and asserts:
//        - `container-adversary-view` appears
//        - the loading status message was observed during analysis
//        - the summary stats are exactly what the seed predicts
//          (2 exposed / 0 separated / 1 confusion / 0 context merges)
//        - the header exposure badge ("1 exposure") matches the section
//          badge count, and no separation/context badges render
//        - the confusion finding's confidence tier is "certain" — proving the
//          script-type change heuristic fired on the real-length (42-char
//          bc1q / 62-char bc1p) seed addresses, not just the amount heuristic
//        - the partial-chaintype degradation banner is shown (1 of 3 records
//          has chainType)
//   5. RELOADS the page, unlocks the vault again, and asserts the persisted
//      session (privacy-audit-session-store, its own IndexedDB DB) rehydrates
//      both the main audit result and the adversary panel WITHOUT clicking
//      "Run Audit": the score summary and adversary stats match the pre-reload
//      values and the "restored from your last run" banner is shown.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-adversary-view-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const AUDIT_URL = `${BASE_URL}privacy-audit`;
const SETUP_PASSWORD = 'adversary-view-check-123';

// Two owned addresses that co-spend. The engines match addresses by string
// equality, BUT getScriptType (adversary-view.ts) now returns "unknown" for
// bech32-like strings with unrealistic lengths — so every seeded bc1q address
// must be exactly 42 chars (P2WPKH) and bc1p addresses 62 chars (P2TR), or
// the script-type change heuristic silently stops contributing to confidence
// tiers. First-8-chars differ so testids never collide.
const ADDR_OWNED_A = 'bc1qadvexpo0' + 'a'.repeat(30); // 42-char P2WPKH
const ADDR_OWNED_B = 'bc1qadvexpo1' + 'b'.repeat(30); // 42-char P2WPKH
// External (non-owned) payment + change outputs of the co-spend tx.
const ADDR_EXT_PAY = 'bc1qextpay00' + 'c'.repeat(30); // 42-char P2WPKH
const ADDR_EXT_CHG = 'bc1qextchg00' + 'd'.repeat(30); // 42-char P2WPKH
const COSPEND_TXID = 'adv0'.repeat(16); // 64 hex-ish chars

// Confusion seed: a second tx whose 2 outputs are one owned RECEIVE address
// (smaller amount => the adversary's amount heuristic guesses it is change —
// wrong, per our chainType ground truth) and one external P2TR payment. The
// external input and the owned output are both P2WPKH while the other output
// is P2TR, so the script-type-consistency heuristic AGREES with the amount
// heuristic and the finding must land in the "certain" confidence tier. This
// only works when the addresses are real-length; with short fake strings
// getScriptType returns "unknown" and the tier degrades to "likely".
const ADDR_OWNED_RCV = 'bc1qconfuse0' + 'e'.repeat(30); // 42-char P2WPKH, chainType: receive
const ADDR_EXT_INP = 'bc1qextinp00' + 'f'.repeat(30); // 42-char P2WPKH external input
const ADDR_EXT_TR_PAY = 'bc1pextpay00' + 'g'.repeat(50); // 62-char P2TR external payment
const CONFUSION_TXID = 'adv1'.repeat(16); // 64 hex-ish chars

// Guard the guard: fail fast if anyone edits a seed address back to a length
// getScriptType would reject as "unknown".
for (const [name, addr, len] of [
  ['ADDR_OWNED_A', ADDR_OWNED_A, 42],
  ['ADDR_OWNED_B', ADDR_OWNED_B, 42],
  ['ADDR_EXT_PAY', ADDR_EXT_PAY, 42],
  ['ADDR_EXT_CHG', ADDR_EXT_CHG, 42],
  ['ADDR_OWNED_RCV', ADDR_OWNED_RCV, 42],
  ['ADDR_EXT_INP', ADDR_EXT_INP, 42],
  ['ADDR_EXT_TR_PAY', ADDR_EXT_TR_PAY, 62],
]) {
  if (addr.length !== len) {
    throw new Error(`${name} must be ${len} chars (got ${addr.length}) or getScriptType returns "unknown"`);
  }
}

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
  console.log(`[adversary-view-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[adversary-view-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[adversary-view-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[adversary-view-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    // Fresh context => empty IndexedDB => the login screen shows the "Create
    // Vault" setup form. Block the PWA service worker so it cannot reload the
    // page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[adversary-view-browser][page-console] ${t}`);
      }
    });

    await page.goto(AUDIT_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // ── Wait for the Privacy Audit page to render ──────────────────────────
    const runBtn = page.getByTestId('button-run-audit');
    await runBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed: two owned address records + one co-spend transaction ─────────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // modules write to the exact same Dexie instance the page reads.
    const seedResult = await page.evaluate(
      async ({ ownedA, ownedB, extPay, extChg, txid, ownedRcv, extInp, extTrPay, confusionTxid }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        for (const addr of [ownedA, ownedB]) {
          await recordCrud.createRecord({
            type: 'address',
            inputString: addr,
            label: `Adversary check ${addr.slice(0, 12)}`,
          });
        }
        // Owned RECEIVE address (chainType ground truth) — the confusion-tx
        // change-guess target.
        await recordCrud.createRecord({
          type: 'address',
          inputString: ownedRcv,
          label: `Adversary check ${ownedRcv.slice(0, 12)}`,
          chainType: 'receive',
        });

        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({
          txid,
          blockHeight: 800_000,
          blockTime: now - 3600,
          fee: 1000,
          feeRate: 5,
          syncedAt: Date.now(),
        });
        // Both owned addresses co-spend as inputs => one CIO exposure cluster.
        await txCrud.addParticipant({ txid, role: 'input', address: ownedA, amount: 60_000, vout: 0 });
        await txCrud.addParticipant({ txid, role: 'input', address: ownedB, amount: 40_000, vout: 1 });
        // Two external outputs (payment + smaller change-guess target). The
        // change-guess links an EXTERNAL address, so exposure stays exactly 1
        // finding / 2 owned addresses and confusion stays 0 (no owned output).
        await txCrud.addParticipant({ txid, role: 'output', address: extPay, amount: 90_000, vout: 0 });
        await txCrud.addParticipant({ txid, role: 'output', address: extChg, amount: 9_000, vout: 1 });

        // Confusion tx: EXTERNAL P2WPKH input, owned P2WPKH receive output as
        // the SMALLER of two outputs (amount heuristic guesses it is change),
        // external P2TR payment output. Script-type heuristic: majority input
        // type p2wpkh, exactly one output matches → agrees with the amount
        // guess → confidence "certain". Ground truth says receive → one
        // protective-confusion finding. The single external input keeps the
        // exposure cluster untouched (no owned address is linked in).
        await txCrud.addTransaction({
          txid: confusionTxid,
          blockHeight: 800_010,
          blockTime: now - 1800,
          fee: 800,
          feeRate: 4,
          syncedAt: Date.now(),
        });
        await txCrud.addParticipant({ txid: confusionTxid, role: 'input', address: extInp, amount: 70_000, vout: 0 });
        await txCrud.addParticipant({ txid: confusionTxid, role: 'output', address: extTrPay, amount: 60_000, vout: 0 });
        await txCrud.addParticipant({ txid: confusionTxid, role: 'output', address: ownedRcv, amount: 9_000, vout: 1 });
        return true;
      },
      {
        ownedA: ADDR_OWNED_A,
        ownedB: ADDR_OWNED_B,
        extPay: ADDR_EXT_PAY,
        extChg: ADDR_EXT_CHG,
        txid: COSPEND_TXID,
        ownedRcv: ADDR_OWNED_RCV,
        extInp: ADDR_EXT_INP,
        extTrPay: ADDR_EXT_TR_PAY,
        confusionTxid: CONFUSION_TXID,
      },
    );
    steps.push({
      name: 'seed: 3 owned address records + co-spend tx + confusion tx written to vault',
      passed: seedResult === true,
      detail: `seeded ${ADDR_OWNED_A.slice(0, 14)}… and ${ADDR_OWNED_B.slice(0, 14)}… co-spending in ${COSPEND_TXID.slice(0, 8)}…, plus receive addr ${ADDR_OWNED_RCV.slice(0, 14)}… in confusion tx ${CONFUSION_TXID.slice(0, 8)}…`,
    });

    // ── Install a watcher for the TRANSIENT adversary loading status BEFORE
    // clicking Run. The analysis on this tiny seed can finish in a few ms, so
    // polling from Node would race it; a MutationObserver inside the page
    // catches even a single-frame appearance of `text-adversary-status` (the
    // in-panel loading message) or the header spinner label.
    await page.evaluate(() => {
      window.__advLoadingSeen = { status: false, statusText: '' };
      const check = () => {
        const el = document.querySelector('[data-testid="text-adversary-status"]');
        if (el) {
          window.__advLoadingSeen.status = true;
          if (el.textContent) window.__advLoadingSeen.statusText = el.textContent;
        }
      };
      check();
      const obs = new MutationObserver(check);
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__advLoadingObserver = obs;
    });

    // ── Run the audit ───────────────────────────────────────────────────────
    await runBtn.click();

    // The adversary panel mounts as soon as adversaryRunning flips true (right
    // after the main audit finishes).
    const panel = page.locator('[data-testid="container-adversary-view"]');
    await panel.waitFor({ state: 'visible', timeout: 60_000 });
    steps.push({
      name: 'panel: container-adversary-view appears after the audit',
      passed: true,
      detail: 'container-adversary-view became visible',
    });

    // Analysis complete once the header exposure badge renders (it is only
    // rendered when `result && !running`).
    const exposureBadge = page.getByTestId('badge-adversary-exposure-count');
    await exposureBadge.waitFor({ state: 'visible', timeout: 60_000 });

    // ── Loading status was observed during the analysis ─────────────────────
    {
      const seen = await page.evaluate(() => window.__advLoadingSeen);
      steps.push({
        name: 'loading: adversary status message appeared during analysis',
        passed: seen && seen.status === true,
        detail: seen && seen.status
          ? `text-adversary-status was shown (last text: ${JSON.stringify(seen.statusText).slice(0, 120)})`
          : 'text-adversary-status never appeared while the analysis ran',
      });
      await page.evaluate(() => window.__advLoadingObserver?.disconnect());
    }

    // ── Summary stats match the seeded ground truth exactly ─────────────────
    const statText = async (id) =>
      (await page.getByTestId(id).textContent())?.trim() ?? '';

    const statExposure = await statText('text-adversary-stat-exposure');
    const statSeparated = await statText('text-adversary-stat-separated');
    const statConfusion = await statText('text-adversary-stat-confusion');
    const statContext = await statText('text-adversary-stat-context');

    steps.push({
      name: 'stats: Addresses Exposed is non-zero and correct (2)',
      passed: statExposure === '2',
      detail: `text-adversary-stat-exposure = ${JSON.stringify(statExposure)} (expected "2")`,
    });
    steps.push({
      name: 'stats: confusion is 1 (script-type + amount heuristics fired), separated/context are 0',
      passed: statSeparated === '0' && statConfusion === '1' && statContext === '0',
      detail: `separated=${statSeparated} confusion=${statConfusion} context=${statContext} (expected 0/1/0)`,
    });

    // ── Header badge counts match the summary/section counts ────────────────
    {
      const badgeText = ((await exposureBadge.textContent()) ?? '').trim();
      const badgeNum = badgeText.match(/\d+/)?.[0] ?? '';
      steps.push({
        name: 'badges: header exposure badge shows "1 exposure"',
        passed: badgeNum === '1' && /exposure/.test(badgeText),
        detail: `badge-adversary-exposure-count = ${JSON.stringify(badgeText)} (expected count 1)`,
      });

      const sectionBadge = ((await page
        .getByTestId('badge-section-exposure-count')
        .textContent()) ?? '').trim();
      steps.push({
        name: 'badges: exposure section badge count matches the header badge',
        passed: sectionBadge === badgeNum,
        detail: `badge-section-exposure-count = ${JSON.stringify(sectionBadge)} vs header ${JSON.stringify(badgeNum)}`,
      });

      const separationBadges = await page
        .locator('[data-testid="badge-adversary-separation-count"]')
        .count();
      const contextBadges = await page
        .locator('[data-testid="badge-adversary-context-merge-count"]')
        .count();
      steps.push({
        name: 'badges: no separation/context-merge badges render (counts are 0)',
        passed: separationBadges === 0 && contextBadges === 0,
        detail: `separation=${separationBadges} context=${contextBadges} (expected 0/0)`,
      });

      const confusionBadgeText = ((await page
        .getByTestId('badge-adversary-confusion-count')
        .textContent()
        .catch(() => '')) ?? '').trim();
      steps.push({
        name: 'badges: header confusion badge shows "1 confusion"',
        passed: /1/.test(confusionBadgeText) && /confusion/.test(confusionBadgeText),
        detail: `badge-adversary-confusion-count = ${JSON.stringify(confusionBadgeText)} (expected count 1)`,
      });
    }

    // ── Exposure finding row is actually listed in the section ──────────────
    {
      const exposureRows = await page
        .locator('[data-testid="trigger-adversary-section-exposure"]')
        .count();
      steps.push({
        name: 'section: the Exposure section is rendered',
        passed: exposureRows === 1,
        detail: `found ${exposureRows} exposure section trigger(s) (expected 1)`,
      });
    }

    // ── Confusion finding: script-type-driven "certain" confidence tier ─────
    // The confusion section is collapsed by default: open it, then read the
    // confidence badge inside the protective-confusion finding card. With
    // real-length addresses, the script-type heuristic (p2wpkh inputs, exactly
    // one p2wpkh output) agrees with the amount guess → "certain". If the seed
    // addresses regress to lengths getScriptType rejects, the heuristic gives
    // no signal and the tier silently degrades to "likely" — this catches it.
    {
      const confusionTrigger = page.getByTestId('trigger-adversary-section-confusion');
      const triggerVisible = await confusionTrigger
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'section: the Protective Confusion section is rendered',
        passed: triggerVisible,
        detail: triggerVisible
          ? 'trigger-adversary-section-confusion is visible'
          : 'trigger-adversary-section-confusion missing',
      });

      let confidenceText = '';
      if (triggerVisible) {
        await confusionTrigger.click();
        const confidenceBadge = page.locator(
          '[data-testid="card-adversary-finding-protective-confusion"] [data-testid="badge-adversary-confidence"]',
        );
        confidenceText = ((await confidenceBadge
          .textContent({ timeout: 10_000 })
          .catch(() => '')) ?? '').trim();
      }
      steps.push({
        name: 'confidence: confusion finding is "certain" (script-type heuristic fired on real-length addresses)',
        passed: confidenceText === 'certain',
        detail: `confusion badge-adversary-confidence = ${JSON.stringify(confidenceText)} (expected "certain"; "likely" means getScriptType returned "unknown" for the seeds)`,
      });
    }

    // ── Degradation banner (1 of 3 addresses has chainType => partial) ──────
    {
      const bannerVisible = await page
        .getByTestId('banner-adversary-degradation')
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'degradation: partial-chaintype banner is shown (1 of 3 records has chainType)',
        passed: bannerVisible === true,
        detail: bannerVisible
          ? 'banner-adversary-degradation is visible'
          : 'banner-adversary-degradation was missing',
      });
    }

    // ── Reload: persisted results must survive a page refresh ───────────────
    {
      await page.reload({ waitUntil: 'load', timeout: 60_000 });

      // Unlock the existing vault (setup already ran, so only the password
      // field shows — no confirm input this time).
      const unlockInput = page.getByTestId('input-password');
      await unlockInput.waitFor({ state: 'visible', timeout: 30_000 });
      await unlockInput.fill(SETUP_PASSWORD);
      await page.getByTestId('button-submit').click();

      // Best-effort: dismiss the legacy-migration overlay if it appears after
      // unlock, otherwise it swallows clicks / covers the page.
      await page
        .getByTestId('button-dismiss-migration')
        .click({ timeout: 5_000 })
        .catch(() => {});

      // The adversary panel must rehydrate WITHOUT clicking Run Audit.
      const panelAfter = page.locator('[data-testid="container-adversary-view"]');
      const panelRestored = await panelAfter
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'reload: adversary panel is restored without re-running the audit',
        passed: panelRestored,
        detail: panelRestored
          ? 'container-adversary-view visible after reload with no Run Audit click'
          : 'container-adversary-view did not reappear after reload',
      });

      const restoredBanner = await page
        .getByTestId('banner-audit-restored')
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'reload: "restored from your last run" banner is shown',
        passed: restoredBanner === true,
        detail: restoredBanner
          ? 'banner-audit-restored is visible'
          : 'banner-audit-restored was missing after reload',
      });

      if (panelRestored) {
        const statText = async (id) =>
          (await page.getByTestId(id).textContent())?.trim() ?? '';
        const rExposure = await statText('text-adversary-stat-exposure');
        const rSeparated = await statText('text-adversary-stat-separated');
        const rConfusion = await statText('text-adversary-stat-confusion');
        const rContext = await statText('text-adversary-stat-context');
        steps.push({
          name: 'reload: adversary summary stats match the pre-reload values',
          passed:
            rExposure === '2' && rSeparated === '0' && rConfusion === '1' && rContext === '0',
          detail: `exposed=${rExposure} separated=${rSeparated} confusion=${rConfusion} context=${rContext} (expected 2/0/1/0)`,
        });

        const badgeText = ((await page
          .getByTestId('badge-adversary-exposure-count')
          .textContent()
          .catch(() => '')) ?? '').trim();
        steps.push({
          name: 'reload: header exposure badge still shows "1 exposure"',
          passed: /1/.test(badgeText) && /exposure/.test(badgeText),
          detail: `badge-adversary-exposure-count = ${JSON.stringify(badgeText)} after reload`,
        });

        const scoreVisible = await page
          .getByTestId('container-score-summary')
          .isVisible()
          .catch(() => false);
        steps.push({
          name: 'reload: main audit score summary is restored too',
          passed: scoreVisible === true,
          detail: scoreVisible
            ? 'container-score-summary visible after reload'
            : 'container-score-summary missing after reload',
        });
      }
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

  console.log(`[adversary-view-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[adversary-view-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[adversary-view-browser] PASSED: Adversary View panel renders with a loading status, correct summary stats, and matching badge counts in a real browser.',
  );
}

main().catch((err) => {
  console.error('[adversary-view-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
