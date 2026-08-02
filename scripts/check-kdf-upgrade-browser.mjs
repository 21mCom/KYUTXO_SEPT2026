#!/usr/bin/env node
// Real-browser verification of the transparent KDF upgrade (legacy 100k
// PBKDF2 -> current Argon2id) for BOTH surfaces that store KDF parameters
// alongside their salt:
//
//   Vault unlock (client/src/lib/vault.ts + AuthContext):
//     A. Seeds a vault row exactly the way a PRE-STRENGTHENING build wrote it
//        (hash derived at LEGACY 100k, NO kdfIterations/kdf field) without
//        booting the app, then logs in through the real login form.
//     B. Asserts the transparent upgrade ran: row now carries the current
//        Argon2id kdf record, the SALT IS UNCHANGED (legacy at-rest
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
//        restores it — manifest must record the current Argon2id kdf record.
//
//   Failed-upgrade retry (the path AuthContext treats as best-effort):
//     F. Re-seeds a legacy vault row, then injects a ONE-SHOT failure into the
//        vault-row update (vaultDb.vault.update rejects once — the browser
//        analogue of an IndexedDB quota/abort mid-write) BEFORE logging in.
//        The login must still succeed and the row must keep its exact legacy
//        shape (no kdf record, same salt, same hash).
//     G. Reloads (dropping the injected failure) and logs in again — the
//        upgrade must retry transparently and complete to the current
//        Argon2id parameters with the salt preserved.
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
        hasKdf: 'kdf' in row,
        legacy: cryptoLib.LEGACY_PBKDF2_ITERATIONS,
        currentAlgo: cryptoLib.CURRENT_KDF_PARAMS.algorithm,
      };
    }, { password: PASSWORD });
    step(
      'seeded pre-strengthening vault row (legacy hash, no kdfIterations/kdf)',
      !seeded.hasIterations && !seeded.hasKdf && seeded.legacy === 100000 && seeded.currentAlgo === 'argon2id',
      `hasIterations=${seeded.hasIterations}, hasKdf=${seeded.hasKdf}, LEGACY=${seeded.legacy}, currentAlgo=${seeded.currentAlgo}`,
    );

    // ── Phase B: first login unlocks the legacy vault + upgrades in place ────
    await gotoWithRetry(page, BASE_URL);
    await login(page);
    step('legacy vault unlocked through the real login form', true);

    // The upgrade is awaited inside login(), but poll briefly to be safe.
    const upgraded = await page.evaluate(async ({ before }) => {
      const vault = await import('/src/lib/vault.ts');
      const cryptoLib = await import('/src/lib/crypto.ts');
      const deadline = Date.now() + 30_000;
      let row = null;
      while (Date.now() < deadline) {
        row = await vault.vaultDb.vault.get('main');
        if (row?.kdf && cryptoLib.isCurrentKdf(row.kdf)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return {
        kdf: row?.kdf ?? null,
        isCurrent: !!row?.kdf && cryptoLib.isCurrentKdf(row.kdf),
        saltUnchanged: row?.salt === before.salt,
        hashChanged: row?.passwordHash !== before.passwordHash,
      };
    }, { before: { salt: seeded.salt, passwordHash: seeded.passwordHash } });
    step(
      'vault row transparently upgraded to the current Argon2id parameters',
      upgraded.isCurrent,
      `kdf=${JSON.stringify(upgraded.kdf)}`,
    );
    step('salt preserved by the upgrade (legacy at-rest payloads key off it)', upgraded.saltUnchanged);
    step('passwordHash re-derived (differs from the legacy hash)', upgraded.hashChanged);

    // ── Phase C: second login on the UPGRADED row ─────────────────────────────
    await gotoWithRetry(page, BASE_URL);
    await login(page);
    step('upgraded vault still unlocks on a second login (current parameters)', true);

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
      return { manifestKdf: result.manifest.kdf ?? null };
    }, { password: BACKUP_PASSWORD });
    step(
      'fresh encrypted backup records the current Argon2id kdf and restores',
      currentRestore.manifestKdf?.algorithm === 'argon2id',
      `manifest.kdf=${JSON.stringify(currentRestore.manifestKdf)}`,
    );

    // ── Phase F: one-shot vault-write failure during the upgrade ────────────
    // Re-seed a fresh legacy row (manifest.json is served without booting the
    // SPA, so nothing touches the databases while we shape them). All one-time
    // migration flags are pre-set so the ONLY vault-row update during login is
    // the KDF upgrade write we are about to sabotage.
    await gotoWithRetry(page, `${BASE_URL}manifest.json`);
    const reseeded = await page.evaluate(async ({ password }) => {
      const vault = await import('/src/lib/vault.ts');
      const cryptoLib = await import('/src/lib/crypto.ts');
      await vault.vaultDb.vault.clear();
      const salt = cryptoLib.generateSalt();
      const passwordHash = await cryptoLib.hashPassword(
        password,
        salt,
        cryptoLib.LEGACY_PBKDF2_ITERATIONS,
      );
      await vault.vaultDb.vault.put({
        id: 'main',
        salt: cryptoLib.bufferToBase64(salt),
        passwordHash,
        createdAt: Date.now(),
        attachmentPathsMigrated: true,
        legacyDecryptComplete: true,
        legacyFileDecryptComplete: true,
        inputStringLowerRepaired: true,
        searchVisibilityRepaired: true,
      });
      const row = await vault.vaultDb.vault.get('main');
      return { salt: row.salt, passwordHash: row.passwordHash, hasKdf: 'kdf' in row };
    }, { password: PASSWORD });
    step('re-seeded legacy vault row for the failure-injection pass', !reseeded.hasKdf);

    // Boot the app, then — BEFORE logging in — patch the live Vite module
    // singleton so the FIRST vaultDb.vault.update rejects (the browser
    // analogue of an IndexedDB quota/abort mid-write). Later calls pass
    // through untouched.
    let sawRetryLog = false;
    const retryLogListener = (msg) => {
      if (msg.text().includes('KDF upgrade failed')) sawRetryLog = true;
    };
    page.on('console', retryLogListener);
    await gotoWithRetry(page, BASE_URL);
    await page.evaluate(async () => {
      const vault = await import('/src/lib/vault.ts');
      const table = vault.vaultDb.vault;
      const original = table.update.bind(table);
      window.__kdfInjectedFailures = 0;
      table.update = (...args) => {
        if (window.__kdfInjectedFailures === 0) {
          window.__kdfInjectedFailures += 1;
          return Promise.reject(new Error('injected one-shot vault write failure'));
        }
        return original(...args);
      };
    });
    await login(page);
    step('login still succeeds when the KDF upgrade write throws', true);

    const afterFailure = await page.evaluate(async ({ before }) => {
      const vault = await import('/src/lib/vault.ts');
      // The upgrade is awaited inside login(); give any stray write a moment.
      await new Promise((r) => setTimeout(r, 1_000));
      const row = await vault.vaultDb.vault.get('main');
      return {
        injectedFailures: window.__kdfInjectedFailures ?? 0,
        hasKdf: 'kdf' in row && row.kdf !== undefined,
        saltUnchanged: row.salt === before.salt,
        hashUnchanged: row.passwordHash === before.passwordHash,
      };
    }, { before: { salt: reseeded.salt, passwordHash: reseeded.passwordHash } });
    page.off('console', retryLogListener);
    step(
      'injected failure was actually consumed by the upgrade write',
      afterFailure.injectedFailures === 1,
      `injectedFailures=${afterFailure.injectedFailures}`,
    );
    step(
      'row keeps its exact legacy shape after the failed upgrade (no kdf, salt+hash untouched)',
      !afterFailure.hasKdf && afterFailure.saltUnchanged && afterFailure.hashUnchanged,
      `hasKdf=${afterFailure.hasKdf}, saltUnchanged=${afterFailure.saltUnchanged}, hashUnchanged=${afterFailure.hashUnchanged}`,
    );
    step(
      'failed upgrade was logged as best-effort (retry next unlock), not surfaced as a login failure',
      sawRetryLog,
    );

    // ── Phase G: next unlock retries and completes the upgrade ──────────────
    // A full reload drops the injected patch (fresh module graph).
    await gotoWithRetry(page, BASE_URL);
    await login(page);
    const retried = await page.evaluate(async ({ before }) => {
      const vault = await import('/src/lib/vault.ts');
      const cryptoLib = await import('/src/lib/crypto.ts');
      const deadline = Date.now() + 30_000;
      let row = null;
      while (Date.now() < deadline) {
        row = await vault.vaultDb.vault.get('main');
        if (row?.kdf && cryptoLib.isCurrentKdf(row.kdf)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return {
        kdf: row?.kdf ?? null,
        isCurrent: !!row?.kdf && cryptoLib.isCurrentKdf(row.kdf),
        saltUnchanged: row?.salt === before.salt,
        hashChanged: row?.passwordHash !== before.passwordHash,
      };
    }, { before: { salt: reseeded.salt, passwordHash: reseeded.passwordHash } });
    step(
      'upgrade retried transparently on the next unlock (current Argon2id parameters)',
      retried.isCurrent,
      `kdf=${JSON.stringify(retried.kdf)}`,
    );
    step('salt preserved by the retried upgrade', retried.saltUnchanged);
    step('passwordHash re-derived by the retried upgrade', retried.hashChanged);
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
    '\n[kdf-upgrade] PASSED: a pre-strengthening vault unlocks + upgrades to Argon2id in a real browser (including after a failed upgrade write), and both legacy and current encrypted backups restore.',
  );
}

main().catch((err) => {
  console.error('[kdf-upgrade] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
