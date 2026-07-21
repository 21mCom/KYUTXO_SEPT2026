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
//      inputs in one confirmed transaction with two external outputs. Per the
//      CIO heuristic this yields exactly ONE exposure finding covering TWO
//      owned addresses, and zero separation/confusion/context-merge findings.
//   3. Installs a MutationObserver BEFORE clicking "Run Audit" so the
//      transient `text-adversary-status` loading message is captured even if
//      the analysis finishes in milliseconds.
//   4. Runs the audit and asserts:
//        - `container-adversary-view` appears
//        - the loading status message was observed during analysis
//        - the summary stats are exactly what the seed predicts
//          (2 exposed / 0 separated / 0 confusion / 0 context merges)
//        - the header exposure badge ("1 exposure") matches the section
//          badge count, and no separation/confusion/context badges render
//        - the no-XPUB degradation banner is shown (no chainType seeded)
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-adversary-view-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const AUDIT_URL = `${BASE_URL}privacy-audit`;
const SETUP_PASSWORD = 'adversary-view-check-123';

// Two owned addresses that co-spend (fake-but-plausible bech32 strings are
// fine: the audit + adversary engines match addresses by string equality, and
// the first-8-chars differ so nothing collides).
const ADDR_OWNED_A = 'bc1qadvexpo0aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_OWNED_B = 'bc1qadvexpo1bbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// External (non-owned) payment + change outputs of the co-spend tx.
const ADDR_EXT_PAY = 'bc1qextpay00cccccccccccccccccccccccccccc';
const ADDR_EXT_CHG = 'bc1qextchg00dddddddddddddddddddddddddddd';
const COSPEND_TXID = 'adv0'.repeat(16); // 64 hex-ish chars

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
      async ({ ownedA, ownedB, extPay, extChg, txid }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        for (const addr of [ownedA, ownedB]) {
          await recordCrud.createRecord({
            type: 'address',
            inputString: addr,
            label: `Adversary check ${addr.slice(0, 12)}`,
          });
        }

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
        return true;
      },
      {
        ownedA: ADDR_OWNED_A,
        ownedB: ADDR_OWNED_B,
        extPay: ADDR_EXT_PAY,
        extChg: ADDR_EXT_CHG,
        txid: COSPEND_TXID,
      },
    );
    steps.push({
      name: 'seed: 2 owned address records + co-spend tx written to vault',
      passed: seedResult === true,
      detail: `seeded ${ADDR_OWNED_A.slice(0, 14)}… and ${ADDR_OWNED_B.slice(0, 14)}… co-spending in ${COSPEND_TXID.slice(0, 8)}…`,
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
      name: 'stats: separated/confusion/context stats are all 0',
      passed: statSeparated === '0' && statConfusion === '0' && statContext === '0',
      detail: `separated=${statSeparated} confusion=${statConfusion} context=${statContext} (expected 0/0/0)`,
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
      const confusionBadges = await page
        .locator('[data-testid="badge-adversary-confusion-count"]')
        .count();
      const contextBadges = await page
        .locator('[data-testid="badge-adversary-context-merge-count"]')
        .count();
      steps.push({
        name: 'badges: no separation/confusion/context-merge badges render (counts are 0)',
        passed: separationBadges === 0 && confusionBadges === 0 && contextBadges === 0,
        detail: `separation=${separationBadges} confusion=${confusionBadges} context=${contextBadges} (expected 0/0/0)`,
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

    // ── Degradation banner (no chainType seeded => no-xpub-import) ──────────
    {
      const bannerVisible = await page
        .getByTestId('banner-adversary-degradation')
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'degradation: no-XPUB banner is shown for chainType-less records',
        passed: bannerVisible === true,
        detail: bannerVisible
          ? 'banner-adversary-degradation is visible'
          : 'banner-adversary-degradation was missing',
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
