#!/usr/bin/env node
// Real-browser verification for the demo showcase vault (demo/kyutxo-demo-vault.zip).
//
// Restores the curated real-data demo backup into a FRESH vault in headless
// Chromium — exactly the path a presenter uses — and walks the feature
// coverage matrix against the live Dexie database plus one end-to-end
// Privacy Audit run:
//   1. Creates a fresh vault via the setup form.
//   2. Streams the demo v3 ZIP through the real restoreV3Backup orchestrator
//      (no-op attachment writer; the demo backup carries no attachments).
//   3. Asserts restored row counts match the backup manifest.
//   4. Asserts the coverage matrix against the restored data: curated persona
//      records, entity-list contact, dust output to an owned address,
//      spent-from P2PKH (exposed pubkey), reused owned address, multisig
//      vault records, lineage + custody rows, and the demo entity snapshot.
//   5. Reloads, unlocks, runs a full Privacy Audit on the restored data and
//      asserts the score summary + at least one finding card render.
//
// Usage: node scripts/check-demo-vault-restore-browser.mjs
// Requires: demo/kyutxo-demo-vault.zip (node scripts/demo-vault/build-demo-vault.mjs)

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'demo-vault-check-123';
const ZIP_PATH = path.resolve('demo/kyutxo-demo-vault.zip');

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

async function main() {
  if (!fs.existsSync(ZIP_PATH)) {
    throw new Error(`Missing ${ZIP_PATH}. Run: node scripts/demo-vault/build-demo-vault.mjs`);
  }
  const zipB64 = fs.readFileSync(ZIP_PATH).toString('base64');
  console.log(`[demo-vault-restore] zip: ${(zipB64.length * 0.75 / 1024 / 1024).toFixed(2)} MB`);

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

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // Fresh vault via setup form.
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });

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
      const started = performance.now();
      const result = await restoreV3Backup({
        source,
        attachmentWriter: { async write() {} },
      });
      return {
        ms: Math.round(performance.now() - started),
        counts: result.counts,
        manifestCounts: result.manifest.counts,
      };
    }, zipB64);

    const c = restore.counts;
    const m = restore.manifestCounts;
    step(
      'restore completes and counts match the manifest',
      c.records === m.records &&
        c.blockchainTransactions === m.blockchainTransactions &&
        c.transactionParticipants === m.transactionParticipants &&
        c.addressSyncState === m.addressSyncState &&
        c.utxoLineage === m.utxoLineage &&
        c.custodySegments === m.custodySegments,
      `records=${c.records} txs=${c.blockchainTransactions} participants=${c.transactionParticipants} in ${restore.ms}ms`,
    );
    step('scale is in the 5k-10k target range', c.records + c.blockchainTransactions >= 5000 && c.records + c.blockchainTransactions <= 10000, `${c.records + c.blockchainTransactions} combined`);

    // Coverage matrix against the restored Dexie data.
    const matrix = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      const { USER_CURATED_TIERS } = await import('/src/lib/db-types.ts');
      const { getActiveEntityList } = await import('/src/lib/privacy-entity-list.ts');
      const { loadEntitySnapshotFromStorage } = await import('/src/lib/data/entity-list-store.ts');

      const records = await db.records.toArray();
      const curated = records.filter((r) => USER_CURATED_TIERS.includes(r.addressImportance));
      const curatedAddrs = new Set(curated.map((r) => r.inputString));
      const owners = new Set(curated.map((r) => r.owner).filter(Boolean));
      const vaultRecords = curated.filter((r) => r.vault && r.vault.isVaultXpub);
      const unlabeled = records.filter((r) => !r.label);

      await loadEntitySnapshotFromStorage(); // applies the merged demo snapshot
      const entityMap = new Map(getActiveEntityList().map((e) => [e.address, e]));

      const participants = await db.transactionParticipants.toArray();
      const byTx = new Map();
      for (const p of participants) {
        if (!byTx.has(p.txid)) byTx.set(p.txid, []);
        byTx.get(p.txid).push(p);
      }
      let entityContactTx = 0;
      let entityCats = new Set();
      for (const [, ps] of byTx) {
        const hasOwned = ps.some((p) => curatedAddrs.has(p.address));
        const ents = ps.filter((p) => entityMap.has(p.address));
        if (hasOwned && ents.length) {
          entityContactTx++;
          for (const e of ents) entityCats.add(entityMap.get(e.address).category);
        }
      }
      const dust = participants.some(
        (p) => p.role === 'output' && p.amount > 0 && p.amount <= 1000 && curatedAddrs.has(p.address),
      );
      const quantum = participants.some(
        (p) => p.role === 'input' && p.address.startsWith('1') && curatedAddrs.has(p.address),
      );
      const receipts = new Map();
      for (const p of participants) {
        if (p.role === 'output' && curatedAddrs.has(p.address)) {
          receipts.set(p.address, (receipts.get(p.address) || 0) + 1);
        }
      }
      const maxReuse = Math.max(0, ...receipts.values());
      const txs = await db.blockchainTransactions.toArray();
      const times = txs.map((t) => t.blockTime);
      const spanDays = (Math.max(...times) - Math.min(...times)) / 86400;
      const lineage = await db.utxoLineage.count();
      const segments = await db.custodySegments.count();
      // Semantic check: originDate must be Unix SECONDS (2009..now), never ms.
      const segRows = await db.custodySegments.toArray();
      const nowSec = Math.floor(Date.now() / 1000);
      const badOriginDates = segRows.filter(
        (s) => !(typeof s.originDate === 'number' && s.originDate > 1230768000 && s.originDate <= nowSec),
      ).length;
      const settings = await db.settings.get('default');

      return {
        records: records.length,
        curated: curated.length,
        owners: [...owners],
        vaultRecords: vaultRecords.length,
        unlabeled: unlabeled.length,
        entityContactTx,
        entityCats: [...entityCats],
        dust,
        quantum,
        maxReuse,
        spanDays: Math.round(spanDays),
        lineage,
        segments,
        snapshotEntries: settings?.entityListSnapshot?.entries?.length ?? 0,
        snapshotMode: settings?.entityListSnapshot?.mode,
        badOriginDates,
      };
    });

    step('curated persona records restored with owners', matrix.curated >= 25 && matrix.owners.length >= 3, `${matrix.curated} curated across ${matrix.owners.length} owners: ${matrix.owners.join(', ')}`);
    step('no unlabeled records', matrix.unlabeled === 0, `${matrix.records} records all labeled`);
    step('multisig vault grouping present', matrix.vaultRecords >= 2, `${matrix.vaultRecords} vault records`);
    step('direct entity-list contact from owned addresses', matrix.entityContactTx >= 1, `${matrix.entityContactTx} txs, categories: ${matrix.entityCats.join(', ')}`);
    step('demo entity snapshot restored (merge mode)', matrix.snapshotEntries >= 10 && matrix.snapshotMode === 'merge', `${matrix.snapshotEntries} entries`);
    step('dust output to an owned address', matrix.dust);
    step('spent-from owned P2PKH (exposed pubkey / quantum)', matrix.quantum);
    step('reused owned address (10+ receipts)', matrix.maxReuse >= 10, `max ${matrix.maxReuse} receipts`);
    step('history spans months/years', matrix.spanDays >= 180, `${matrix.spanDays} days`);
    step('lineage + custody chains restored', matrix.lineage >= 100 && matrix.segments >= 20, `${matrix.lineage} lineage rows, ${matrix.segments} segments`);
    step('custody originDate is Unix seconds in a sane range', matrix.badOriginDates === 0, `${matrix.badOriginDates} bad rows`);

    // End-to-end: full reload on the audit page (restored vault persists),
    // unlock there (unlock is per page load), run a real Privacy Audit.
    await page.goto(`${BASE_URL}privacy-audit`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    const runBtn = page.getByTestId('button-run-audit');
    try {
      await runBtn.waitFor({ state: 'visible', timeout: 60_000 });
    } catch (e) {
      const ids = await page.$$eval('[data-testid]', (els) =>
        els.slice(0, 60).map((el) => el.getAttribute('data-testid')),
      );
      console.log('[debug] visible testids:', ids.join(', '));
      console.log('[debug] body text head:', (await page.locator('body').innerText()).slice(0, 600));
      throw e;
    }
    const auditStart = Date.now();
    await runBtn.click();
    await page
      .locator('[data-testid="container-score-summary"]')
      .waitFor({ state: 'visible', timeout: 180_000 });
    const findingCards = await page.locator('[data-testid^="card-finding-"]').count();
    step('privacy audit completes on restored data with findings', findingCards >= 1, `${findingCards} finding types in ${Math.round((Date.now() - auditStart) / 1000)}s`);

    await context.close();
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[demo-vault-restore] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; '));
    process.exit(1);
  }
  console.log('[demo-vault-restore] OK');
}

main().catch((err) => {
  console.error('[demo-vault-restore] FATAL:', err);
  process.exit(1);
});
