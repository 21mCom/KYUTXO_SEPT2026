import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';

import { hostTarget, parseExpectedTarget } from './check-release-runner-readiness.mjs';

const readWorkflow = (filename) =>
  fs.readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8');

function parseWorkflow(workflow, context) {
  let document;
  assert.doesNotThrow(
    () => {
      document = yaml.load(workflow);
    },
    undefined,
    `malformed workflow YAML for ${context}`,
  );
  assert.ok(
    document && typeof document === 'object' && !Array.isArray(document),
    `workflow must be a mapping for ${context}`,
  );
  return document;
}

function parseJobMatrix(workflow, jobName) {
  const document = parseWorkflow(workflow, `job: ${jobName}`);
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

const GITHUB_ACTIONS_CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function isValidCronValue(value, minimum, maximum) {
  return /^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isValidCronPart(part, minimum, maximum) {
  const [range, step, ...extra] = part.split('/');
  if (extra.length > 0 || (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1))) {
    return false;
  }
  if (range === '*') return true;

  const bounds = range.split('-');
  if (bounds.length === 1) {
    return isValidCronValue(bounds[0], minimum, maximum);
  }
  return (
    bounds.length === 2 &&
    isValidCronValue(bounds[0], minimum, maximum) &&
    isValidCronValue(bounds[1], minimum, maximum) &&
    Number(bounds[0]) <= Number(bounds[1])
  );
}

function isValidGitHubActionsCron(expression) {
  if (typeof expression !== 'string') return false;
  const fields = expression.trim().split(/\s+/);
  return (
    fields.length === GITHUB_ACTIONS_CRON_FIELD_RANGES.length &&
    fields.every((field, index) => {
      const [minimum, maximum] = GITHUB_ACTIONS_CRON_FIELD_RANGES[index];
      return field.split(',').every((part) => isValidCronPart(part, minimum, maximum));
    })
  );
}

function assertReadinessWorkflowPolicy(workflow) {
  const document = parseWorkflow(workflow, 'readiness policy');
  const triggers = document.on;
  assert.ok(
    triggers && typeof triggers === 'object' && !Array.isArray(triggers),
    'missing workflow triggers',
  );
  assert.ok(
    Array.isArray(triggers.schedule) &&
      triggers.schedule.length > 0 &&
      triggers.schedule.every(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          isValidGitHubActionsCron(entry.cron),
      ),
    'missing or malformed readiness schedule',
  );
  assert.ok(
    Object.hasOwn(triggers, 'workflow_dispatch') &&
      (triggers.workflow_dispatch === null ||
        (typeof triggers.workflow_dispatch === 'object' &&
          !Array.isArray(triggers.workflow_dispatch))),
    'missing or malformed workflow_dispatch trigger',
  );

  const job = document.jobs?.['check-runner'];
  assert.ok(job && typeof job === 'object' && !Array.isArray(job), 'missing check-runner job');
  assert.equal(job['timeout-minutes'], 10, 'check-runner timeout-minutes must be 10');
  assert.ok(Array.isArray(job.steps) && job.steps.length > 0, 'missing check-runner steps');

  const jobs = document.jobs;
  assert.ok(jobs && typeof jobs === 'object' && !Array.isArray(jobs), 'missing workflow jobs');
  const executableCommands = new Map();
  for (const [jobName, candidateJob] of Object.entries(jobs)) {
    assert.ok(
      candidateJob && typeof candidateJob === 'object' && !Array.isArray(candidateJob),
      `malformed workflow job: ${jobName}`,
    );
    if (!Object.hasOwn(candidateJob, 'steps')) continue;
    assert.ok(Array.isArray(candidateJob.steps), `malformed steps for workflow job: ${jobName}`);
    for (const [index, step] of candidateJob.steps.entries()) {
      assert.ok(
        step && typeof step === 'object' && !Array.isArray(step),
        `malformed ${jobName} step at index ${index}`,
      );
      if (Object.hasOwn(step, 'run')) {
        assert.equal(
          typeof step.run,
          'string',
          `malformed run command in ${jobName} at step index ${index}`,
        );
        assert.ok(step.run.trim().length > 0, `empty run command in ${jobName} at step index ${index}`);
        executableCommands.set(`${jobName}:${index}`, step.run);
      }
    }
  }

  assert.ok(
    [...executableCommands].some(
      ([location, command]) =>
        location.startsWith('check-runner:') &&
        /\bnode\s+scripts\/check-release-runner-readiness\.mjs(?:\s|$)/.test(command),
    ),
    'missing readiness probe command',
  );
  for (const command of executableCommands.values()) {
    assert.doesNotMatch(
      command,
      /check-packaged-vault-lock-native|screen.?lock|suspend|sleepnow/i,
      'readiness workflow contains a destructive command',
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
  assert.doesNotThrow(() => assertReadinessWorkflowPolicy(workflow));
});

test('readiness policy tolerates equivalent YAML scalar styles', () => {
  const workflow = `
on: { schedule: [{ cron: "17 13 * * 1" }], workflow_dispatch: {} }
jobs:
  check-runner:
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@example
      - run: |
          node scripts/check-release-runner-readiness.mjs \\
            --platform \${{ matrix.platform }} \\
            --arch \${{ matrix.arch }}
`;

  assert.doesNotThrow(() => assertReadinessWorkflowPolicy(workflow));
});

test('readiness policy accepts GitHub Actions cron operators', () => {
  const workflow = `
on:
  schedule:
    - cron: "0/15 6-18 * * 1,3,5"
  workflow_dispatch:
jobs:
  check-runner:
    timeout-minutes: 10
    steps:
      - run: node scripts/check-release-runner-readiness.mjs
`;

  assert.doesNotThrow(() => assertReadinessWorkflowPolicy(workflow));
});

test('readiness policy rejects invalid GitHub Actions cron expressions', () => {
  const validWorkflow = `
on:
  schedule:
    - cron: "17 13 * * 1"
  workflow_dispatch:
jobs:
  check-runner:
    timeout-minutes: 10
    steps:
      - run: node scripts/check-release-runner-readiness.mjs
`;
  const parsed = yaml.load(validWorkflow);
  const checkCronInvalid = (cron) => {
    const fixture = structuredClone(parsed);
    fixture.on.schedule = [{ cron }];
    assert.throws(
      () => assertReadinessWorkflowPolicy(yaml.dump(fixture)),
      /missing or malformed readiness schedule/,
      cron,
    );
  };

  checkCronInvalid('17 13 * *');
  checkCronInvalid('17 13 * * 1 extra');
  checkCronInvalid('60 13 * * 1');
  checkCronInvalid('17 24 * * 1');
  checkCronInvalid('17 13 0 * 1');
  checkCronInvalid('17 13 * 13 1');
  checkCronInvalid('17 13 * * 7');
  checkCronInvalid('*/0 13 * * 1');
  checkCronInvalid('17-5 13 * * 1');
  checkCronInvalid('17 nope * * 1');
});

test('readiness policy fails closed for missing or malformed fields', () => {
  const validWorkflow = `
on:
  schedule:
    - cron: "17 13 * * 1"
  workflow_dispatch:
jobs:
  check-runner:
    timeout-minutes: 10
    steps:
      - run: node scripts/check-release-runner-readiness.mjs
`;
  const parsed = yaml.load(validWorkflow);
  const checkInvalid = (mutate, expected) => {
    const fixture = structuredClone(parsed);
    mutate(fixture);
    assert.throws(() => assertReadinessWorkflowPolicy(yaml.dump(fixture)), expected);
  };

  checkInvalid((fixture) => delete fixture.on.schedule, /missing or malformed readiness schedule/);
  checkInvalid(
    (fixture) => {
      fixture.on.schedule = [{ cron: 17 }];
    },
    /missing or malformed readiness schedule/,
  );
  checkInvalid(
    (fixture) => delete fixture.on.workflow_dispatch,
    /missing or malformed workflow_dispatch trigger/,
  );
  checkInvalid(
    (fixture) => {
      fixture.jobs['check-runner']['timeout-minutes'] = '10';
    },
    /timeout-minutes must be 10/,
  );
  checkInvalid(
    (fixture) => {
      fixture.jobs['check-runner'].steps[0].run = ['node', 'scripts/check-release-runner-readiness.mjs'];
    },
    /malformed run command/,
  );
  checkInvalid(
    (fixture) => {
      fixture.jobs['check-runner'].steps[0].run = 'echo readiness';
    },
    /missing readiness probe command/,
  );
});

test('readiness policy scans every executable step for destructive commands', () => {
  const workflow = `
on:
  schedule: [{ cron: "17 13 * * 1" }]
  workflow_dispatch:
jobs:
  check-runner:
    timeout-minutes: 10
    steps:
      - run: node scripts/check-release-runner-readiness.mjs
  unrelated-job:
    steps:
      - name: A later executable step must not escape the denylist
        run: >-
          tool screen-lock
`;

  assert.throws(
    () => assertReadinessWorkflowPolicy(workflow),
    /readiness workflow contains a destructive command/,
  );
});