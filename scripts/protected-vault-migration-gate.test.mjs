import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  GENERATION_SWAP_PHASES,
  MIGRATION_PHASES,
  PLAINTEXT_MIGRATION_SOURCE_ROOT,
  PROTECTED_VAULT_SCENARIOS,
  assertBackupRecoverySuccessReport,
  assertBackupRecoveryReport,
  assertEqualSnapshot,
  assertFailureRecoveryReport,
  assertFreshLifecycleReport,
  assertProtectedVaultReport,
  assertRewrapReport,
  assertSuccessfulMigrationReport,
  assertTamperRejectedReport,
} from './protected-vault-migration-contract.mjs';

function digest(seed) {
  return createHash('sha256').update(seed).digest('hex');
}

function snapshot(generation = 'verified-generation-1') {
  return {
    generation,
    verified: true,
    sqlCipherIntegrity: 'ok',
    referencesOk: true,
    tables: {
      records: { count: 2, digest: digest('records') },
      settings: { count: 1, digest: digest('settings') },
    },
    attachments: {
      count: 1,
      bytes: 7,
      digest: digest('attachments'),
      files: [{ id: 'opaque-file-1', bytes: 7, digest: digest('file') }],
    },
  };
}

function report(scenario, overrides = {}) {
  const baseline = snapshot();
  return {
    scenario,
    status: 'passed',
    locked: true,
    activeStoreKind: 'protected',
    baseline,
    active: snapshot(),
    ...overrides,
  };
}

test('failure matrix covers every migration and generation-swap phase', () => {
  for (const phase of [...MIGRATION_PHASES, ...GENERATION_SWAP_PHASES]) {
    assert.ok(PROTECTED_VAULT_SCENARIOS.includes(`migration-failure:${phase}`));
  }
  assert.equal(
    PROTECTED_VAULT_SCENARIOS.filter((id) => id.startsWith('migration-failure:')).length,
    MIGRATION_PHASES.length + GENERATION_SWAP_PHASES.length,
  );
});

test('protected report requires row, digest, reference, attachment, SQLCipher, and filesystem evidence', () => {
  const result = assertProtectedVaultReport(report('fresh-lifecycle'), 'fresh-lifecycle');
  assert.equal(result.active.tables.records.count, 2);

  const invalid = report('fresh-lifecycle');
  invalid.active.tables.records.digest = 'not-a-digest';
  assert.throws(
    () => assertProtectedVaultReport(invalid, 'fresh-lifecycle'),
    /lowercase SHA-256 digest/,
  );
});

test('fresh lifecycle requires create, unlock, lock, and verified reopen transitions', () => {
  assertFreshLifecycleReport(report('fresh-lifecycle', {
    created: true,
    unlocked: true,
    lockTransitionObserved: true,
    reopened: true,
    reopenedSnapshot: snapshot(),
  }));

  assert.throws(
    () => assertFreshLifecycleReport(report('fresh-lifecycle', {
      created: true,
      unlocked: true,
      lockTransitionObserved: false,
      reopened: true,
      reopenedSnapshot: snapshot(),
    })),
    /lock transition/,
  );
});

test('failure recovery rejects active-vault changes and plaintext leaks', () => {
  const result = assertFailureRecoveryReport(report('migration-failure:stage', {
    recovered: true,
    recoveryAction: 'source-preserved',
    activeStoreKind: 'plaintext',
    plaintextSourceRelativeRoot: PLAINTEXT_MIGRATION_SOURCE_ROOT,
  }), 'migration-failure:stage');
  assert.equal(result.recovered, true);

  const changed = report('migration-failure:stage', {
    recovered: true,
    recoveryAction: 'source-preserved',
    activeStoreKind: 'plaintext',
    plaintextSourceRelativeRoot: PLAINTEXT_MIGRATION_SOURCE_ROOT,
  });
  changed.active.tables.records.count = 1;
  assert.throws(
    () => assertFailureRecoveryReport(changed, 'migration-failure:stage'),
    /table counts or canonical digests changed/,
  );

  const missingSourceRoot = report('migration-failure:stage', {
    recovered: true,
    recoveryAction: 'source-preserved',
    activeStoreKind: 'plaintext',
  });
  assert.throws(
    () => assertFailureRecoveryReport(missingSourceRoot, 'migration-failure:stage'),
    /plaintextSourceRelativeRoot must be/,
  );

  const crashWithPlaintextFallback = report('crash-database-transaction', {
    recovered: true,
    recoveryAction: 'source-preserved',
    activeStoreKind: 'plaintext',
    plaintextSourceRelativeRoot: PLAINTEXT_MIGRATION_SOURCE_ROOT,
  });
  assert.throws(
    () => assertFailureRecoveryReport(
      crashWithPlaintextFallback,
      'crash-database-transaction',
    ),
    /prior protected generation/,
  );
});

test('tamper and backup failures must be rejected with the active vault untouched', () => {
  for (const scenario of [
    'tamper-database',
    'tamper-attachment',
    'wrong-password',
  ]) {
    assertTamperRejectedReport(report(scenario, {
      rejected: true,
      activeUntouched: true,
    }), scenario);
  }
  for (const scenario of [
    'wrong-password-backup',
    'corrupt-backup',
    'truncated-backup',
    'disk-full-restore',
  ]) {
    assertBackupRecoveryReport(report(scenario, {
      rejected: true,
      activeUntouched: true,
    }), scenario);
  }
});

test('successful migration requires a new verified generation and no active source', () => {
  assertSuccessfulMigrationReport(report('migration-success', {
    migrated: true,
    sourceRemoved: true,
    sourcePlaintextRemaining: false,
    active: snapshot('verified-generation-2'),
  }));

  const lossy = report('migration-success', {
    migrated: true,
    sourceRemoved: true,
    sourcePlaintextRemaining: false,
    active: snapshot('verified-generation-2'),
  });
  lossy.active.tables.records.count = 1;
  assert.throws(() => assertSuccessfulMigrationReport(lossy), /canonical digests changed/);
});

test('password re-wrap and encrypted backup recovery require their distinct proofs', () => {
  assertRewrapReport(report('password-rewrap', {
    rewrapped: true,
    oldPasswordAccepted: false,
    newPasswordAccepted: true,
    activeAfterRewrap: snapshot(),
  }));
  assertBackupRecoverySuccessReport(report('encrypted-backup-recovery', {
    recovered: true,
    published: true,
    reopened: true,
    backupPasswordIndependent: true,
    baseline: snapshot('verified-lost-generation'),
    active: snapshot('verified-restore'),
    backupSnapshot: snapshot('verified-backup'),
  }));
});

test('snapshot equality compares canonical table and attachment evidence', () => {
  const first = snapshot();
  assertEqualSnapshot(snapshot(), first, 'same');
  const second = snapshot();
  second.attachments.files[0].digest = digest('changed');
  assert.throws(
    () => assertEqualSnapshot(second, first, 'changed'),
    /attachment counts or digests changed/,
  );
});
