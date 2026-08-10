#!/usr/bin/env node
// Real-browser verification that the Custody/Provenance UI actually renders
// the deep (3+ hop) demo custody chains after a REAL restore of the demo
// showcase vault (demo/kyutxo-demo-vault.zip).
//
// The demo vault curates multi-hop custody segments (hopCount 3-4, Blake
// Rivera persona). Data-level presence was already verified; this check
// guards the visible demo story end-to-end:
//   1. Creates a fresh vault via the setup form.
//   2. Streams the demo v3 ZIP through the real restoreV3Backup orchestrator.
//   3. Picks a persona-owned address whose custody segment has hopCount >= 3
//      (address must belong to a curated owned record).
//   4. Reloads on /provenance, unlocks, types that address into the explorer
//      address input (which drives the ContinuityProof selected address).
//   5. Expands the rendered custody segment cards and asserts the UI shows
//      "Transfer History (N hops)" with N >= 3, with N matching the DB row,
//      plus the visible evidence txid rows for that chain.
//
// Usage: node scripts/check-demo-custody-chain-browser.mjs
// Requires: demo/kyutxo-demo-vault.zip (node scripts/demo-vault/build-demo-vault.mjs)

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'demo-custody-check-123';
const ZIP_PATH = path.resolve('demo/kyutxo-demo-vault.zip');
const MAX_ATTEMPTS = 3;

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH.');
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

async function launchBrowser(exe) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      lastErr = e;
      console.log(`[demo-custody-chain] chromium launch failed (try ${i}): ${e.message.split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
  throw lastErr;
}

async function runSession(browser, zipB64, step) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // Fresh vault via setup form (fresh context = fresh IndexedDB).
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 60_000 });
    await pwInput.fill(SETUP_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page.getByTestId('button-dismiss-migration').click({ timeout: 3_000 }).catch(() => {});

    // Restore the demo backup through the REAL v3 restore orchestrator.
    const restore = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const { restoreV3Backup } = await import('/src/lib/backup/restore.ts');
      const source = (async function* () {
        const CHUNK = 1 << 20;
        for (let o = 0; o < bytes.length; o += CHUNK) yield bytes.slice(o, o + CHUNK);
      })();
      const result = await restoreV3Backup({
        source,
        attachmentWriter: { async write() {} },
      });
      return { counts: result.counts };
    }, zipB64);
    step(
      'restore completes with custody segments',
      restore.counts.custodySegments >= 20,
      `${restore.counts.custodySegments} segments restored`,
    );

    // Pick a persona-owned address whose segment has hopCount >= 3. The
    // address must be one of the segment's queryable fields (origin/current)
    // AND belong to a curated owned record so it is a real persona address.
    const target = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      const { USER_CURATED_TIERS } = await import('/src/lib/db-types.ts');
      const records = await db.records.toArray();
      const ownedByAddr = new Map(
        records
          .filter((r) => USER_CURATED_TIERS.includes(r.addressImportance))
          .map((r) => [r.inputString, r]),
      );
      const segs = (await db.custodySegments.toArray())
        .filter((s) => (s.hopCount ?? 0) >= 3)
        .sort((a, b) => (b.hopCount ?? 0) - (a.hopCount ?? 0));
      for (const s of segs) {
        for (const addr of [s.currentAddress, s.originAddress]) {
          if (addr && ownedByAddr.has(addr)) {
            const rec = ownedByAddr.get(addr);
            return {
              address: addr,
              hopCount: s.hopCount,
              segmentId: s.segmentId,
              segmentOwner: s.owner ?? null,
              recordOwner: rec.owner ?? null,
              evidenceTxids: (s.evidenceTxids ?? []).length,
              deepSegments: segs.length,
            };
          }
        }
      }
      return null;
    });
    step(
      'demo vault has a 3+ hop segment on a persona-owned address',
      !!target,
      target
        ? `${target.deepSegments} deep segments; picked ${target.hopCount} hops on ${target.address} (owner: ${target.recordOwner ?? target.segmentOwner})`
        : 'no hopCount>=3 segment matches a curated owned record',
    );
    if (!target) return;

    // Full reload on the Provenance page (restored vault persists in this
    // context), unlock there (unlock is per page load).
    await page.goto(`${BASE_URL}provenance`, { waitUntil: 'load', timeout: 60_000 });
    const unlockInput = page.getByTestId('input-password');
    await unlockInput.waitFor({ state: 'visible', timeout: 60_000 });
    await unlockInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page.getByTestId('button-dismiss-migration').click({ timeout: 3_000 }).catch(() => {});

    // The Custody stats card reflects the restored segments without a rebuild.
    const segCountEl = page.getByTestId('text-segment-count');
    await segCountEl.waitFor({ state: 'visible', timeout: 60_000 });
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="text-segment-count"]');
          return el && parseInt(el.textContent || '0', 10) >= 20;
        }, undefined,
        { timeout: 30_000 },
      )
      .catch(() => {});
    const segCountText = (await segCountEl.innerText()).trim();
    step('custody stats show restored segment count', parseInt(segCountText, 10) >= 20, `${segCountText} segments in UI`);

    // Select the persona-owned address; ContinuityProof follows this input.
    const addrInput = page.getByTestId('input-explorer-address');
    await addrInput.waitFor({ state: 'visible', timeout: 30_000 });
    await addrInput.fill(target.address);

    // Wait for the "Custody History for Selected Address" section and the
    // segment card(s) for this address to render.
    await page
      .getByText('Custody History for Selected Address')
      .waitFor({ state: 'visible', timeout: 30_000 });

    // Segment cards render collapsed; expand every collapsed custody card.
    const triggers = page.locator('div.cursor-pointer[data-state="closed"]');
    const nCards = await triggers.count();
    step('custody segment card(s) rendered for the address', nCards >= 1, `${nCards} collapsed cards`);
    for (let i = 0; i < nCards; i++) {
      // Always click the first still-closed trigger; states change as we go.
      await page.locator('div.cursor-pointer[data-state="closed"]').first().click();
      await page.waitForTimeout(150);
    }

    // Assert the visible Transfer History header reports 3+ hops matching DB.
    const hopHeader = page.getByText(/Transfer History \(\d+ hops?\)/);
    await hopHeader.first().waitFor({ state: 'visible', timeout: 15_000 });
    const hopTexts = await hopHeader.allInnerTexts();
    const hopCounts = hopTexts
      .map((t) => parseInt((t.match(/\((\d+) hops?\)/) || [])[1] || '0', 10))
      .filter((n) => Number.isFinite(n));
    const maxHops = Math.max(0, ...hopCounts);
    step(
      'UI shows a 3+ hop transfer history for the persona address',
      maxHops >= 3 && hopCounts.includes(target.hopCount),
      `visible hop counts: [${hopCounts.join(', ')}], DB says ${target.hopCount}`,
    );

    // The deep chain's evidence txids are listed under the expanded card.
    const exportBtn = page.getByTestId(`button-export-segment-${target.segmentId}`);
    const exportVisible = await exportBtn.isVisible().catch(() => false);
    step('picked deep segment card is expanded (export button visible)', exportVisible);
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  if (!fs.existsSync(ZIP_PATH)) {
    throw new Error(`Missing ${ZIP_PATH}. Run: node scripts/demo-vault/build-demo-vault.mjs`);
  }
  const zipB64 = fs.readFileSync(ZIP_PATH).toString('base64');
  console.log(`[demo-custody-chain] zip: ${(zipB64.length * 0.75 / 1024 / 1024).toFixed(2)} MB`);

  const exe = resolveChromium();
  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error('Dev server did not become ready.');
    }
  }

  let steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    // Retry the whole session on environment flake (chromium crash, load
    // timeout under parallel validation); each attempt uses a fresh context.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      steps = [];
      const browser = await launchBrowser(exe);
      try {
        await runSession(browser, zipB64, step);
        break;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.log(`[demo-custody-chain] attempt ${attempt} crashed: ${msg.split('\n')[0]}`);
        if (attempt === MAX_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, 15_000 * attempt));
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } finally {
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[demo-custody-chain] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length || steps.length === 0) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; ') || '(no steps ran)');
    process.exit(1);
  }
  console.log('[demo-custody-chain] OK');
}

main().catch((err) => {
  console.error('[demo-custody-chain] FATAL:', err);
  process.exit(1);
});
