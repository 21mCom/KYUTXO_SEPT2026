import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';

import { hostTarget, parseExpectedTarget } from './check-release-runner-readiness.mjs';

const readWorkflow = (filename) =>
  fs.readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8');

function parseJobMatrix(workflow, jobName) {
  let document;
  assert.doesNotThrow(
    () => {
      document = yaml.load(workflow);
    },
    undefined,
    `malformed workflow YAML for job: ${jobName}`,
  );

  assert.ok(
    document && typeof document === 'object' && !Array.isArray(document),
    `workflow must be a mapping for job: ${jobName}`,
  );
  const job = document.jobs?.[jobName];
  assert.ok(job && typeof job === 'object' && !Array.isArray(job), `missing workflow job: ${jobName}`);
  const matrix = job.strategy?.matrix;
  assert.ok(
    matrix && typeof matrix === 'object' && !Array.isArray(matrix),
    `missing matrix in workflow job: ${jobName}`,
  );
  assert.ok(
    Array.isArray(matrix.include) && matrix.include.length > 0,
    `missing include matrix in workflow job: ${jobName}`,
  );

  for (const target of matrix.include) {
    assert.ok(
      target && typeof target === 'object' && !Array.isArray(target),
      `invalid matrix target in ${jobName}: ${JSON.stringify(target)}`,
    );
  }
  return matrix.include;
}

function extractRunnerTargets(workflow, jobName) {
  const targets = parseJobMatrix(workflow, jobName).map(
    ({ platform, arch, runner_label: runnerLabel }) => ({
      platform,
      arch,
      runnerLabel,
    }),
  );

  for (const target of targets) {
    assert.ok(
      [target.platform, target.arch, target.runnerLabel].every(
        (value) => typeof value === 'string' && value.length > 0,
      ),
      `incomplete runner target in ${jobName}: ${JSON.stringify(target)}`,
    );
  }

  return targets.sort((left, right) =>
      `${left.platform}/${left.arch}/${left.runnerLabel}`.localeCompare(
        `${right.platform}/${right.arch}/${right.runnerLabel}`,
      ),
    );
}

function assertCompatibleBuilderFlags(workflow, jobName) {
  const compatibleFlags = new Map([
    ['win', '--win'],
    ['darwin', '--mac'],
    ['linux', '--linux'],
  ]);
  const targets = parseJobMatrix(workflow, jobName).map(
    ({ platform, builder_flag: builderFlag }) => ({ platform, builderFlag }),
  );
  for (const target of targets) {
    assert.equal(
      typeof target.platform,
      'string',
      `incomplete release target in ${jobName}: ${JSON.stringify(target)}`,
    );
    assert.equal(
      typeof target.builderFlag,
      'string',
      `incomplete release target in ${jobName}: ${JSON.stringify(target)}`,
    );
    const expectedFlag = compatibleFlags.get(target.platform);
    assert.ok(expectedFlag, `unsupported release platform: ${target.platform}`);
    assert.equal(
      target.builderFlag,
      expectedFlag,
      `incompatible builder flag for ${target.platform}`,
    );
  }
}

test('workflow matrices tolerate harmless YAML formatting changes', () => {
  const workflow = `
jobs:
    check-runner:
      strategy: { matrix: { include: [
        { runner_label: desktop-release-linux-x64, arch: x64, platform: linux },
        { arch: arm64, platform: darwin, runner_label: desktop-release-darwin-arm64 }
      ] } }
`;

  assert.deepEqual(extractRunnerTargets(workflow, 'check-runner'), [
    { platform: 'darwin', arch: 'arm64', runnerLabel: 'desktop-release-darwin-arm64' },
    { platform: 'linux', arch: 'x64', runnerLabel: 'desktop-release-linux-x64' },
  ]);
});

test('workflow matrix parsing fails closed for malformed or missing fields', () => {
  assert.throws(
    () => extractRunnerTargets('jobs: [', 'check-runner'),
    /malformed workflow YAML for job: check-runner/,
  );
  assert.throws(
    () => extractRunnerTargets('jobs:\n  check-runner:\n    strategy: {}\n', 'check-runner'),
    /missing matrix in workflow job: check-runner/,
  );
  assert.throws(
    () =>
      extractRunnerTargets(
        'jobs:\n  check-runner:\n    strategy:\n      matrix:\n        include: nope\n',
        'check-runner',
      ),
    /missing include matrix in workflow job: check-runner/,
  );
  assert.throws(
    () =>
      extractRunnerTargets(
        'jobs:\n  check-runner:\n    strategy:\n      matrix:\n        include:\n          - platform: linux\n            arch: x64\n',
        'check-runner',
      ),
    /incomplete runner target in check-runner/,
  );
});

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

test('release targets use compatible electron-builder platform flags', () => {
  const workflow = readWorkflow('build.yml');
  assert.doesNotThrow(() => assertCompatibleBuilderFlags(workflow, 'native-power-smoke'));

  const unknownPlatform = workflow.replace(
    '          - platform: win\n',
    '          - platform: freebsd\n',
  );
  assert.throws(
    () => assertCompatibleBuilderFlags(unknownPlatform, 'native-power-smoke'),
    /unsupported release platform: freebsd/,
  );

  const incompatibleFlag = workflow.replace(
    '            builder_flag: --win\n',
    '            builder_flag: --linux\n',
  );
  assert.throws(
    () => assertCompatibleBuilderFlags(incompatibleFlag, 'native-power-smoke'),
    /incompatible builder flag for win/,
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