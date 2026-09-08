#!/usr/bin/env node
// Task 229: exercise a production, packaged renderer's full Dexie -> IPC ->
// native-engine rebuild at a size large enough to expose renderer starvation.
// This deliberately drives the public Engine Diagnostics control rather than
// importing a renderer module or calling a test seam.

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { completeFreshVaultOnboardingIfPresent, unlockIfNeeded } from './browser-check-utils.mjs';
import { clearPackagedCdpOwnership, packagedCdpLaunchArgs, waitForOwnedPackagedCdp, waitForPackagedCdpDown } from './packaged-cdp.mjs';
import { assertPackagedAsarFresh, assertPackagedBundleFresh, repoRootFromModuleUrl } from './packaged-bundle-freshness.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';
import { prepareWindowsPortableLaunch } from './packaged-windows-portable.mjs';

await acquireBrowserCheckLock();

const ROOT = repoRootFromModuleUrl(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const UNPACKED = path.join(ROOT, 'release', IS_WINDOWS ? 'win-unpacked' : 'linux-unpacked');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');
const TAG = '[packaged-engine-rebuild-scale]';
const PASSWORD = 'task-229-isolated-protected-vault';
const FULL_PER_TABLE = 15_000; // 60,000 mirror-source rows in total.
const CANCEL_PER_TABLE = FULL_PER_TABLE;
const LEGACY_LONGTASK_MIN_MS = 218;
const MAX_ACCEPTABLE_LONGTASK_MS = 180;
const MAX_ACCEPTABLE_HEARTBEAT_GAP_MS = 300;
const MAX_ACCEPTABLE_PROGRESS_GAP_MS = 5_000;
const MAX_ACCEPTABLE_REBUILD_MS = 180_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function expectedContentDigests(count, now) {
  const hashes = Object.fromEntries(
    ['records', 'blockchainTransactions', 'transactionParticipants', 'transactionMetadata']
      .map((table) => [table, createHash('sha256')]),
  );
  const txid = (n) => n.toString(16).padStart(64, '0');
  for (let i = 1; i <= count; i++) {
    const hash = txid(i);
    const address = `bc1qtask229${String(i).padStart(32, '0')}`;
    const rows = {
      records: {
        id: i, type: 'address', inputString: address, inputStringLower: address,
        label: `Task 229 address ${i}`, notes: null, owner: 'Scale', walletName: 'Rebuild',
        seedName: null, walletSoftware: null, addressImportance: i % 2 ? 'verified' : 'manual',
        chainType: null, syncDepth: null, firstSeenBlockTime: null, cachedBalanceSats: null,
        cachedTxCount: null, cachedUtxoCount: null, statsComputedAt: null, createdAt: now - i,
        updatedAt: now - i, tags: '["task-229"]', categories: '["scale"]',
        derivationPath: null, discoveredInTxid: null, vaultIsVaultXpub: 0, vaultM: null,
        vaultN: null, vaultName: null, vaultNotes: null,
      },
      blockchainTransactions: {
        id: i, txid: hash, blockHeight: 840_000 + i, blockTime: 1_700_000_000 + i,
        fee: i, feeRate: 1.25, vsize: 140, hasOpReturn: 0,
      },
      transactionParticipants: {
        id: i, txid: hash, role: i % 2 ? 'output' : 'input', address,
        amount: 10_000 + i, vout: 0, prevTxid: i % 2 ? null : txid(Math.max(1, i - 1)),
        prevVout: i % 2 ? null : 0, recordId: i, scriptType: 'p2wpkh',
      },
      transactionMetadata: {
        id: i, txid: hash, acquisitionMethod: 'purchase', costBasisUsd: i / 100,
        estimatedCostBasisUsd: null, updatedAt: now - i,
      },
    };
    for (const [table, row] of Object.entries(rows)) {
      hashes[table].update(JSON.stringify(row));
      hashes[table].update('\n');
    }
  }
  return Object.fromEntries(
    Object.entries(hashes).map(([table, hash]) => [table, hash.digest('hex')]),
  );
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', timeout: 15 * 60_000 });
  if (result.status !== 0) throw new Error(`${TAG} failed: ${command} ${args.join(' ')}`);
}

function buildPackage() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} is missing`);
    assertPackagedBundleFresh({ root: ROOT, tag: TAG });
    assertPackagedAsarFresh({ root: ROOT, asarPath: ASAR, tag: TAG });
    return;
  }
  run('npm', ['run', 'build']);
  assertPackagedBundleFresh({ root: ROOT, tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', [
    'electron-builder',
    '--config',
    'electron-builder.json',
    '--dir',
    IS_WINDOWS ? '--win' : '--linux',
    ...(IS_WINDOWS ? [] : ['-c.npmRebuild=false']),
  ]);
}

async function rendererPage(browser) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => candidate.url().startsWith('kyutxo-app://bundle/'));
      if (page) return page;
    }
    await sleep(250);
  }
  throw new Error(`${TAG} renderer did not appear`);
}

async function seedSource(page, perTable) {
  return page.evaluate(async (count) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('KYUTXODatabase');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('could not open source IndexedDB'));
    });
    const tables = ['records', 'blockchainTransactions', 'transactionParticipants', 'transactionMetadata'];
    for (const name of tables) {
      if (!db.objectStoreNames.contains(name)) throw new Error(`source store missing: ${name}`);
    }
    const now = Date.now();
    const txid = (n) => n.toString(16).padStart(64, '0');
    for (const table of tables) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(table, 'readwrite');
        tx.objectStore(table).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error(`could not clear ${table}`));
        tx.onabort = () => reject(tx.error || new Error(`could not clear ${table}`));
      });
    }
    // Bounded source transactions avoid making the setup itself the measured
    // long task. Explicit IDs make engine/source fingerprints deterministic.
    for (let offset = 0; offset < count; offset += 500) {
      const tx = db.transaction(tables, 'readwrite');
      for (let i = offset + 1; i <= Math.min(count, offset + 500); i++) {
        const id = i;
        const hash = txid(i);
        tx.objectStore('records').put({ id, type: 'address', inputString: `bc1qtask229${String(i).padStart(32, '0')}`, label: `Task 229 address ${i}`, owner: 'Scale', walletName: 'Rebuild', addressImportance: i % 2 ? 'verified' : 'manual', createdAt: now - i, updatedAt: now - i, tags: ['task-229'], categories: ['scale'] });
        tx.objectStore('blockchainTransactions').put({ id, txid: hash, blockHeight: 840_000 + i, blockTime: 1_700_000_000 + i, fee: i, feeRate: 1.25, vsize: 140, hasOpReturn: 0 });
        tx.objectStore('transactionParticipants').put({ id, txid: hash, role: i % 2 ? 'output' : 'input', address: `bc1qtask229${String(i).padStart(32, '0')}`, amount: 10_000 + i, vout: 0, prevTxid: i % 2 ? null : txid(Math.max(1, i - 1)), prevVout: i % 2 ? null : 0, recordId: id, scriptType: 'p2wpkh' });
        tx.objectStore('transactionMetadata').put({ id, txid: hash, acquisitionMethod: 'purchase', costBasisUsd: i / 100, estimatedCostBasisUsd: null, updatedAt: now - i });
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('source batch failed'));
        tx.onabort = () => reject(tx.error || new Error('source batch aborted'));
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const counts = {};
    for (const table of tables) {
      counts[table] = await new Promise((resolve, reject) => {
        const request = db.transaction(table).objectStore(table).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    db.close();
    return { counts, now };
  }, perTable);
}

async function status(page) {
  return page.evaluate(() => window.electronAPI.engine.status());
}

async function navigateDiagnostics(page) {
  await page.evaluate(() => { window.location.hash = '/engine-diagnostics'; });
  await page.getByTestId('button-seed').waitFor({ state: 'visible', timeout: 60_000 });
}

async function waitForEngineSettled(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envelope = await status(page);
    const snapshot = envelope.result ?? envelope;
    if (snapshot.state === 'READY' || snapshot.state === 'EMPTY' || snapshot.state === 'ERROR') return snapshot;
    await sleep(100);
  }
  throw new Error(`${TAG} engine did not settle within ${timeoutMs}ms`);
}

async function cancelProbe(page) {
  await page.evaluate(() => window.electronAPI.engine.clear());
  await page.getByTestId('button-seed').click();
  await page.getByTestId('text-overall-progress').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="text-overall-progress"]')?.textContent || '';
    const processed = Number(text.split('/')[0]?.replaceAll(',', '').trim());
    return Number.isFinite(processed) && processed >= 1_000;
  }, undefined, { timeout: 30_000 });
  await page.getByTestId('button-cancel-seed').click();
  await page.getByText('Seed cancelled').waitFor({ state: 'visible', timeout: 60_000 });
  const snapshot = await status(page);
  assert.equal(snapshot.result?.state ?? snapshot.state, 'EMPTY', 'cancelled seed must clear partial mirror');
}

async function runMeasuredRebuild(page) {
  const deadline = Date.now() + MAX_ACCEPTABLE_REBUILD_MS;
  const timeline = await page.evaluate(() => {
    window.__task229 = { start: performance.now(), beats: [], progress: [], longtasks: [] };
    const state = window.__task229;
    state.observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) =>
      state.longtasks.push({ start: entry.startTime, duration: entry.duration })));
    state.observer.observe({ entryTypes: ['longtask'] });
    state.heartbeat = setInterval(() => state.beats.push(performance.now()), 50);
  });
  assert.ok(timeline === undefined, 'instrumentation should install in renderer');
  await page.getByTestId('button-seed').click();
  await page.getByTestId('text-overall-progress').waitFor({ state: 'visible', timeout: 30_000 });
  let last = '';
  while (await page.evaluate(() => Boolean(document.querySelector('[data-testid="button-cancel-seed"]')))) {
    if (Date.now() >= deadline) {
      throw new Error(`${TAG} rebuild exceeded the ${MAX_ACCEPTABLE_REBUILD_MS}ms deadline`);
    }
    const text = await page.getByTestId('text-overall-progress').textContent().catch(() => '');
    if (text && text !== last) {
      await page.evaluate((value) => window.__task229.progress.push({ at: performance.now(), value }), text);
      last = text;
    }
    await sleep(75);
  }
  await page.getByText('Seed complete').waitFor({ state: 'visible', timeout: 180_000 });
  return page.evaluate(() => {
    const state = window.__task229;
    clearInterval(state.heartbeat);
    state.observer.disconnect();
    const end = performance.now();
    return { durationMs: end - state.start, beats: state.beats, progress: state.progress, longtasks: state.longtasks };
  });
}

async function engineFingerprints(page) {
  return page.evaluate(async () => {
    const query = async (name) => {
      const envelope = await window.electronAPI.engine.query(name, null);
      if (!envelope?.ok) throw new Error(envelope?.error || `${name} failed`);
      return envelope.result;
    };
    return {
      records: await query('getRecordsFingerprint'),
      blockchainTransactions: await query('getTransactionsFingerprint'),
      transactionParticipants: await query('getParticipantsFingerprint'),
      transactionMetadata: await query('getTransactionMetadataFingerprint'),
    };
  });
}

async function stop(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

async function main() {
  buildPackage();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-task-229-'));
  const cdpDir = path.join(home, 'cdp-profile');
  const portable = IS_WINDOWS ? prepareWindowsPortableLaunch({ root: ROOT, asarPath: ASAR, home, tag: TAG }) : null;
  const binaries = IS_WINDOWS ? {} : findPackagedBinaries({ tag: TAG });
  const env = { ...(portable?.env || process.env), HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'), NODE_ENV: 'production' };
  const display = process.env.KYUTXO_PACKAGED_DISPLAY || ':109';
  const xvfb = IS_WINDOWS ? null : spawn(binaries.xvfbBin, [display, '-screen', '0', '1280x800x24'], { env, detached: true });
  if (xvfb) await sleep(2_000);
  let child; let browser; let cdp;
  const launch = () => spawn(IS_WINDOWS ? portable.executable : binaries.electronBin,
    IS_WINDOWS ? ['--disable-gpu', ...packagedCdpLaunchArgs(cdpDir)] : [ASAR, '--no-sandbox', '--disable-gpu', ...packagedCdpLaunchArgs(cdpDir)],
    {
      cwd: IS_WINDOWS ? portable.launchDir : home,
      env: IS_WINDOWS ? env : { ...env, DISPLAY: display },
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    child = launch();
    child.stdout.on('data', (data) => process.stdout.write(`${TAG}[app] ${data}`));
    child.stderr.on('data', (data) => process.stdout.write(`${TAG}[app-err] ${data}`));
    cdp = await waitForOwnedPackagedCdp({ userDataDir: cdpDir, timeoutMs: 90_000 });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    let page = await rendererPage(browser);
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log(`${TAG}[renderer-${message.type()}] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => console.log(`${TAG}[renderer-error] ${error.stack || error}`));
    try {
      await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, submitTimeoutMs: 60_000, label: 'task-229 protected vault' });
    } catch (error) {
      const visibleError = await page.getByTestId('text-error').textContent().catch(() => null);
      const bridgeState = await page.evaluate(async () => {
        const bridge = window.electronAPI?.protectedStore;
        if (!bridge) return { present: false };
        return { present: true, status: await bridge.status().catch((failure) => ({ thrown: String(failure) })) };
      }).catch((failure) => ({ diagnosticFailed: String(failure) }));
      throw new Error(`${error instanceof Error ? error.message : error}; visible=${visibleError}; bridge=${JSON.stringify(bridgeState)}`);
    }
    await completeFreshVaultOnboardingIfPresent(page, { label: TAG });
    await waitForEngineSettled(page);
    await navigateDiagnostics(page);
    const cancelSource = await seedSource(page, CANCEL_PER_TABLE);
    assert.deepEqual(cancelSource.counts, { records: CANCEL_PER_TABLE, blockchainTransactions: CANCEL_PER_TABLE, transactionParticipants: CANCEL_PER_TABLE, transactionMetadata: CANCEL_PER_TABLE });
    await cancelProbe(page);
    const sourceCounts = await seedSource(page, FULL_PER_TABLE);
    assert.equal(Object.values(sourceCounts.counts).reduce((a, b) => a + b, 0), 60_000);
    const measured = await runMeasuredRebuild(page);
    const final = await status(page);
    const snapshot = final.result ?? final;
    assert.equal(snapshot.state, 'READY');
    assert.equal(snapshot.ready, true);
    assert.deepEqual(snapshot.counts, sourceCounts.counts, 'completed mirror row counts drifted from the source');
    assert.equal(snapshot.seedMeta.length, 4, 'every mirrored table must have completion metadata');
    assert.ok(snapshot.seedMeta.every((row) => row.complete === 1), 'an incomplete table was marked ready');
    await page.getByTestId('button-integrity').click();
    const integrity = await page.getByTestId('text-integrity-result').textContent({ timeout: 60_000 });
    assert.equal(integrity?.trim(), 'ok', `packaged engine integrity check failed: ${integrity}`);
    const fingerprints = await engineFingerprints(page);
    const contentDigests = await page.evaluate(async () => {
      const envelope = await window.electronAPI.engine.query('getMirrorContentDigests', null);
      if (!envelope?.ok) throw new Error(envelope?.error || 'getMirrorContentDigests failed');
      return envelope.result;
    });
    assert.deepEqual(
      contentDigests,
      expectedContentDigests(FULL_PER_TABLE, sourceCounts.now),
      'packaged mirror content drifted from the canonical source mapping',
    );
    assert.deepEqual(fingerprints.records, {
      count: FULL_PER_TABLE,
      maxId: FULL_PER_TABLE,
      maxUpdatedAt: sourceCounts.now - 1,
    });
    assert.deepEqual(fingerprints.blockchainTransactions, {
      count: FULL_PER_TABLE,
      maxId: FULL_PER_TABLE,
      maxBlockTime: 1_700_000_000 + FULL_PER_TABLE,
    });
    assert.deepEqual(fingerprints.transactionParticipants, {
      count: FULL_PER_TABLE,
      maxId: FULL_PER_TABLE,
      resolvedPrevoutCount: FULL_PER_TABLE / 2,
    });
    assert.deepEqual(fingerprints.transactionMetadata, {
      count: FULL_PER_TABLE,
      maxId: FULL_PER_TABLE,
      maxUpdatedAt: sourceCounts.now - 1,
    });
    const maxLongtask = Math.max(0, ...measured.longtasks.map((entry) => entry.duration));
    const gaps = measured.beats.slice(1).map((beat, i) => beat - measured.beats[i]);
    const maxHeartbeatGap = Math.max(0, ...gaps);
    const progressGaps = measured.progress.slice(1).map((entry, i) => entry.at - measured.progress[i].at);
    const maxProgressGap = Math.max(0, ...progressGaps);
    assert.ok(measured.progress.length >= 8, 'expected streaming progress cadence across 60 batches');
    assert.ok(measured.beats.length >= 2, 'renderer heartbeat did not remain responsive during rebuild');
    assert.ok(measured.durationMs <= MAX_ACCEPTABLE_REBUILD_MS, `60,000-row rebuild took an unreasonable ${Math.round(measured.durationMs)}ms`);
    assert.ok(maxLongtask <= MAX_ACCEPTABLE_LONGTASK_MS, `longest renderer block ${Math.round(maxLongtask)}ms was not substantially below the legacy ${LEGACY_LONGTASK_MIN_MS}-${903}ms evidence`);
    assert.ok(maxHeartbeatGap <= MAX_ACCEPTABLE_HEARTBEAT_GAP_MS, `renderer heartbeat stalled for ${Math.round(maxHeartbeatGap)}ms`);
    assert.ok(maxProgressGap <= MAX_ACCEPTABLE_PROGRESS_GAP_MS, `visible progress stalled for ${Math.round(maxProgressGap)}ms`);
    console.log(`${TAG} BASELINE legacyBatch=10000 observedLongtaskRangeMs=${LEGACY_LONGTASK_MIN_MS}-903`);
    console.log(`${TAG} PASS rows=60000 state=${snapshot.state} integrity=${integrity.trim()} durationMs=${Math.round(measured.durationMs)} progressSamples=${measured.progress.length} progressMaxGapMs=${Math.round(maxProgressGap)} longtasks=${measured.longtasks.length} longtaskMaxMs=${Math.round(maxLongtask)} heartbeatMaxGapMs=${Math.round(maxHeartbeatGap)} fingerprints=${JSON.stringify(fingerprints)} contentDigests=${JSON.stringify(contentDigests)}`);
    const completedSeedMeta = structuredClone(snapshot.seedMeta);
    await browser.close(); browser = null; await stop(child); child = null;
    assert.ok(await waitForPackagedCdpDown(cdp.port, 30_000)); clearPackagedCdpOwnership(cdpDir);
    child = launch(); cdp = await waitForOwnedPackagedCdp({ userDataDir: cdpDir, timeoutMs: 90_000 });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`); page = await rendererPage(browser);
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, submitTimeoutMs: 60_000, label: 'task-229 unchanged relaunch' });
    const relaunchStates = [];
    const relaunchDeadline = Date.now() + 5_000;
    while (Date.now() < relaunchDeadline) {
      const envelope = await status(page);
      const observed = envelope.result ?? envelope;
      relaunchStates.push(observed.state);
      await sleep(50);
    }
    const relaunchedEnvelope = await status(page);
    const relaunched = relaunchedEnvelope.result ?? relaunchedEnvelope;
    assert.ok(!relaunchStates.includes('LOADING') && !relaunchStates.includes('INDEXING'), `unchanged launch rebuilt the mirror: ${relaunchStates.join(',')}`);
    assert.equal(relaunched.state, 'READY', 'unchanged vault relaunched with an unexpected rebuild');
    assert.equal(relaunched.ready, true);
    assert.deepEqual(
      relaunched.seedMeta,
      completedSeedMeta,
      'unchanged launch rewrote seed completion metadata',
    );
    console.log(`${TAG} PASS unchanged-vault relaunch remained READY without rebuild`);
  } finally {
    await browser?.close().catch(() => {});
    await stop(child);
    try { process.kill(-xvfb?.pid, 'SIGTERM'); } catch { xvfb?.kill?.('SIGTERM'); }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`${TAG} FAILED: ${error.stack || error}`); process.exitCode = 1; });