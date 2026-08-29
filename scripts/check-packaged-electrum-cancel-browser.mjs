#!/usr/bin/env node
// Packaged-desktop-app regression guard: cancelling an Electrum UTXO batch
// must cross the real preload -> main IPC boundary.
//
// The browser cancellation check uses a renderer shim, so it cannot catch a
// broken preload export or an IPC handler that fails to join the main-process
// cancel group. This check launches the actual electron-builder asar and
// points its real TCP client at a deliberately slow local Electrum fixture.
//
// The fixture accepts server.version, then leaves every
// blockchain.scripthash.listunspent request unresolved. The driver starts a
// 40-address batch with a bu- cancelId, waits until the main process has
// filled its pipeline, and calls electrumCancel through the real preload
// bridge. It proves that:
//   1. the batch reached the fixture with the bu- cancelId payload;
//   2. the main process accepted that exact cancelId and aborted in-flight
//      pooled requests;
//   3. the batch result contains cancellation failures rather than waiting for
//      the slow server; and
//   4. no queued listunspent work is dispatched after cancellation.
//
// Usage:
//   node scripts/check-packaged-electrum-cancel-browser.mjs
//   KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-electrum-cancel-browser.mjs
//
// The skip-build path intentionally reuses only a fresh asar. See
// .agents/memory/packaged-electron-verify.md for the Electron/Xvfb recipe.

import { chromium } from 'playwright-core';
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  assertPackagedBundleFresh,
  assertPackagedAsarFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';

await acquireBrowserCheckLock();

const require = createRequire(import.meta.url);
const bitcoin = require('bitcoinjs-lib');
const secp = require('@bitcoinerlab/secp256k1');
bitcoin.initEccLib(secp);

const ROOT = repoRootFromModuleUrl(import.meta.url);
const ASAR = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');
const CDP_PORT = Number(process.env.KYUTXO_PACKAGED_ELECTRUM_CDP_PORT || 9224);
const TAG = '[packaged-electrum-cancel]';
const PIPELINE_SIZE = 8;
const ADDRESS_COUNT = 40;
const CANCEL_ID = 'bu-packaged-cancel-check';
const BATCH_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, args, opts = {}) {
  console.log(`${TAG} $ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    throw new Error(`${TAG} command failed (exit ${result.status}): ${cmd} ${args.join(' ')}`);
  }
}

function buildAsar() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) {
      throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} does not exist.`);
    }
    console.log(`${TAG} reusing existing asar: ${ASAR}`);
    assertPackagedBundleFresh({ tag: TAG });
    assertPackagedAsarFresh({ tag: TAG, asarPath: ASAR });
    return;
  }

  // Keep this aligned with the packaged renderer gate. The native bundle is
  // rebuilt because electron-builder packages it alongside the renderer, even
  // though this check exercises only the Electrum IPC surface.
  run('npm', ['run', 'build']);
  assertPackagedBundleFresh({ tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', [
    'electron-builder',
    '--config',
    'electron-builder.json',
    '--dir',
    '--linux',
    '-c.npmRebuild=false',
  ]);
  if (!fs.existsSync(ASAR)) {
    throw new Error(`${TAG} electron-builder finished but ${ASAR} was not produced.`);
  }
}

function makeAddresses(count) {
  const addresses = [];
  for (let i = 0; i < count; i++) {
    let publicKey;
    do {
      const privateKey = crypto.randomBytes(32);
      publicKey = secp.isPrivate(privateKey)
        ? Buffer.from(secp.pointFromScalar(privateKey, true))
        : null;
    } while (!publicKey);
    addresses.push(bitcoin.payments.p2wpkh({
      pubkey: publicKey,
      network: bitcoin.networks.bitcoin,
    }).address);
  }
  return addresses;
}

function startSlowElectrumFixture() {
  const sockets = new Set();
  const rpcCalls = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        rpcCalls.push({
          id: request.id,
          method: request.method,
          at: Date.now(),
        });

        if (request.method === 'server.version') {
          socket.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: ['packaged-cancel-fixture', '1.4'],
          }) + '\n');
        } else if (request.method === 'server.ping') {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\n');
        }
        // Deliberately do not answer listunspent: cancellation must reject it
        // in the main process before the request timeout.
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error(`${TAG} fixture did not receive a TCP port`));
        return;
      }
      resolve({
        host: '127.0.0.1',
        port: address.port,
        rpcCalls,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) return true;
    } catch {
      /* not ready */
    }
    await sleep(500);
  }
  return false;
}

async function waitUntil(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`${TAG} timed out waiting for ${label}`);
}

async function main() {
  buildAsar();

  const { electronBin, xvfbBin } = findPackagedBinaries({ tag: TAG });
  console.log(`${TAG} electron: ${electronBin}`);
  console.log(`${TAG} Xvfb: ${xvfbBin}`);

  const fixture = await startSlowElectrumFixture();
  const addresses = makeAddresses(ADDRESS_COUNT);
  console.log(`${TAG} slow Electrum fixture listening on ${fixture.host}:${fixture.port}`);

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-electrum-cancel-'));
  const env = {
    ...process.env,
    HOME: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
    XDG_CACHE_HOME: path.join(tmpHome, '.cache'),
    XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(tmpHome, '.local', 'state'),
    NODE_ENV: 'production',
  };
  const display = process.env.KYUTXO_PACKAGED_DISPLAY || ':99';
  const xvfb = spawn(xvfbBin, [display, '-screen', '0', '1280x800x24'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  xvfb.stderr.on('data', (data) => process.stdout.write(`${TAG}[xvfb] ${data}`));
  await sleep(2_000);

  const appOutput = [];
  const child = spawn(
    electronBin,
    [ASAR, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: tmpHome,
      env: { ...env, DISPLAY: display },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  child.stdout.on('data', (data) => {
    const text = String(data);
    appOutput.push(text);
    process.stdout.write(`${TAG}[app] ${text}`);
  });
  child.stderr.on('data', (data) => {
    const text = String(data);
    appOutput.push(text);
    process.stdout.write(`${TAG}[app-err] ${text}`);
  });
  let appExited = false;
  child.on('exit', (code, signal) => {
    appExited = true;
    console.log(`${TAG} app process exited (code=${code} signal=${signal})`);
  });

  let browser = null;
  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    if (!(await waitForCdp(90_000))) {
      throw new Error(`${TAG} CDP endpoint never came up${appExited ? ' (app exited)' : ''}`);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    let page = null;
    const pageDeadline = Date.now() + 60_000;
    while (!page && Date.now() < pageDeadline) {
      for (const context of browser.contexts()) {
        for (const candidate of context.pages()) {
          if (candidate.url().startsWith('file://')) page = candidate;
        }
      }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error(`${TAG} no packaged file:// renderer appeared`);
    await page.waitForFunction(() => Boolean(window.electronAPI), null, { timeout: 60_000 });
    step('packaged renderer exposes the Electrum preload bridge', true);

    const batchPayload = {
      host: fixture.host,
      port: fixture.port,
      useSSL: false,
      addresses,
      timeout: BATCH_TIMEOUT_MS,
      cancelId: CANCEL_ID,
    };
    const batchPromise = page.evaluate(
      (payload) => window.electronAPI.electrumBatchGetUtxos(payload),
      batchPayload,
    );

    await waitUntil(
      `the fixture to receive ${PIPELINE_SIZE} in-flight listunspent calls`,
      () => fixture.rpcCalls.filter((call) => call.method === 'blockchain.scripthash.listunspent').length >= PIPELINE_SIZE,
      15_000,
    );
    const listunspentAtCancel = fixture.rpcCalls.filter(
      (call) => call.method === 'blockchain.scripthash.listunspent',
    ).length;
    const batchCallHasBuCancelId = batchPayload.cancelId.startsWith('bu-');
    step(
      'in-flight UTXO batch uses a bu- cancelId',
      batchCallHasBuCancelId,
      `cancelId=${batchPayload.cancelId}`,
    );

    const cancelResponse = await page.evaluate(
      (cancelId) => window.electronAPI.electrumCancel({ cancelId }),
      CANCEL_ID,
    );
    step(
      'main process accepts the exact batch cancelId and aborts requests',
      cancelResponse?.success === true && Number(cancelResponse.aborted) >= 1,
      `response=${JSON.stringify(cancelResponse)}`,
    );

    const batchResponse = await batchPromise;
    const cancelledEntries = Array.isArray(batchResponse?.results)
      ? batchResponse.results.filter(
        (entry) => entry && entry.success === false && /cancel/i.test(String(entry.error)),
      )
      : [];
    step(
      'in-flight batch settles promptly with cancellation failures',
      batchResponse?.success === true && cancelledEntries.length === ADDRESS_COUNT,
      `success=${batchResponse?.success} cancelled=${cancelledEntries.length}/${ADDRESS_COUNT}`,
    );

    await waitUntil(
      'the main process to log rejection of a listunspent request',
      () => appOutput.join('').includes('Request cancelled') &&
        appOutput.join('').includes('blockchain.scripthash.listunspent'),
      10_000,
    );
    step(
      'main process rejects the in-flight listunspent request',
      true,
      'cancellation rejection was logged by the real Electron main process',
    );

    await sleep(1_500);
    const listunspentAfterSettle = fixture.rpcCalls.filter(
      (call) => call.method === 'blockchain.scripthash.listunspent',
    ).length;
    step(
      'no later listunspent calls are dispatched after Cancel',
      listunspentAfterSettle === listunspentAtCancel,
      `atCancel=${listunspentAtCancel} afterSettle=${listunspentAfterSettle}`,
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    await sleep(2_000);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    try {
      process.kill(-xvfb.pid, 'SIGTERM');
    } catch {
      try { xvfb.kill('SIGTERM'); } catch { /* already gone */ }
    }
    await fixture.close().catch(() => {});
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  const failed = steps.filter((entry) => !entry.passed);
  if (failed.length) {
    console.error(`${TAG} ${failed.length}/${steps.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`${TAG} all ${steps.length} checks passed`);
}

main().catch((error) => {
  console.error(`${TAG} FAILED:`, error);
  process.exit(1);
});