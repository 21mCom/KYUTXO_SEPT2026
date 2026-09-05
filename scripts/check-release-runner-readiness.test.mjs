import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { hostTarget, parseExpectedTarget } from './check-release-runner-readiness.mjs';

test('readiness target arguments require a supported OS and architecture', () => {
  assert.deepEqual(parseExpectedTarget(['--platform', 'linux', '--arch', 'arm64']), {
    platform: 'linux',
    arch: 'arm64',
  });
  assert.throws(() => parseExpectedTarget(['--platform', 'linux']), /usage:/);
  assert.throws(
    () => parseExpectedTarget(['--platform', 'freebsd', '--arch', 'x64']),
    /usage:/,
  );
});

test('host target reports the real Node OS and architecture', () => {
  const target = hostTarget();
  assert.ok(['win', 'darwin', 'linux'].includes(target.platform));
  assert.ok(target.arch);
});

test('scheduled readiness workflow covers all release labels and is non-destructive', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/desktop-release-runner-readiness.yml', import.meta.url),
    'utf8',
  );
  for (const label of [
    'desktop-release-win-x64',
    'desktop-release-darwin-x64',
    'desktop-release-darwin-arm64',
    'desktop-release-linux-x64',
    'desktop-release-linux-arm64',
  ]) {
    assert.match(workflow, new RegExp(`runner_label: ${label}`));
  }
  assert.match(workflow, /schedule:\s*\n\s+- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /check-release-runner-readiness\.mjs/);
  assert.doesNotMatch(workflow, /check-packaged-vault-lock-native|screen.?lock|suspend|sleepnow/i);
});