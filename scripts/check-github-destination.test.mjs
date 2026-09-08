import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertExpectedGitHubDestination,
  EXPECTED_GITHUB_REPOSITORY,
  repositoryFromRemote,
} from './check-github-destination.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts/check-github-destination.mjs');

test('accepts only the September GitHub repository in supported remote forms', () => {
  for (const remote of [
    'https://github.com/21mCom/KYUTXO_SEPT2026.git',
    'git@github.com:21mCom/KYUTXO_SEPT2026.git',
    'ssh://git@github.com/21mCom/KYUTXO_SEPT2026.git',
  ]) {
    assert.equal(repositoryFromRemote(remote), EXPECTED_GITHUB_REPOSITORY);
    assert.doesNotThrow(() => assertExpectedGitHubDestination(remote));
  }
});

test('rejects the June repository and non-GitHub push destinations', () => {
  for (const remote of [
    'https://github.com/21mCom/KYUTXO_12-JUNE-26_NO_ENCRYPTION.git',
    'git@github.com:21mCom/KYUTXO_12-JUNE-26_NO_ENCRYPTION.git',
    'git+ssh://git@ssh.picard.replit.dev:/home/runner/workspace',
    '',
  ]) {
    assert.throws(() => assertExpectedGitHubDestination(remote), /must be 21mCom\/KYUTXO_SEPT2026/);
  }
});

test('CLI fails closed when Actions identifies any other repository', () => {
  const rejected = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: '21mCom/KYUTXO_12-JUNE-26_NO_ENCRYPTION' },
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /GitHub destination check failed/);

  const accepted = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: EXPECTED_GITHUB_REPOSITORY },
  });
  assert.equal(accepted.status, 0, accepted.stderr);
});