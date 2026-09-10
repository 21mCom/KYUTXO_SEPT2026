#!/usr/bin/env node

import {
  STABLE_BACKUP_PASSWORD,
  auditStableBackupFixturePrivacy,
  readVerifiedStableBackupFixture,
} from './stable-backup-fixture.mjs';

const TAG = '[stable-backup-fixture-privacy]';

try {
  const { buffer } = readVerifiedStableBackupFixture();
  const result = await auditStableBackupFixturePrivacy(buffer, STABLE_BACKUP_PASSWORD);
  console.log(
    `${TAG} OK — audited ${result.archiveEntries} archive entries and ${result.portableTables} portable tables against explicit synthetic allowlists.`,
  );
} catch (error) {
  console.error(`${TAG} FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}