// Contract shared by the packaged protected-vault gate and its node tests.
// The implementation is intentionally owned by the packaged main process:
// this file only describes the evidence a release gate must receive.

export const PROTECTED_VAULT_TEST_API = 'protectedVaultTest';
export const PROTECTED_VAULT_TEST_METHOD = 'runScenario';
export const PLAINTEXT_MIGRATION_SOURCE_ROOT = 'migration-source';
// v44 is a projection rather than a backup-only feature: a protected
// generation must account for each normalized table in its canonical snapshot.
export const NORMALIZED_RECORD_MODEL_TABLES = Object.freeze([
  'entities',
  'wallets',
  'addressOwnership',
  'transactionMetadata',
  'transactionLegMetadata',
]);

export const MIGRATION_PHASES = [
  'preflight',
  'freeze',
  'stage',
  'verify',
  'commit',
  'complete',
];

export const GENERATION_SWAP_PHASES = [
  'generation-swap.prepare',
  'generation-swap.publish',
  'generation-swap.cleanup',
];

export const PROTECTED_VAULT_SCENARIOS = [
  'fresh-lifecycle',
  'migration-success',
  ...MIGRATION_PHASES.map((phase) => `migration-failure:${phase}`),
  ...GENERATION_SWAP_PHASES.map((phase) => `migration-failure:${phase}`),
  'tamper-database',
  'tamper-attachment',
  'wrong-password',
  'disk-full-migration',
  'password-rewrap',
  'encrypted-backup-recovery',
  'wrong-password-backup',
  'corrupt-backup',
  'truncated-backup',
  'disk-full-restore',
  'crash-database-transaction',
  'crash-attachment-write',
  'crash-restore',
  'crash-generation-swap',
];

const HEX_DIGEST = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`protected-vault evidence: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !HEX_DIGEST.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertContentSnapshot(snapshot, label) {
  assertObject(snapshot, label);
  if (typeof snapshot.generation !== 'string' || snapshot.generation.length < 8) {
    fail(`${label}.generation is missing`);
  }
  if (snapshot.verified !== true) fail(`${label} is not verified`);
  if (snapshot.referencesOk !== true) fail(`${label}.referencesOk is false`);

  assertObject(snapshot.tables, `${label}.tables`);
  const tableNames = Object.keys(snapshot.tables);
  if (tableNames.length === 0) fail(`${label}.tables is empty`);
  for (const table of tableNames) {
    const evidence = snapshot.tables[table];
    assertObject(evidence, `${label}.tables.${table}`);
    if (!Number.isSafeInteger(evidence.count) || evidence.count < 0) {
      fail(`${label}.tables.${table}.count is invalid`);
    }
    assertDigest(evidence.digest, `${label}.tables.${table}.digest`);
  }

  assertObject(snapshot.attachments, `${label}.attachments`);
  if (!Number.isSafeInteger(snapshot.attachments.count) ||
      snapshot.attachments.count < 0) {
    fail(`${label}.attachments.count is invalid`);
  }
  if (!Number.isSafeInteger(snapshot.attachments.bytes) ||
      snapshot.attachments.bytes < 0) {
    fail(`${label}.attachments.bytes is invalid`);
  }
  assertDigest(snapshot.attachments.digest, `${label}.attachments.digest`);
  if (!Array.isArray(snapshot.attachments.files)) {
    fail(`${label}.attachments.files must be an array`);
  }
  for (const [index, file] of snapshot.attachments.files.entries()) {
    assertObject(file, `${label}.attachments.files[${index}]`);
    if (typeof file.id !== 'string' || file.id.length < 8) {
      fail(`${label}.attachments.files[${index}].id is missing`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      fail(`${label}.attachments.files[${index}].bytes is invalid`);
    }
    assertDigest(file.digest, `${label}.attachments.files[${index}].digest`);
  }
}

function assertProtectedSnapshot(snapshot, label) {
  assertContentSnapshot(snapshot, label);
  if (snapshot.sqlCipherIntegrity !== 'ok') {
    fail(`${label}.sqlCipherIntegrity is not ok`);
  }
  for (const table of NORMALIZED_RECORD_MODEL_TABLES) {
    if (!Object.hasOwn(snapshot.tables, table)) {
      fail(`${label}.tables.${table} is missing`);
    }
  }
}

export function assertProtectedVaultReport(
  report,
  scenario,
  { activeProtected = true } = {},
) {
  assertObject(report, 'report');
  if (report.scenario !== scenario) {
    fail(`scenario mismatch (expected ${scenario}, got ${report.scenario})`);
  }
  if (report.status !== 'passed') fail(`scenario ${scenario} did not pass`);
  if (report.locked !== true) fail(`${scenario} did not leave the vault locked`);
  assertContentSnapshot(report.baseline, `${scenario}.baseline`);
  if (activeProtected) {
    if (report.activeStoreKind !== 'protected') fail(`${scenario} active store is not protected`);
    assertProtectedSnapshot(report.active, `${scenario}.active`);
  } else {
    if (report.activeStoreKind !== 'plaintext') fail(`${scenario} did not preserve plaintext source`);
    assertContentSnapshot(report.active, `${scenario}.active`);
    if (report.plaintextSourceRelativeRoot !== PLAINTEXT_MIGRATION_SOURCE_ROOT) {
      fail(
        `${scenario}.plaintextSourceRelativeRoot must be ` +
        PLAINTEXT_MIGRATION_SOURCE_ROOT,
      );
    }
  }
  return report;
}

export function assertFreshLifecycleReport(report) {
  assertProtectedVaultReport(report, 'fresh-lifecycle');
  if (report.created !== true) fail('fresh-lifecycle did not create a new vault');
  if (report.unlocked !== true) fail('fresh-lifecycle did not unlock the new vault');
  if (report.lockTransitionObserved !== true) {
    fail('fresh-lifecycle did not observe the protected lock transition');
  }
  if (report.reopened !== true) fail('fresh-lifecycle did not reopen the vault');
  assertProtectedSnapshot(
    report.reopenedSnapshot,
    'fresh-lifecycle.reopenedSnapshot',
  );
  assertEqualSnapshot(
    report.reopenedSnapshot,
    report.active,
    'fresh-lifecycle.reopen',
  );
  return report;
}

export function assertEqualContent(actual, expected, label) {
  assertContentSnapshot(actual, `${label}.actual`);
  assertContentSnapshot(expected, `${label}.expected`);
  if (actual.referencesOk !== expected.referencesOk) {
    fail(`${label}.referencesOk changed`);
  }
  if (JSON.stringify(actual.tables) !== JSON.stringify(expected.tables)) {
    fail(`${label}.table counts or canonical digests changed`);
  }
  if (JSON.stringify(actual.attachments) !== JSON.stringify(expected.attachments)) {
    fail(`${label}.attachment counts or digests changed`);
  }
}

export function assertEqualSnapshot(actual, expected, label) {
  assertEqualContent(actual, expected, label);
  if (actual.generation !== expected.generation) fail(`${label}.generation changed`);
}

export function assertFailureRecoveryReport(report, scenario) {
  const plaintextMigrationFailure =
    scenario.startsWith('migration-failure:') || scenario === 'disk-full-migration';
  if (plaintextMigrationFailure && report.recoveryAction !== 'source-preserved') {
    fail(`${scenario} did not preserve the plaintext source`);
  }
  if (scenario.startsWith('crash-') && report.recoveryAction === 'source-preserved') {
    fail(`${scenario} did not recover the prior protected generation`);
  }
  const sourcePreserved = report.recoveryAction === 'source-preserved';
  assertProtectedVaultReport(report, scenario, {
    activeProtected: !sourcePreserved,
  });
  if (!report.recovered) fail(`${scenario} did not report recovery`);
  if (!['source-preserved', 'staged-generation-discarded', 'verified-generation-resumed']
    .includes(report.recoveryAction)) {
    fail(`${scenario} has no safe recovery action`);
  }
  if (report.recoveryAction === 'verified-generation-resumed') {
    assertEqualContent(report.active, report.baseline, scenario);
  } else {
    assertEqualSnapshot(report.active, report.baseline, scenario);
  }
  return report;
}

export function assertTamperRejectedReport(report, scenario) {
  assertProtectedVaultReport(report, scenario);
  if (report.rejected !== true) fail(`${scenario} was not rejected`);
  if (report.activeUntouched !== true) fail(`${scenario} changed the active vault`);
  assertEqualSnapshot(report.active, report.baseline, scenario);
  return report;
}

export function assertBackupRecoveryReport(report, scenario) {
  assertProtectedVaultReport(report, scenario);
  if (report.rejected !== true) fail(`${scenario} was not rejected`);
  if (report.activeUntouched !== true) fail(`${scenario} changed the active vault`);
  assertEqualSnapshot(report.active, report.baseline, scenario);
  return report;
}

export function assertSuccessfulMigrationReport(report) {
  assertProtectedVaultReport(report, 'migration-success');
  if (report.migrated !== true) fail('migration-success did not migrate');
  if (report.sourceRemoved !== true) {
    fail('migration-success did not remove the active plaintext source');
  }
  if (report.active.generation === report.baseline.generation) {
    fail('migration-success did not publish a new generation');
  }
  assertEqualContent(report.active, report.baseline, 'migration-success');
  for (const table of NORMALIZED_RECORD_MODEL_TABLES) {
    if (report.active.tables[table].count < 1) {
      fail(`migration-success did not preserve normalized ${table} metadata`);
    }
  }
  if (report.sourcePlaintextRemaining === true) {
    fail('migration-success left plaintext source bytes active');
  }
  return report;
}

export function assertRewrapReport(report) {
  assertProtectedVaultReport(report, 'password-rewrap');
  if (report.rewrapped !== true) fail('password-rewrap did not re-wrap the data key');
  if (report.oldPasswordAccepted !== false) {
    fail('password-rewrap still accepts the old password');
  }
  if (report.newPasswordAccepted !== true) {
    fail('password-rewrap does not accept the new password');
  }
  assertEqualSnapshot(report.activeAfterRewrap, report.active, 'password-rewrap');
  return report;
}

export function assertBackupRecoverySuccessReport(report) {
  assertProtectedVaultReport(report, 'encrypted-backup-recovery');
  if (report.recovered !== true || report.published !== true || report.reopened !== true) {
    fail('encrypted-backup-recovery did not publish and reopen the recovery generation');
  }
  if (report.backupPasswordIndependent !== true) {
    fail('encrypted-backup-recovery did not prove independent backup password');
  }
  assertContentSnapshot(report.backupSnapshot, 'encrypted-backup-recovery.backupSnapshot');
  assertEqualContent(report.active, report.backupSnapshot, 'encrypted-backup-recovery');
  if (report.active.generation === report.baseline.generation) {
    fail('encrypted-backup-recovery did not replace the lost active generation');
  }
  return report;
}
