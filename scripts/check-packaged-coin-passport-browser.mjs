#!/usr/bin/env node
// Packaged-desktop release gate for oversized Coin Passport windows.
//
// Renderer and native unit tests cover the paging math, but they do not prove
// that the shipping preload -> main process -> packaged worker path preserves
// the request and response shapes. This check launches the real electron-builder
// asar, seeds a deliberately oversized consolidation through the real engine
// bridge, and verifies independent holdings, outpoint, allocation, and hop
// windows plus checkpoint invalidation.
//
// Usage:
//   node scripts/check-packaged-coin-passport-browser.mjs
//   KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-coin-passport-browser.mjs

import { chromium } from 'playwright-core';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  assertPackagedAsarFresh,
  assertPackagedBundleFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';
import { prepareWindowsPortableLaunch } from './packaged-windows-portable.mjs';

await acquireBrowserCheckLock();

const ROOT = repoRootFromModuleUrl(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const UNPACKED_DIR = path.join(ROOT, 'release', IS_WINDOWS ? 'win-unpacked' : 'linux-unpacked');
const ASAR = path.join(UNPACKED_DIR, 'resources', 'app.asar');
const PACKAGED_EXECUTABLE = path.join(UNPACKED_DIR, IS_WINDOWS ? 'KYUTXO.exe' : 'kyutxo');
const CDP_PORT = Number(process.env.KYUTXO_PACKAGED_PASSPORT_CDP_PORT || 9226);
const TAG = '[packaged-coin-passport]';
const UI_PAGE_SIZE = 100;
const IPC_PAGE_CAP = 250;
const CONSOLIDATED_ORIGINS = 301;
const EXTRA_OUTPOINTS = 300;
const BUILD_COMMAND_TIMEOUT_MS = 15 * 60_000;
const TASKKILL_TIMEOUT_MS = 15_000;
const CONSOLIDATION_TXID = 'f'.repeat(64);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', timeout: BUILD_COMMAND_TIMEOUT_MS });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    throw new Error(`${TAG} timed out during package build command ${command} after ${BUILD_COMMAND_TIMEOUT_MS}ms`);
  }
  if (result.status !== 0) {
    throw new Error(`${TAG} command failed (exit ${result.status}): ${command}`);
  }
}

function buildPackage() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) {
      throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} is missing`);
    }
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
    IS_WINDOWS ? '--win' : '--linux',
  ]);
  if (!fs.existsSync(ASAR)) {
    throw new Error(`${TAG} packaging produced no ${ASAR}`);
  }
}

function fixtureTxid(index) {
  return index.toString(16).padStart(64, '0');
}

function buildFixture(includeCheckpointMutation = false) {
  const sourceAddress = 'bc1qpackagedpassportorigins';
  const extraAddress = 'bc1qpackagedpassportoutpoints';
  const targetAddress = 'bc1qpackagedpassportconsolidation';
  const records = [
    {
      id: 1,
      type: 'address',
      inputString: sourceAddress,
      inputStringLower: sourceAddress,
      label: 'Packaged origins',
      walletName: 'Packaged Passport',
      addressImportance: 'manual',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 2,
      type: 'address',
      inputString: extraAddress,
      inputStringLower: extraAddress,
      label: 'Packaged outpoints',
      walletName: 'Packaged Passport',
      addressImportance: 'manual',
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: 3,
      type: 'address',
      inputString: targetAddress,
      inputStringLower: targetAddress,
      label: 'Oversized consolidation',
      walletName: 'Packaged Passport',
      addressImportance: 'manual',
      createdAt: 3,
      updatedAt: 3,
    },
  ];
  if (includeCheckpointMutation) {
    records.push({
      id: 4,
      type: 'address',
      inputString: 'bc1qpackagedcheckpointmutation',
      inputStringLower: 'bc1qpackagedcheckpointmutation',
      label: 'Checkpoint mutation',
      walletName: 'Packaged Passport',
      addressImportance: 'manual',
      createdAt: 4,
      updatedAt: 4,
    });
  }

  const transactions = [];
  const transactionParticipants = [];
  let participantId = 1;
  const consolidatedTxids = [];

  for (let index = 0; index < CONSOLIDATED_ORIGINS; index += 1) {
    const txid = fixtureTxid(index + 1);
    consolidatedTxids.push(txid);
    transactions.push({
      id: index + 1,
      txid,
      blockHeight: index + 1,
      blockTime: 1_700_000_000 + index,
      fee: 0,
    });
    transactionParticipants.push({
      id: participantId++,
      txid,
      role: 'output',
      address: sourceAddress,
      amount: 1_000,
      vout: 0,
      recordId: 1,
      scriptType: 'v0_p2wpkh',
    });
  }

  for (let index = 0; index < EXTRA_OUTPOINTS; index += 1) {
    const txid = fixtureTxid(CONSOLIDATED_ORIGINS + index + 1);
    transactions.push({
      id: CONSOLIDATED_ORIGINS + index + 1,
      txid,
      blockHeight: CONSOLIDATED_ORIGINS + index + 1,
      blockTime: 1_700_001_000 + index,
      fee: 0,
    });
    transactionParticipants.push({
      id: participantId++,
      txid,
      role: 'output',
      address: extraAddress,
      amount: 500,
      vout: 0,
      recordId: 2,
      scriptType: 'v0_p2wpkh',
    });
  }

  transactions.push({
    id: CONSOLIDATED_ORIGINS + EXTRA_OUTPOINTS + 1,
    txid: CONSOLIDATION_TXID,
    blockHeight: CONSOLIDATED_ORIGINS + EXTRA_OUTPOINTS + 1,
    blockTime: 1_700_002_000,
    fee: 0,
  });
  for (const prevTxid of consolidatedTxids) {
    transactionParticipants.push({
      id: participantId++,
      txid: CONSOLIDATION_TXID,
      role: 'input',
      address: sourceAddress,
      amount: 1_000,
      prevTxid,
      prevVout: 0,
      recordId: 1,
      scriptType: 'v0_p2wpkh',
    });
  }
  transactionParticipants.push({
    id: participantId++,
    txid: CONSOLIDATION_TXID,
    role: 'output',
    address: targetAddress,
    amount: CONSOLIDATED_ORIGINS * 1_000,
    vout: 0,
    recordId: 3,
    scriptType: 'v0_p2wpkh',
  });

  return { records, transactions, transactionParticipants };
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) return;
    } catch {
      // The packaged app can take several seconds to expose CDP.
    }
    await sleep(250);
  }
  throw new Error(`${TAG} packaged Electron CDP endpoint did not start`);
}

async function waitForPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => candidate.url().startsWith('kyutxo-app://bundle/'));
      if (page) return page;
    }
    await sleep(250);
  }
  throw new Error(`${TAG} packaged renderer page did not start`);
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { timeout: TASKKILL_TIMEOUT_MS });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill?.('SIGTERM');
  }
}

function firstHoldingId(page) {
  return page.holdings[0]?.lotId;
}

function firstOutpointId(page) {
  const row = page.outpoints[0];
  return row ? `${row.txid}:${row.vout}` : undefined;
}

function firstAllocationId(page) {
  return page.outpoints[0]?.allocations[0]?.lotId;
}

function firstHopId(page) {
  return page.outpoints[0]?.hopTxids[0];
}

function assert(condition, message) {
  if (!condition) throw new Error(`${TAG} ${message}`);
  console.log(`${TAG} PASS ${message}`);
}

async function main() {
  buildPackage();
  const binaries = IS_WINDOWS ? { electronBin: null, xvfbBin: null } : findPackagedBinaries({ tag: TAG });
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-passport-'));
  const portableSetup = IS_WINDOWS ? prepareWindowsPortableLaunch({
    root: ROOT, asarPath: ASAR, home: tempHome, tag: TAG,
  }) : null;
  const display = `:${500 + (process.pid % 300)}`;
  let xvfb;
  let child;
  let browser;

  try {
    if (!IS_WINDOWS) {
      xvfb = spawn(binaries.xvfbBin, [display, '-screen', '0', '1280x800x24'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      xvfb.stderr.on('data', (chunk) => process.stdout.write(`${TAG}[xvfb] ${chunk}`));
      await sleep(2_000);
    }

    const env = {
      ...(portableSetup?.env || process.env),
      HOME: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_CACHE_HOME: path.join(tempHome, '.cache'),
      XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
      APPDATA: tempHome,
      LOCALAPPDATA: tempHome,
      NODE_ENV: 'production',
    };
    let launchExecutable = PACKAGED_EXECUTABLE;
    if (IS_WINDOWS) {
      launchExecutable = portableSetup.executable;
      console.log(`${TAG} portable launch copy: ${launchExecutable}`);
    }
    child = spawn(launchExecutable, [`--remote-debugging-port=${CDP_PORT}`], {
      cwd: IS_WINDOWS ? portableSetup.launchDir : tempHome,
      env: IS_WINDOWS ? env : { ...env, DISPLAY: display },
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => process.stdout.write(`${TAG}[app] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stdout.write(`${TAG}[app-err] ${chunk}`));

    await waitForCdp(90_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const page = await waitForPage(browser);
    await page.waitForFunction(() => Boolean(window.electronAPI?.engine), null, { timeout: 60_000 });

    const fixture = buildFixture();
    const pages = await page.evaluate(async ({ fixture, pageSize, cap, outpoint }) => {
      const engine = window.electronAPI.engine;
      const unwrap = (envelope, label) => {
        if (!envelope?.ok) throw new Error(`${label}: ${envelope?.error || 'missing engine envelope'}`);
        return envelope.result;
      };
      const seed = async (data) => {
        unwrap(await engine.init(), 'init');
        unwrap(await engine.seedBegin(), 'seedBegin');
        unwrap(await engine.seedBatch('records', data.records), 'seed records');
        unwrap(await engine.seedBatch('blockchainTransactions', data.transactions), 'seed transactions');
        unwrap(await engine.seedBatch('transactionParticipants', data.transactionParticipants), 'seed participants');
        return unwrap(await engine.seedFinish({
          records: data.records.length,
          blockchainTransactions: data.transactions.length,
          transactionParticipants: data.transactionParticipants.length,
        }), 'seedFinish');
      };
      const query = async (args) => unwrap(
        await engine.query('getCoinOriginsPage', args),
        'getCoinOriginsPage',
      );

      const seeded = await seed(fixture);
      const broad = await query({ holdingsOffset: 0, outpointsOffset: 0, limit: pageSize });
      const holdingsNext = await query({
        holdingsOffset: pageSize,
        outpointsOffset: 0,
        limit: pageSize,
      });
      const outpointsNext = await query({
        holdingsOffset: 0,
        outpointsOffset: pageSize,
        limit: pageSize,
      });
      const detail = await query({
        outpoint,
        expectedCheckpointKey: broad.checkpointKey,
        allocationsOffset: 0,
        hopsOffset: 0,
        limit: pageSize,
      });
      const allocationsNext = await query({
        outpoint,
        expectedCheckpointKey: broad.checkpointKey,
        allocationsOffset: pageSize,
        hopsOffset: 0,
        limit: pageSize,
      });
      const hopsNext = await query({
        outpoint,
        expectedCheckpointKey: broad.checkpointKey,
        allocationsOffset: 0,
        hopsOffset: pageSize,
        limit: pageSize,
      });
      const cappedBroad = await query({ limit: cap + 999 });
      const cappedDetail = await query({
        outpoint,
        expectedCheckpointKey: broad.checkpointKey,
        limit: cap + 999,
      });
      return {
        seeded,
        broad,
        holdingsNext,
        outpointsNext,
        detail,
        allocationsNext,
        hopsNext,
        cappedBroad,
        cappedDetail,
      };
    }, {
      fixture,
      pageSize: UI_PAGE_SIZE,
      cap: IPC_PAGE_CAP,
      outpoint: `${CONSOLIDATION_TXID}:0`,
    });

    assert(pages.seeded?.state === 'READY', 'packaged worker finalizes the oversized fixture');
    assert(
      pages.broad.holdingsTotal > UI_PAGE_SIZE && pages.broad.outpointsTotal > UI_PAGE_SIZE,
      'fixture exceeds one holdings page and one outpoints page',
    );
    assert(
      pages.detail.detail?.allocationsTotal === CONSOLIDATED_ORIGINS &&
        pages.detail.detail?.hopsTotal === CONSOLIDATED_ORIGINS + 1,
      'consolidation exceeds one origin page and one hop page',
    );
    assert(
      pages.holdingsNext.holdingsOffset === UI_PAGE_SIZE &&
        firstHoldingId(pages.holdingsNext) !== firstHoldingId(pages.broad) &&
        firstOutpointId(pages.holdingsNext) === firstOutpointId(pages.broad),
      'holdings advance without moving the outpoint window',
    );
    assert(
      pages.outpointsNext.outpointsOffset === UI_PAGE_SIZE &&
        firstOutpointId(pages.outpointsNext) !== firstOutpointId(pages.broad) &&
        firstHoldingId(pages.outpointsNext) === firstHoldingId(pages.broad),
      'outpoints advance without moving the holdings window',
    );
    assert(
      pages.allocationsNext.detail?.allocationsOffset === UI_PAGE_SIZE &&
        firstAllocationId(pages.allocationsNext) !== firstAllocationId(pages.detail) &&
        firstHopId(pages.allocationsNext) === firstHopId(pages.detail),
      'passport origins advance without moving the hop window',
    );
    assert(
      pages.hopsNext.detail?.hopsOffset === UI_PAGE_SIZE &&
        firstHopId(pages.hopsNext) !== firstHopId(pages.detail) &&
        firstAllocationId(pages.hopsNext) === firstAllocationId(pages.detail),
      'passport hops advance without moving the origin window',
    );
    assert(
      pages.cappedBroad.holdings.length === IPC_PAGE_CAP &&
        pages.cappedBroad.outpoints.length === IPC_PAGE_CAP &&
        pages.cappedDetail.outpoints[0].allocations.length === IPC_PAGE_CAP &&
        pages.cappedDetail.outpoints[0].hopTxids.length === IPC_PAGE_CAP &&
        pages.cappedDetail.holdings.length === IPC_PAGE_CAP &&
        pages.cappedDetail.detail.lots.length === IPC_PAGE_CAP &&
        pages.cappedDetail.detail.hops.length === IPC_PAGE_CAP,
      `IPC responses remain capped at ${IPC_PAGE_CAP} rows per window`,
    );

    const stale = await page.evaluate(async ({ fixture, checkpointKey, outpoint }) => {
      const engine = window.electronAPI.engine;
      const unwrap = (envelope, label) => {
        if (!envelope?.ok) throw new Error(`${label}: ${envelope?.error || 'missing engine envelope'}`);
        return envelope.result;
      };
      unwrap(await engine.seedBegin(), 'seedBegin');
      unwrap(await engine.seedBatch('records', fixture.records), 'seed records');
      unwrap(await engine.seedBatch('blockchainTransactions', fixture.transactions), 'seed transactions');
      unwrap(await engine.seedBatch('transactionParticipants', fixture.transactionParticipants), 'seed participants');
      unwrap(await engine.seedFinish({
        records: fixture.records.length,
        blockchainTransactions: fixture.transactions.length,
        transactionParticipants: fixture.transactionParticipants.length,
      }), 'seedFinish');
      return engine.query('getCoinOriginsPage', {
        outpoint,
        expectedCheckpointKey: checkpointKey,
        limit: 100,
      });
    }, {
      fixture: buildFixture(true),
      checkpointKey: pages.broad.checkpointKey,
      outpoint: `${CONSOLIDATION_TXID}:0`,
    });
    assert(
      stale?.ok === false && typeof stale.error === 'string' && stale.error.length > 0,
      'changed mirror checkpoint rejects stale passport detail over packaged IPC',
    );

    console.log(`${TAG} all packaged Coin Passport paging checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    killTree(child);
    try {
      process.kill(-xvfb?.pid, 'SIGTERM');
    } catch {
      xvfb?.kill?.('SIGTERM');
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${TAG} FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});