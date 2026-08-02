#!/usr/bin/env node
// Real-browser verification of the KDF strengthening (100k -> 600k PBKDF2)
// for BOTH surfaces that store KDF parameters alongside their salt:
//
//   Vault unlock (client/src/lib/vault.ts + AuthContext):
//     A. Seeds a vault row exactly the way a PRE-STRENGTHENING build wrote it
//        (hash derived at LEGACY 100k, NO kdfIterations field) without booting
//        the app, then logs in through the real login form.
//     B. Asserts the transparent upgrade ran: row now carries
//        kdfIterations = 600000, the SALT IS UNCHANGED (legacy at-rest
//        payloads key off it) and the passwordHash was re-derived.
//     C. Reloads and logs in a SECOND time — the upgraded row must still
//        unlock at the current parameters.
//
//   Encrypted v3 backups (client/src/lib/backup/*):
//     D. Builds, in the page, a v3 zip byte-for-byte the way an old build did
//        (key derived at LEGACY, manifest with NO kdfIterations) and restores
//        it via the real restoreV3Backup — must succeed; a wrong password
//        must be rejected.
//     E. Exports a fresh encrypted backup via the real exportBackup and
//        restores it — manifest must record kdfIterations = 600000.
//
// All key derivation/decryption runs on the browser's REAL WebCrypto — the
// runtime-specific surface the Node/jsdom suites (vault.kdf.test.ts,
// kdf-params.runtime.test.ts) cannot cover.
//
// Usage: node scripts/check-kdf-upgrade-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`; the dev
// server on port 5000 is reused when already running.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script, incl. server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'kdf-upgrade-check-123';
const BACKUP_PASSWORD = 'kdf-backup-check-456';

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
      console.log(`[kdf-upgrade] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

// The legacy-migration overlay appears after unlocking a legacy-shaped vault
// (even an empty one) — dismiss it or subsequent clicks get swallowed.
async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
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

/** Fill the login form (vault already exists → no confirm field). */
async function login(page, timeoutMs = 60_000) {
  const pwInput = page.getByTestId('input-password');
  await pwInput.waitFor({ state: 'visible', timeout: timeoutMs });
  await pwInput.fill(PASSWORD);
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 60_000 });
  await dismissMigrationOverlayIfPresent(page);
  // Startup repairs may run behind the "Preparing your vault..." gate — on
  // this near-empty fixture they finish quickly.
  await page
    .waitForSelector('[data-testid="text-migration-phase"]', { state: 'detached', timeout: 2 * 60_000 })
    .catch(() => {});
}

async function gotoWithRetry(page, url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      return;
    } catch (err) {
      lastErr = err;
      console.log(`[kdf-upgrade] goto ${url} failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 3_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[kdf-upgrade] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[kdf-upgrade] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[kdf-upgrade] starting dev server (npm run dev) ...');
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

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const browser = await launchWithRetry(exe);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[kdf-upgrade][console-error] ${msg.text()}`);
    });
    page.on('pageerror', (err) => console.log(`[kdf-upgrade][pageerror] ${err.message}`));

    // ── Phase A: seed a PRE-STRENGTHENING vault row without booting the app ──
    // manifest.json is served by Vite without loading the SPA, so nothing
    // touches the databases before we shape them.
    await gotoWithRetry(page, `${BASE_URL}manifest.json`);
    const seeded = await page.evaluate(async ({ password }) => {
      const vault = await import('/src/lib/vault.ts');
      const cryptoLib = await import('/src/lib/crypto.ts');
      // Clean slate: this check owns the vault for the duration of the run.
      await vault.vaultDb.vault.clear();
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('KYUTXODatabase');
        req.onsuccess = req.onerror = req.onblocked = () => resolve(null);
      });
      const salt = cryptoLib.generateSalt();
      const passwordHash = await cryptoLib.hashPassword(
        password,
        salt,
        cryptoLib.LEGACY_PBKDF2_ITERATIONS,
      );
      // Exactly what a pre-strengthening build wrote: NO kdfIterations field.
      await vault.vaultDb.vault.put({
        id: 'main',
        salt: cryptoLib.bufferToBase64(salt),
        passwordHash,
        createdAt: Date.now(),
      });
      const row = await vault.vaultDb.vault.get('main');
      return {
        salt: row.salt,
        passwordHash: row.passwordHash,
        hasIterations: 'kdfIterations' in row,
        legacy: cryptoLib.LEGACY_PBKDF2_ITERATIONS,
        current: cryptoLib.CURRENT_PBKDF2_ITERATIONS,
      };
    }, { password: PASSWORD });
    step(
      'seeded pre-strengthening vault row (legacy hash, no kdfIterations)',
      !seeded.hasIterations && seeded.legacy === 100000 && seeded.current === 600000,
      `hasIterations=${seeded.hasIterations}, LEGACY=${seeded.legacy}, CURRENT=${seeded.current}`,
    );

    // ── Phase B: first login unlocks the legacy vault + upgrades in place ────
    await gotoWithRetry(page, BASE_URL);
    await login(page);
    step('legacy vault unlocked through the real login form', true);

    // The upgrade is awaited inside login(), but poll briefly to be safe.
    const upgraded = await page.evaluate(async ({ before }) => {
      const vault = await import('/src/lib/vault.ts');
      const deadline = Date.now() + 30_000;
      let row = null;
      while (Date.now() < deadline) {
        row = await vault.vaultDb.vault.get('main');
        if (row?.kdfIterations === 600000) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return {
        kdfIterations: row?.kdfIterations ?? null,
        saltUnchanged: row?.salt === before.salt,
        hashChanged: row?.passwordHash !== before.passwordHash,
      };
    }, { before: { salt: seeded.salt, passwordHash: seeded.passwordHash } });
    step(
      'vault row transparently upgraded to 600000 iterations',
      upgraded.kdfIterations === 600000,
      `kdfIterations=${upgraded.kdfIterations}`,
    );
    step('salt preserved by the upgrade (legacy at-rest payloads key off it)', upgraded.saltUnchanged);
    step('passwordHash re-derived (differs from the legacy hash)', upgraded.hashChanged);

    // ── Phase C: second login on the UPGRADED row ─────────────────────────────
    await gotoWithRetry(page, BASE_URL);
    await login(page);
    step('upgraded vault still unlocks on a second login (600k parameters)', true);

    // ── Phase D: legacy (no-kdfIterations) encrypted v3 backup restores ──────
    const legacyRestore = await page.evaluate(async ({ password }) => {
      const format = await import('/src/lib/backup/format.ts');
      const { ZipStreamWriter, blobChunks } = await import('/src/lib/backup/zip-stream.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');
      const cryptoLib = await import('/src/lib/crypto.ts');
      const { restoreV3Backup } = await import('/src/lib/backup/restore.ts');

      // Build a zip byte-for-byte the way a PRE-STRENGTHENING build did: key
      // derived at LEGACY iterations, manifest with salt + check but NO
      // kdfIterations field (mirrors kdf-params.runtime.test.ts).
      const salt = cryptoLib.generateSalt();
      const key = await cryptoLib.deriveKey(password, salt, cryptoLib.LEGACY_PBKDF2_ITERATIONS);
      const manifest = {
        formatVersion: format.BACKUP_FORMAT_VERSION,
        app: 'KYUTXO',
        appVersion: '3.0.0-legacy',
        exportDate: new Date().toISOString(),
        encrypted: true,
        salt: cryptoLib.bufferToBase64(salt),
        check: await cryptoLib.encrypt(format.CHECK_SENTINEL, key),
        counts: {
          records: 0, blockchainTransactions: 0, transactionParticipants: 0,
          attachments: 0, addressSyncState: 0, utxoLineage: 0,
          custodySegments: 0, lineageSnapshots: 0, attachmentFiles: 0,
        },
        totalAttachmentBytes: 0,
        streamedTables: [...format.STREAMED_TABLES],
        ...(await format.serializeInline({}, key)),
      };
      const sink = new MemorySink();
      const writer = new ZipStreamWriter(sink);
      await writer.addBytes(
        format.MANIFEST_FILENAME,
        new TextEncoder().encode(JSON.stringify(manifest)),
      );
      await writer.finalize();
      const blob = sink.blob;

      const attachmentWriter = { async write() {} };
      const result = await restoreV3Backup({
        source: blobChunks(blob),
        password,
        attachmentWriter,
      });

      let wrongRejected = false;
      let wrongMessage = '';
      try {
        await restoreV3Backup({
          source: blobChunks(blob),
          password: 'definitely-the-wrong-password',
          attachmentWriter,
        });
      } catch (err) {
        wrongMessage = String(err?.message ?? err);
        wrongRejected = /password|corrupt/i.test(wrongMessage);
      }
      return {
        manifestIterations: result.manifest.kdfIterations ?? null,
        records: result.counts.records,
        wrongRejected,
        wrongMessage,
      };
    }, { password: BACKUP_PASSWORD });
    step(
      'legacy encrypted backup (manifest without kdfIterations) restored',
      legacyRestore.manifestIterations === null && legacyRestore.records === 0,
      `manifest.kdfIterations=${legacyRestore.manifestIterations}, records=${legacyRestore.records}`,
    );
    step(
      'legacy backup rejects a wrong password',
      legacyRestore.wrongRejected,
      legacyRestore.wrongMessage,
    );

    // ── Phase E: freshly exported backup records + restores at 600k ──────────
    const currentRestore = await page.evaluate(async ({ password }) => {
      const { exportBackup } = await import('/src/lib/backup/export.ts');
      const { restoreV3Backup } = await import('/src/lib/backup/restore.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');
      const { blobChunks } = await import('/src/lib/backup/zip-stream.ts');

      const sink = new MemorySink();
      await exportBackup({
        sink,
        encrypted: true,
        password,
        attachmentIO: {
          async listAll() { return []; },
          async read() { return null; },
        },
      });
      const result = await restoreV3Backup({
        source: blobChunks(sink.blob),
        password,
        attachmentWriter: { async write() {} },
      });
      return { manifestIterations: result.manifest.kdfIterations ?? null };
    }, { password: BACKUP_PASSWORD });
    step(
      'fresh encrypted backup records kdfIterations=600000 and restores',
      currentRestore.manifestIterations === 600000,
      `manifest.kdfIterations=${currentRestore.manifestIterations}`,
    );
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try { devProc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
  }

  const ok = steps.every((s) => s.passed);
  if (!ok) {
    console.error('\n[kdf-upgrade] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}${s.detail ? `: ${s.detail}` : ''}`);
    }
    process.exit(1);
  }
  console.log(
    '\n[kdf-upgrade] PASSED: a pre-strengthening vault unlocks + upgrades to 600k in a real browser, and both legacy and current encrypted backups restore.',
  );
}

main().catch((err) => {
  console.error('[kdf-upgrade] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
