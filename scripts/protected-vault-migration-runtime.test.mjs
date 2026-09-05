import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  assertFailureRecoveryReport,
  assertSuccessfulMigrationReport,
  assertTamperRejectedReport,
  GENERATION_SWAP_PHASES,
  MIGRATION_PHASES,
} from './protected-vault-migration-contract.mjs';

const require = createRequire(import.meta.url);
const {
  ProtectedVaultMigrationController,
  runProtectedVaultScenario,
} = require('../electron/protected-vault-migration.cjs');
const { MESSAGE_TYPES } = require('../electron/protected-store.cjs');
const tokens = [
  'KYUTXO_PROTECTED_ROW_6d974c29f24a',
  'KYUTXO_PROTECTED_ATTACHMENT_3ac89e7441bf',
];

async function scenario(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-protected-runtime-'));
  try {
    return await runProtectedVaultScenario({ root, scenario: name, fixtureTokens: tokens });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('main-owned migration streams a source fixture into a verified published generation', async () => {
  const report = await scenario('migration-success');
  assertSuccessfulMigrationReport(report);
  assert.equal(report.active.tables.records.count, 1);
  assert.equal(report.active.tables.settings.count, 1);
});

test('tampered staged attachment is authenticated and cannot alter active generation', async () => {
  assertTamperRejectedReport(await scenario('tamper-attachment'), 'tamper-attachment');
});

test('failed staged migration retains the actual plaintext source', async () => {
  const report = await scenario('migration-failure:verify');
  assertFailureRecoveryReport(report, 'migration-failure:verify');
  assert.equal(report.sourceWritable, true);
});

test('fault injection recovers safely at every migration and publication checkpoint', async () => {
  for (const phase of [...MIGRATION_PHASES, ...GENERATION_SWAP_PHASES]) {
    const name = `migration-failure:${phase}`;
    assertFailureRecoveryReport(await scenario(name), name);
  }
}, 60_000);

test('disk-space preflight fails before freezing or changing source authority', async () => {
  assertFailureRecoveryReport(await scenario('disk-full-migration'), 'disk-full-migration');
});

test('tampered staged SQLCipher database is rejected without changing authority', async () => {
  assertTamperRejectedReport(await scenario('tamper-database'), 'tamper-database');
});

test('cleanup deletion and rescan crashes resume idempotently before completion', async () => {
  for (const phase of [
    'cleanup.removeSource',
    'cleanup.removeSource.during',
    'cleanup.removeSource.after',
    'cleanup.rescan',
    'cleanup.rescan.after',
  ]) {
    const name = `migration-failure:${phase}`;
    assertFailureRecoveryReport(await scenario(name), name);
  }
}, 30_000);

test('migration gate blocks every mutation but never blocks LOCK', () => {
  const controller = new ProtectedVaultMigrationController({ root: '/unused' });
  assert.equal(controller.operationAllowed(MESSAGE_TYPES.LOCK), true);
  for (const operation of [
    MESSAGE_TYPES.CREATE,
    MESSAGE_TYPES.PUT_ROW,
    MESSAGE_TYPES.DELETE_ROW,
    MESSAGE_TYPES.CHANGE_PASSWORD,
    MESSAGE_TYPES.WRITE_ATTACHMENT,
    MESSAGE_TYPES.DELETE_ATTACHMENT,
    MESSAGE_TYPES.RENAME_ATTACHMENT,
    MESSAGE_TYPES.READ_ATTACHMENT,
    MESSAGE_TYPES.LIST_ATTACHMENTS,
    MESSAGE_TYPES.VERIFY_ATTACHMENTS,
  ]) {
    assert.equal(controller.operationAllowed(operation), false);
  }
  for (const operation of [
    MESSAGE_TYPES.STATUS,
    MESSAGE_TYPES.LOCK,
    MESSAGE_TYPES.INTEGRITY,
    MESSAGE_TYPES.GET_ROW,
    MESSAGE_TYPES.LIST_ROWS,
  ]) {
    assert.equal(controller.operationAllowed(operation), true);
  }
});

test('authenticated freeze and both reference hooks are mandatory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-missing-hooks-'));
  try {
    const source = {
      estimateBytes: async () => 0,
      authenticatePreflight: async () => true,
      freeze: async () => true,
      async *rows() {},
      async *attachments() {},
      removeSource: async () => true,
      plaintextRemaining: async () => false,
    };
    const controller = new ProtectedVaultMigrationController({
      root,
      sourceAdapter: source,
      diskSpace: async () => Number.MAX_SAFE_INTEGER,
    });
    await assert.rejects(
      controller.migrate({ password: 'password' }),
      /Protected vault migration failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous authority recovery verifies and preserves a tampered prior generation', async () => {
  const report = await scenario('prior-generation-tamper-recovery');
  assert.equal(report.rejected, true);
  assert.equal(report.priorPreserved, true);
  assert.equal(report.candidatePreserved, true);
});

test('swap cleanup accepts verified candidate content that differs from valid prior', async () => {
  const report = await scenario('differing-prior-cleanup-recovery');
  assert.equal(report.recovered, true);
  assert.equal(report.contentChanged, true);
  assert.equal(report.priorRemoved, true);
});

test('pointer recovery completes source cleanup for candidate differing from valid prior', async () => {
  const report = await scenario('differing-prior-pointer-recovery');
  assert.equal(report.recovered, true);
  assert.equal(report.candidateAuthoritative, true);
  assert.equal(report.priorRemoved, true);
  assert.equal(report.sourceRemoved, true);
});

test('pre-publication swap fault rolls differing candidate back and thaws source', async () => {
  const report = await scenario('differing-prior-swap-rollback');
  assert.equal(report.priorStillAuthoritative, true);
  assert.equal(report.sourceWritable, true);
});

test('source attachment evidence remains bounded at large cardinality', async () => {
  const source = {
    async *rows() {},
    async *attachments() {
      for (let index = 0; index < 250; index++) {
        const id = `attachment-${String(index).padStart(4, '0')}`;
        yield {
          id,
          size: 1,
          stream: (async function* stream() { yield Buffer.from([index & 0xff]); })(),
        };
      }
    },
  };
  const controller = new ProtectedVaultMigrationController({
    root: '/unused',
    sourceAdapter: source,
    sourceReferenceVerifier: async () => true,
    protectedReferenceVerifier: async () => true,
  });
  const snapshot = await controller.scanSource();
  assert.equal(snapshot.attachments.count, 250);
  assert.equal(snapshot.attachments.bytes, 250);
  assert.equal(snapshot.attachments.files.length, 100);
});

test('early crash recovery discards stage and thaws source in-process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-thaw-recovery-'));
  let frozen = true;
  const source = {
    thaw: async () => { frozen = false; return true; },
  };
  try {
    const controller = new ProtectedVaultMigrationController({ root });
    const generation = 'protected-00000000-0000-4000-8000-000000000000';
    await fs.promises.mkdir(controller.stagePath(generation), { recursive: true });
    await controller.checkpoint('stage', {
      generation,
      priorGeneration: null,
    });
    const result = await controller.recover({
      password: 'password',
      resumeContext: {
        sourceAdapter: source,
        authenticateSource: async () => true,
      },
    });
    assert.equal(result.action, 'source-preserved');
    assert.equal(frozen, false);
    assert.equal(fs.existsSync(controller.stagePath(generation)), false);
    assert.equal(controller.operationAllowed(MESSAGE_TYPES.PUT_ROW), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart recovery from prepare/publish proceeds through durable cleanup to complete', async () => {
  for (const phase of ['generation-swap.prepare', 'generation-swap.publish']) {
    const report = await scenario(`restart-recovery:${phase}`);
    assert.equal(report.recovered, true);
    assert.equal(report.recoveryAction, 'cleanup-resumed');
    assert.equal(report.sourceRemoved, true);
    assert.equal(report.markerPhase, 'complete');
    assert.equal(report.controllerFrozen, false);
    assert.equal(report.mutationsAllowed, true);
    assert.equal(report.candidateAuthoritative, true);
  }
}, 30_000);