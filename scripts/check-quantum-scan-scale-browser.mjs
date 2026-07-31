#!/usr/bin/env node
// Real-browser scale guard for the Quantum Risk Scanner's tagging phase
// (task: "Keep the quantum scan from crawling on huge vaults when many tags
// change").
//
// The tagging phase used to write changed records one at a time via
// updateRecord (awaited per record), so a first scan of a 10k-record vault
// issued 10k serial Dexie writes and took minutes. The fix routes pending tag
// updates through chunked bulkUpdateRecords calls (500 per chunk).
//
// This script drives a REAL headless Chromium against the running dev server:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds 10,000 p2pk address records (all classify as Critical, none
//      tagged yet, so under the default Critical+High selection EVERY record
//      needs a tag write) via the live bulkCreateRecords module singleton
//   3. opens /quantum-risk, clicks Scan Records, and times the run until the
//      "Scan complete" status appears
//   4. asserts the scan completes within SCAN_BUDGET_MS (the pre-fix serial
//      path took minutes) and that all 10k records now carry quantum:critical
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-quantum-scan-scale-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'quantum-scale-check-123';

const RECORD_COUNT = 10_000;
// Generous "seconds, not minutes" budget: the chunked bulk path finishes in a
// few seconds locally; the pre-fix serial path took several minutes. Kept
// loose so parallel-validation load can't flake it.
const SCAN_BUDGET_MS = 60_000;

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
    .waitFor({ state: 'visible', timeout: 8_000 })
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

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[quantum-scan-scale] legacy-migration overlay detected; waiting it out ...');
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

async function launchWithRetry(exe) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(`[quantum-scan-scale] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[quantum-scan-scale] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[quantum-scan-scale] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[quantum-scan-scale] starting dev server (npm run dev) ...`);
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
    console.log(`[quantum-scan-scale] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[quantum-scan-scale][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}quantum-risk`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed 10k untagged p2pk (critical) records via the live singleton ────
    const seedStart = Date.now();
    const seed = await page.evaluate(async ({ count }) => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const CHUNK = 2000;
      let created = 0;
      for (let s = 0; s < count; s += CHUNK) {
        const batch = [];
        for (let i = s; i < Math.min(s + CHUNK, count); i++) {
          batch.push({
            type: 'address',
            // 66 hex chars → detected as p2pk → Critical risk.
            inputString: '02' + i.toString(16).padStart(64, '0'),
            label: `Quantum scale record ${i}`,
            source: 'manual',
            addressImportance: 'manual',
            tags: [],
            categories: [],
          });
        }
        const ids = await recordCrud.bulkCreateRecords(batch, {
          skipVocabularySync: true,
          skipNotification: true,
        });
        created += ids.length;
      }
      return { created };
    }, { count: RECORD_COUNT });
    steps.push({
      name: `seeded ${RECORD_COUNT} untagged p2pk address records`,
      passed: seed.created === RECORD_COUNT,
      detail: `created=${seed.created} in ${Date.now() - seedStart}ms`,
    });

    // ── Reload so the page reads the seeded vault, then run the scan ────────
    await page.goto(`${BASE_URL}quantum-risk`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const scanButton = page.getByTestId('button-scan-records');
    await scanButton.waitFor({ state: 'visible', timeout: 30_000 });
    // Wait until settings load (button enabled).
    const enableDeadline = Date.now() + 30_000;
    while (Date.now() < enableDeadline) {
      if (await scanButton.isEnabled().catch(() => false)) break;
      await page.waitForTimeout(250);
    }

    const scanStart = Date.now();
    await scanButton.click();
    const statusEl = page.getByTestId('text-status-message');
    let statusText = '';
    let completed = false;
    const scanDeadline = Date.now() + SCAN_BUDGET_MS + 30_000; // hard wait cap
    while (Date.now() < scanDeadline) {
      statusText = ((await statusEl.textContent().catch(() => '')) ?? '').trim();
      if (statusText.startsWith('Scan complete')) {
        completed = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    const scanMs = Date.now() - scanStart;

    steps.push({
      name: `full scan over ${RECORD_COUNT} records needing tag writes completes within ${SCAN_BUDGET_MS / 1000}s`,
      passed: completed && scanMs <= SCAN_BUDGET_MS,
      detail: `completed=${completed} in ${scanMs}ms, status="${statusText}"`,
    });
    steps.push({
      name: 'status reports every record classified and tagged',
      passed: statusText.includes(`${RECORD_COUNT} addresses classified, ${RECORD_COUNT} tagged.`),
      detail: `status="${statusText}"`,
    });

    // ── Verify the writes actually landed in Dexie ──────────────────────────
    const verify = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      const tagged = await db.records.where('tags').equals('quantum:critical').count();
      const total = await db.records.count();
      return { tagged, total };
    });
    steps.push({
      name: 'all seeded records carry quantum:critical after the scan',
      passed: verify.tagged === RECORD_COUNT && verify.total === RECORD_COUNT,
      detail: `tagged=${verify.tagged}, total=${verify.total}`,
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
  console.log(`[quantum-scan-scale] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[quantum-scan-scale] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    `[quantum-scan-scale] PASSED: a first scan over ${RECORD_COUNT} records tags them all in seconds via the chunked bulk write path.`,
  );
}

main().catch((err) => {
  console.error('[quantum-scan-scale] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
