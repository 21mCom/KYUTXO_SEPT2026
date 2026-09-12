#!/usr/bin/env node
// Packaged-desktop regression gate for the protected-vault ownership review.
//
// This drives the real packaged renderer and protected repository through a
// disposable profile. It covers review confirmation, normalized-wallet
// cascading, undo, rejected-evidence persistence, and Privacy Audit ownership
// findings without replacing the preload bridge or storage implementation.

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';
import {
  assertPackagedAsarFresh,
  assertPackagedBundleFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import {
  clearPackagedCdpOwnership,
  packagedCdpLaunchArgs,
  waitForOwnedPackagedCdp,
  waitForPackagedCdpDown,
} from './packaged-cdp.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';
import { prepareWindowsPortableLaunch } from './packaged-windows-portable.mjs';

await acquireBrowserCheckLock();

const ROOT = repoRootFromModuleUrl(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const UNPACKED_DIR = path.join(ROOT, 'release', IS_WINDOWS ? 'win-unpacked' : 'linux-unpacked');
const ASAR = path.join(UNPACKED_DIR, 'resources', 'app.asar');
const TAG = '[packaged-ownership-review]';
const PASSWORD = 'PackagedOwnershipReview#2026';
const BUILD_TIMEOUT_MS = 15 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ALICE_KNOWN = 'bc1qownershipaliceknown000000000000001';
const ALICE_REVIEW = 'bc1qownershipalicereview00000000000002';
const WALLET_KNOWN = 'bc1qownershipwalletknown00000000000003';
const WALLET_REVIEW_A = 'bc1qownershipwalletreviewa000000000004';
const WALLET_REVIEW_B = 'bc1qownershipwalletreviewb000000000005';
const REJECT_REVIEW = 'bc1qownershiprejectreview0000000000006';
const BOB_KNOWN = 'bc1qownershipbobknown00000000000000007';
const UNKNOWN = 'bc1qownershipunknown000000000000000008';
const CONFIRMED_TX = 'aa'.repeat(32);
const UNKNOWN_TX = 'bb'.repeat(32);

function run(command, args) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    throw new Error(`${TAG} timed out during ${command}`);
  }
  if (result.status !== 0) throw new Error(`${TAG} command failed: ${command}`);
}

function buildPackage() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) throw new Error(`${TAG} skip-build requested but ${ASAR} is missing`);
    assertPackagedBundleFresh({ root: ROOT, tag: TAG });
    assertPackagedAsarFresh({ root: ROOT, asarPath: ASAR, tag: TAG });
    return;
  }
  run('npm', ['run', 'build']);
  assertPackagedBundleFresh({ root: ROOT, tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', [
    'electron-builder', '--config', 'electron-builder.json',
    ...(IS_WINDOWS ? ['--win'] : ['--dir', '--linux', '-c.npmRebuild=false']),
  ]);
  if (!fs.existsSync(ASAR)) throw new Error(`${TAG} packaging produced no ${ASAR}`);
}

async function rendererPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => candidate.url().startsWith('kyutxo-app://bundle/'));
      if (page) return page;
    }
    await sleep(250);
  }
  throw new Error(`${TAG} packaged renderer did not appear`);
}

async function stop(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15_000 });
    return;
  }
  try { child.kill('SIGTERM'); } catch {}
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

function fixture() {
  const now = 1_750_000_000_000;
  const record = (id, inputString, label, extra = {}) => ({
    id, type: 'address', inputString, inputStringLower: inputString.toLowerCase(),
    label, tags: [], categories: [], addressImportance: 'manual',
    cachedBalanceSats: id * 10_000, createdAt: now + id, updatedAt: now + id, ...extra,
  });
  const ownership = (id, recordId, state, extra = {}) => ({
    id, recordId, state, createdAt: now + id, updatedAt: now + id, ...extra,
  });
  return {
    entities: [
      { id: 1, naturalKey: 'person:alice', name: 'Alice', kind: 'person', createdAt: now, updatedAt: now },
      { id: 2, naturalKey: 'person:bob', name: 'Bob', kind: 'person', createdAt: now, updatedAt: now },
    ],
    wallets: [
      { id: 30, naturalKey: 'review wallet|alice', name: 'Review wallet', entityId: 1, createdAt: now, updatedAt: now },
    ],
    records: [
      record(1, ALICE_KNOWN, 'Alice known source'),
      record(2, ALICE_REVIEW, 'Single assignment candidate', { discoveredFromRecordId: 1, discoveredInTxid: 'propagation-single' }),
      record(3, WALLET_KNOWN, 'Wallet known source'),
      record(4, WALLET_REVIEW_A, 'Wallet cascade candidate', { discoveredFromRecordId: 3, discoveredInTxid: 'propagation-wallet' }),
      record(5, WALLET_REVIEW_B, 'Wallet cascade sibling'),
      record(6, REJECT_REVIEW, 'Persistent rejection candidate', { discoveredFromRecordId: 7, discoveredInTxid: 'propagation-reject' }),
      record(7, BOB_KNOWN, 'Bob known source'),
      record(8, UNKNOWN, 'Unknown ownership participant'),
    ],
    addressOwnership: [
      ownership(1, 1, 'assigned', { entityId: 1 }),
      ownership(2, 2, 'undetermined'),
      ownership(3, 3, 'assigned', { entityId: 1, walletId: 30 }),
      ownership(4, 4, 'undetermined', { walletId: 30 }),
      ownership(5, 5, 'ours-owner-unknown', { walletId: 30 }),
      ownership(6, 6, 'undetermined'),
      ownership(7, 7, 'assigned', { entityId: 2 }),
      ownership(8, 8, 'undetermined'),
    ],
    blockchainTransactions: [
      { id: 1, txid: CONFIRMED_TX, blockHeight: 100, blockTime: 1_750_000_001, fee: 100, feeRate: 1, vsize: 100, syncedAt: now },
      { id: 2, txid: UNKNOWN_TX, blockHeight: 101, blockTime: 1_750_000_002, fee: 100, feeRate: 1, vsize: 100, syncedAt: now },
    ],
    transactionParticipants: [
      { id: 1, txid: CONFIRMED_TX, role: 'input', address: ALICE_REVIEW, amount: 20_000, recordId: 2 },
      { id: 2, txid: CONFIRMED_TX, role: 'input', address: BOB_KNOWN, amount: 70_000, recordId: 7 },
      { id: 3, txid: CONFIRMED_TX, role: 'output', address: 'bc1qconfirmedrecipient000000000000000', amount: 89_900 },
      { id: 4, txid: UNKNOWN_TX, role: 'input', address: ALICE_REVIEW, amount: 20_000, recordId: 2 },
      { id: 5, txid: UNKNOWN_TX, role: 'input', address: UNKNOWN, amount: 80_000, recordId: 8 },
      { id: 6, txid: UNKNOWN_TX, role: 'output', address: 'bc1qunknownrecipient00000000000000000', amount: 99_900 },
    ],
  };
}

async function seed(page) {
  return page.evaluate(async (data) => {
    const { getVaultRepository } = await import('/src/lib/repository/index.ts');
    const repository = getVaultRepository();
    for (const [table, rows] of Object.entries(data)) await repository.bulkPut(table, rows);
    return {
      kind: repository.kind,
      counts: Object.fromEntries(await Promise.all(
        Object.keys(data).map(async (table) => [table, await repository.count(table)]),
      )),
    };
  }, fixture());
}

async function ownershipState(page) {
  return page.evaluate(async () => {
    const { getVaultRepository } = await import('/src/lib/repository/index.ts');
    const repository = getVaultRepository();
    const collect = async (table) => {
      const result = [];
      let cursor;
      do {
        const page = await repository.list(table, { cursor, limit: 1000 });
        result.push(...page.rows);
        cursor = page.cursor;
      } while (cursor !== undefined);
      return result;
    };
    return {
      kind: repository.kind,
      ownership: (await collect('addressOwnership')).map(({ recordId, state, entityId, walletId }) => ({
        recordId, state, entityId: entityId ?? null, walletId: walletId ?? null,
      })),
      decisions: (await collect('ownershipReviewDecisions')).map(({ evidenceFingerprint, state, action, recordIds, undoToken }) => ({
        evidenceFingerprint, state, action, recordIds, undoToken,
      })),
    };
  });
}

async function changeRejectedEvidence(page) {
  return page.evaluate(async ({ recordId, discoveredInTxid }) => {
    const { getVaultRepository } = await import('/src/lib/repository/index.ts');
    const repository = getVaultRepository();
    const record = await repository.get('records', recordId);
    if (!record) throw new Error(`Missing ownership evidence record ${recordId}`);
    await repository.put('records', {
      ...record,
      discoveredInTxid,
      updatedAt: record.updatedAt + 1,
    });
    return { discoveredInTxid };
  }, { recordId: 6, discoveredInTxid: 'propagation-reject-materially-changed' });
}

async function waitForOwnershipRows(page, expected) {
  await page.waitForFunction(
    async (rows) => {
      const { getVaultRepository } = await import('/src/lib/repository/index.ts');
      const repository = getVaultRepository();
      const result = [];
      let cursor;
      do {
        const page = await repository.list('addressOwnership', { cursor, limit: 1000 });
        result.push(...page.rows);
        cursor = page.cursor;
      } while (cursor !== undefined);
      return rows.every((expectedRow) => {
        const actual = result.find((row) => row.recordId === expectedRow.recordId);
        return actual?.state === expectedRow.state &&
          (actual.entityId ?? null) === expectedRow.entityId &&
          (actual.walletId ?? null) === expectedRow.walletId;
      });
    },
    expected,
    { timeout: 30_000 },
  );
}

async function main() {
  buildPackage();
  let electronBin;
  let xvfbBin;
  if (!IS_WINDOWS) ({ electronBin, xvfbBin } = findPackagedBinaries({ tag: TAG }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-ownership-'));
  const cdpUserDataDir = path.join(home, 'cdp-profile');
  const portable = IS_WINDOWS ? prepareWindowsPortableLaunch({ root: ROOT, asarPath: ASAR, home, tag: TAG }) : null;
  const env = {
    ...(portable?.env || process.env), HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), APPDATA: home, LOCALAPPDATA: home,
    NODE_ENV: 'production',
  };
  const display = `:${700 + (process.pid % 200)}`;
  const executable = IS_WINDOWS ? portable.executable : electronBin;
  let xvfb;
  let child;
  let browser;
  const launch = () => {
    child = spawn(
      executable,
      IS_WINDOWS
        ? ['--disable-gpu', ...packagedCdpLaunchArgs(cdpUserDataDir)]
        : [ASAR, '--no-sandbox', '--disable-gpu', ...packagedCdpLaunchArgs(cdpUserDataDir)],
      {
        cwd: IS_WINDOWS ? portable.launchDir : home,
        env: IS_WINDOWS ? env : { ...env, DISPLAY: display },
        detached: !IS_WINDOWS, stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (data) => process.stdout.write(`${TAG}[app] ${data}`));
    child.stderr.on('data', (data) => process.stdout.write(`${TAG}[app-err] ${data}`));
  };

  try {
    if (!IS_WINDOWS) {
      xvfb = spawn(xvfbBin, [display, '-screen', '0', '1280x800x24'], {
        env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      await sleep(2_000);
    }
    launch();
    let cdp = await waitForOwnedPackagedCdp({
      userDataDir: cdpUserDataDir,
      timeoutMs: 90_000,
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    let page = await rendererPage(browser);
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log(`${TAG}[renderer-${message.type()}] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => console.log(`${TAG}[renderer-error] ${error.stack || error}`));
    try {
      await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, label: 'packaged-ownership-setup' });
    } catch (error) {
      const visibleError = await page.getByTestId('text-error').textContent().catch(() => null);
      const bridgeState = await page.evaluate(async () => {
        const bridge = window.electronAPI?.protectedStore;
        if (!bridge) return { present: false };
        return {
          present: true,
          status: await bridge.status().catch((failure) => ({ thrown: String(failure) })),
        };
      }).catch((failure) => ({ diagnosticFailed: String(failure) }));
      throw new Error(`${error instanceof Error ? error.message : error}; visible=${visibleError}; bridge=${JSON.stringify(bridgeState)}`);
    }
    await completeFreshVaultOnboardingIfPresent(page, { label: 'packaged-ownership-setup' });

    const seeded = await seed(page);
    assert.equal(seeded.kind, 'protected', 'fixture uses the packaged protected repository');
    assert.deepEqual(seeded.counts, {
      entities: 2, wallets: 1, records: 8, addressOwnership: 8,
      blockchainTransactions: 2, transactionParticipants: 6,
    });

    await page.goto('kyutxo-app://bundle/#/resolve-ownership');
    await page.getByTestId('ownership-resolution-page').waitFor({ state: 'visible' });
    await page.getByTestId('button-ownership-assign-2').click();
    await page.getByTestId('ownership-suggestion-2').waitFor({ state: 'detached' });
    await waitForOwnershipRows(page, [
      { recordId: 2, state: 'assigned', entityId: 1, walletId: null },
    ]);

    await page.getByTestId('button-ownership-wallet-4').click();
    await page.getByText('Assign normalized wallet addresses?').waitFor();
    await page.getByTestId('button-ownership-confirm-action').click();
    await page.getByTestId('ownership-suggestion-4').waitFor({ state: 'detached' });
    await waitForOwnershipRows(page, [
      { recordId: 4, state: 'assigned', entityId: 1, walletId: 30 },
      { recordId: 5, state: 'assigned', entityId: 1, walletId: 30 },
    ]);
    let state = await ownershipState(page);
    assert.deepEqual(
      state.ownership.filter((row) => row.recordId === 4 || row.recordId === 5),
      [
        { recordId: 4, state: 'assigned', entityId: 1, walletId: 30 },
        { recordId: 5, state: 'assigned', entityId: 1, walletId: 30 },
      ],
      'confirmed wallet cascade assigns every unresolved address in the normalized wallet',
    );

    await page.getByTestId('button-ownership-undo').click();
    await waitForOwnershipRows(page, [
      { recordId: 4, state: 'undetermined', entityId: null, walletId: 30 },
      { recordId: 5, state: 'ours-owner-unknown', entityId: null, walletId: 30 },
    ]);
    state = await ownershipState(page);
    assert.deepEqual(
      state.ownership.filter((row) => row.recordId === 4 || row.recordId === 5),
      [
        { recordId: 4, state: 'undetermined', entityId: null, walletId: 30 },
        { recordId: 5, state: 'ours-owner-unknown', entityId: null, walletId: 30 },
      ],
      'undo restores the exact pre-cascade ownership states',
    );

    await page.getByTestId('button-ownership-inspect-6').click();
    const rejectedEvidenceText = await page.getByTestId('ownership-evidence-6').innerText();
    const rejectedFingerprint = rejectedEvidenceText.match(/ownership-v1:[0-9a-f]{8}/)?.[0];
    assert.ok(rejectedFingerprint, 'rejected suggestion exposes its evidence fingerprint');
    await page.getByTestId('button-ownership-reject-6').click();
    await page.getByText('Suggestion rejected').first().waitFor();
    await page.getByTestId('ownership-suggestion-6').waitFor({ state: 'detached' });

    await browser.close();
    browser = null;
    await stop(child);
    child = null;
    assert.equal(
      await waitForPackagedCdpDown(cdp.port, 30_000),
      true,
      'previous packaged CDP endpoint stayed reachable after shutdown',
    );
    clearPackagedCdpOwnership(cdpUserDataDir);
    launch();
    cdp = await waitForOwnedPackagedCdp({
      userDataDir: cdpUserDataDir,
      timeoutMs: 90_000,
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
    page = await rendererPage(browser);
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, label: 'packaged-ownership-reopen' });
    await page.goto('kyutxo-app://bundle/#/resolve-ownership');
    await page.getByTestId('ownership-resolution-page').waitFor({ state: 'visible' });
    await page.getByTestId('ownership-loading').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('ownership-suggestion-6').count(), 0, 'rejected unchanged evidence stays hidden after desktop relaunch');

    state = await ownershipState(page);
    assert.equal(state.kind, 'protected');
    assert.equal(state.ownership.find((row) => row.recordId === 2)?.entityId, 1, 'single accepted assignment survives relaunch');
    assert.ok(
      state.decisions.some((row) =>
        row.state === 'rejected' &&
        row.recordIds.includes(6) &&
        row.evidenceFingerprint === rejectedFingerprint),
      'rejected decision and its original fingerprint survive relaunch',
    );
    assert.ok(state.decisions.some((row) => row.action === 'assign-wallet' && !row.undoToken), 'undone wallet decision remains auditable but cannot be replayed');

    const changedEvidence = await changeRejectedEvidence(page);
    assert.equal(changedEvidence.discoveredInTxid, 'propagation-reject-materially-changed');
    await page.reload();
    await page.getByTestId('ownership-resolution-page').waitFor({ state: 'visible' });
    await page.getByTestId('ownership-loading').waitFor({ state: 'detached' });
    const changedSuggestion = page.getByTestId('ownership-suggestion-6');
    await changedSuggestion.waitFor({ state: 'visible' });
    await changedSuggestion.getByTestId('button-ownership-inspect-6').click();
    const changedEvidenceText = await changedSuggestion.getByTestId('ownership-evidence-6').innerText();
    assert.match(changedEvidenceText, /propagation-reject-materially-changed/);
    const changedFingerprint = changedEvidenceText.match(/ownership-v1:[0-9a-f]{8}/)?.[0];
    assert.ok(changedFingerprint, 'changed suggestion exposes its evidence fingerprint');
    assert.notEqual(changedFingerprint, rejectedFingerprint, 'materially changed local evidence produces a new review fingerprint');
    state = await ownershipState(page);
    assert.ok(
      state.decisions.some((row) =>
        row.state === 'rejected' &&
        row.recordIds.includes(6) &&
        row.evidenceFingerprint === rejectedFingerprint),
      'the prior rejection remains auditable after changed evidence returns for review',
    );
    assert.equal(
      state.decisions.some((row) => row.evidenceFingerprint === changedFingerprint),
      false,
      'the changed fingerprint is a fresh suggestion with no inherited decision',
    );

    await page.goto('kyutxo-app://bundle/#/privacy-audit');
    await page.getByTestId('button-run-audit').click();
    const finding = page.getByTestId('card-finding-multi_owner_co_spend');
    await finding.waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await finding.count(), 1, 'Privacy Audit reports one confirmed multi-owner co-spend');
    assert.match(await finding.innerText(), /2 confirmed owners/i);
    await finding.getByTestId('button-toggle-details').click();
    assert.match(await finding.innerText(), new RegExp(CONFIRMED_TX.slice(0, 12), 'i'));
    assert.doesNotMatch(await finding.innerText(), new RegExp(UNKNOWN_TX.slice(0, 12), 'i'));
    assert.equal(
      await page.getByTestId('badge-group-severity-multi_owner_co_spend').innerText(),
      '1',
      'unknown ownership does not create an additional multi-owner finding',
    );

    console.log(`${TAG} protected ownership review, changed-evidence return, restart persistence, undo, and Privacy Audit checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    await stop(child);
    try { process.kill(-xvfb?.pid, 'SIGTERM'); } catch { xvfb?.kill?.('SIGTERM'); }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${TAG} FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});