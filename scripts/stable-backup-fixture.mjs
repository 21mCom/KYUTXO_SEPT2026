import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STABLE_BACKUP_FIXTURE_DIR = path.join(ROOT, 'test-fixtures', 'backups');
export const STABLE_BACKUP_FIXTURE_NAME = 'kyutxo-v1.1.24-sanitized-v3.zip';
export const STABLE_BACKUP_FIXTURE_PATH = path.join(
  STABLE_BACKUP_FIXTURE_DIR,
  STABLE_BACKUP_FIXTURE_NAME,
);
export const STABLE_BACKUP_PROVENANCE_PATH = path.join(
  STABLE_BACKUP_FIXTURE_DIR,
  'kyutxo-v1.1.24-sanitized-v3.provenance.json',
);
export const STABLE_BACKUP_PASSWORD = 'stable-release-fixture-v1.1.24';

export function readVerifiedStableBackupFixture() {
  const provenance = JSON.parse(fs.readFileSync(STABLE_BACKUP_PROVENANCE_PATH, 'utf8'));
  const sidecar = fs.readFileSync(`${STABLE_BACKUP_FIXTURE_PATH}.sha256`, 'utf8').trim();
  const [sidecarDigest, sidecarName, ...extra] = sidecar.split(/\s+/);
  if (extra.length || sidecarName !== STABLE_BACKUP_FIXTURE_NAME) {
    throw new Error('Stable backup checksum sidecar has an invalid shape or filename');
  }
  if (
    provenance.fixture !== STABLE_BACKUP_FIXTURE_NAME ||
    provenance.sourceTag !== 'v1.1.24' ||
    provenance.sourceRevision !== 'b4021938b4c258a894e77698976cf28aa20d23c5' ||
    provenance.password !== STABLE_BACKUP_PASSWORD
  ) {
    throw new Error('Stable backup provenance no longer identifies the pinned v1.1.24 release');
  }
  const buffer = fs.readFileSync(STABLE_BACKUP_FIXTURE_PATH);
  const actualDigest = createHash('sha256').update(buffer).digest('hex');
  if (actualDigest !== sidecarDigest || actualDigest !== provenance.sha256) {
    throw new Error(
      `Stable backup checksum mismatch: expected ${provenance.sha256}, got ${actualDigest}`,
    );
  }
  return { buffer, digest: actualDigest, provenance };
}