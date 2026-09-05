import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { hostTarget, parseExpectedTarget } from './check-release-runner-readiness.mjs';

const readWorkflow = (filename) =>
  fs.readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8');

function extractRunnerTargets(workflow, jobName) {
  const jobMatch = workflow.match(
    new RegExp(
      `^  ${jobName}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`,
      'm',
    ),
  );
  assert.ok(jobMatch, `missing workflow job: ${jobName}`);

  const matrixMatch = jobMatch[1].match(
    /^\s{6}matrix:\s*\n\s{8}include:\s*\n([\s\S]*?)(?=^\s{4}\S)/m,
  );
  assert.ok(matrixMatch, `missing include matrix in workflow job: ${jobName}`);

  const targets = [];
  let current;
  for (const line of matrixMatch[1].split('\n')) {
    const platform = line.match(/^\s{10}- platform:\s*(\S+)\s*$/);
    if (platform) {
      current = { platform: platform[1] };
      targets.push(current);
      continue;
    }

    const field = line.match(/^\s{12}(arch|runner_label):\s*(\S+)\s*$/);
    if (field && current) current[field[1]] = field[2];
  }

  for (const target of targets) {
    assert.deepEqual(
      Object.keys(target).sort(),
      ['arch', 'platform', 'runner_label'],
      `incomplete runner target in ${jobName}: ${JSON.stringify(target)}`,
    );
  }

  return targets
    .map(({ platform, arch, runner_label: runnerLabel }) => ({
      platform,
      arch,
      runnerLabel,
    }))
    .sort((left, right) =>
      `${left.platform}/${left.arch}/${left.runnerLabel}`.localeCompare(
        `${right.platform}/${right.arch}/${right.runnerLabel}`,
      ),
    );
}

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

test('scheduled readiness targets and dedicated labels match the release gate', () => {
  const releaseWorkflow = readWorkflow('build.yml');
  const readinessWorkflow = readWorkflow('desktop-release-runner-readiness.yml');

  assert.deepEqual(
    extractRunnerTargets(readinessWorkflow, 'check-runner'),
    extractRunnerTargets(releaseWorkflow, 'native-power-smoke'),
  );
});

test('scheduled readiness workflow is scheduled and non-destructive', () => {
  const workflow = readWorkflow('desktop-release-runner-readiness.yml');
  assert.match(workflow, /schedule:\s*\n\s+- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /check-release-runner-readiness\.mjs/);
  assert.doesNotMatch(workflow, /check-packaged-vault-lock-native|screen.?lock|suspend|sleepnow/i);
});