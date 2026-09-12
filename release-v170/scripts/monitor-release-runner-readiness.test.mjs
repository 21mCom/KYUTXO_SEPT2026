import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  GITHUB_ACTIONS_CRON_FIELD_RANGES,
  validateGitHubActionsCron,
} from './check-workflow-schedules.mjs';

const require = createRequire(import.meta.url);
const {
  THRESHOLD_MINUTES,
  alertBody,
  alertTitle,
  releaseRunnerLabelForJobName,
  staleQueuedLabels,
  run,
} = require('../.github/scripts/monitor-release-runner-readiness.cjs');
const watchdog = require('../.github/scripts/watch-release-runner-monitor.cjs');
const {
  runLiveContract,
} = require('../.github/scripts/check-release-runner-monitor-live-contract.cjs');

function assertGithubActionsCron(expression) {
  assert.ok(validateGitHubActionsCron(expression), `invalid GitHub Actions cron: ${expression}`);
}

function workflowCron(workflow) {
  const match = workflow.match(/^\s*-\s+cron:\s*['"]([^'"]+)['"]\s*$/m);
  assert.ok(match, 'workflow must contain a quoted cron schedule');
  return match[1];
}

function cronFieldValues(field, minimum, maximum) {
  const values = new Set();
  for (const item of field.split(',')) {
    const [range, stepText] = item.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    const [start, end] = range === '*'
      ? [minimum, maximum]
      : range.includes('-')
        ? range.split('-').map(Number)
        : [Number(range), Number(range)];
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function maximumScheduleGapMinutes(expression) {
  assertGithubActionsCron(expression);
  const fields = expression.trim().split(/\s+/);
  const allowed = fields.map((field, index) => (
    cronFieldValues(field, ...GITHUB_ACTIONS_CRON_FIELD_RANGES[index])
  ));
  const matches = [];
  const start = Date.UTC(2028, 0, 1);
  const end = start + 8 * 24 * 60 * 60_000;
  for (let timestamp = start; timestamp < end; timestamp += 60_000) {
    const date = new Date(timestamp);
    const minuteMatches = allowed[0].has(date.getUTCMinutes());
    const hourMatches = allowed[1].has(date.getUTCHours());
    const monthMatches = allowed[3].has(date.getUTCMonth() + 1);
    const dayOfMonthMatches = allowed[2].has(date.getUTCDate());
    const dayOfWeekMatches = allowed[4].has(date.getUTCDay());
    const dayMatches = fields[2] === '*' || fields[4] === '*'
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;
    if (minuteMatches && hourMatches && monthMatches && dayMatches) matches.push(timestamp);
  }
  assert.ok(matches.length >= 2, `schedule must run at least twice in the evaluation window: ${expression}`);
  return Math.max(
    ...matches.slice(1).map((timestamp, index) => (timestamp - matches[index]) / 60_000),
  );
}

test('GitHub Actions cron validation rejects malformed schedules', () => {
  for (const expression of [
    '*/5 * * *',
    '*/5 * * * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 7',
    '*/0 * * * *',
  ]) {
    assert.throws(() => assertGithubActionsCron(expression), undefined, expression);
  }
});

test('maximum schedule gap is derived from valid GitHub Actions cron expressions', () => {
  assert.equal(maximumScheduleGapMinutes('*/5 * * * *'), 5);
  assert.equal(maximumScheduleGapMinutes('7,22,37,52 * * * *'), 15);
  assert.equal(maximumScheduleGapMinutes('0 */2 * * *'), 120);
});

test('stale queued readiness jobs resolve to their exact release-runner labels', () => {
  const now = Date.parse('2026-09-05T12:30:00Z');
  const jobs = [
    { name: 'readiness-win-x64', status: 'queued', created_at: '2026-09-05T12:14:59Z' },
    { name: 'readiness-linux-arm64', status: 'queued', created_at: '2026-09-05T12:20:00Z' },
    { name: 'readiness-darwin-x64', status: 'in_progress', created_at: '2026-09-05T12:00:00Z' },
    { name: 'unrelated-job', status: 'queued', created_at: '2026-09-05T12:00:00Z' },
  ];

  assert.deepEqual(staleQueuedLabels(jobs, now), ['desktop-release-win-x64']);
  assert.equal(releaseRunnerLabelForJobName('readiness-win-x64'), 'desktop-release-win-x64');
});

test('manual live contract is isolated from alert issues and runner management', () => {
  const controller = fs.readFileSync(
    new URL('../.github/workflows/desktop-release-runner-monitor-contract.yml', import.meta.url),
    'utf8',
  );
  const fixture = fs.readFileSync(
    new URL('../.github/workflows/desktop-release-runner-monitor-contract-fixture.yml', import.meta.url),
    'utf8',
  );
  const contract = fs.readFileSync(
    new URL('../.github/scripts/check-release-runner-monitor-live-contract.cjs', import.meta.url),
    'utf8',
  );

  assert.match(controller, /workflow_dispatch:/);
  assert.match(controller, /permissions:\s*\n\s+actions: write\s*\n\s+contents: read/);
  assert.doesNotMatch(controller, /issues: write|schedule:/);
  assert.match(fixture, /release-runner-monitor-contract-no-runner/);
  assert.match(fixture, /name: readiness-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}/);
  assert.match(contract, /releaseRunnerLabelForJobName\(queuedJob\.name\)/);
  assert.match(contract, /cancelWorkflowRun/);
  assert.match(contract, /\['failure', 'success'\]/);
  assert.doesNotMatch(fixture, /\[\[.*\$\{\{ inputs\.outcome/);
  assert.match(fixture, /CONTRACT_OUTCOME: \$\{\{ inputs\.outcome \}\}/);
  assert.doesNotMatch(contract, /issues\.|deleteSelfHostedRunner|removeAllCustomLabels|setCustomLabels/);
});

function liveContractHarness({ failFirstRunLookup = false } = {}) {
  const runs = [];
  const cancelled = new Set();
  const calls = [];
  let nextId = 100;
  let shouldFailLookup = failFirstRunLookup;
  const github = {
    rest: {
      actions: {
        createWorkflowDispatch: async ({ inputs }) => {
          const id = nextId++;
          calls.push({ type: 'dispatch', id, outcome: inputs.outcome });
          runs.unshift({
            id,
            display_title: `${inputs.contract_id}-${inputs.outcome}`,
            created_at: new Date().toISOString(),
            status: inputs.outcome === 'queued' ? 'queued' : 'completed',
            outcome: inputs.outcome,
          });
        },
        listWorkflowRuns: async () => {
          if (shouldFailLookup) {
            shouldFailLookup = false;
            throw new Error('simulated lookup failure');
          }
          return { data: { workflow_runs: runs } };
        },
        listJobsForWorkflowRun: async ({ run_id }) => {
          const run = runs.find((candidate) => candidate.id === run_id);
          const conclusion = cancelled.has(run_id)
            ? 'cancelled'
            : run.outcome === 'queued' ? null : run.outcome;
          return {
            data: {
              jobs: [{
                name: 'readiness-linux-x64',
                status: conclusion ? 'completed' : 'queued',
                conclusion,
              }],
            },
          };
        },
        cancelWorkflowRun: async ({ run_id }) => {
          calls.push({ type: 'cancel', runId: run_id });
          cancelled.add(run_id);
          const run = runs.find((candidate) => candidate.id === run_id);
          if (run) run.status = 'completed';
        },
      },
    },
  };
  const core = {
    info: (message) => calls.push({ type: 'info', message }),
    warning: (message) => calls.push({ type: 'warning', message }),
  };
  return { calls, core, github };
}

test('live contract observes queued, cancelled, failed, and successful job payloads', async () => {
  const { calls, core, github } = liveContractHarness();
  await runLiveContract({
    github,
    core,
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      ref: 'main',
      runId: 7,
      runAttempt: 1,
    },
  });

  assert.deepEqual(
    calls.filter((call) => call.type === 'dispatch').map((call) => call.outcome),
    ['queued', 'failure', 'success'],
  );
  assert.equal(calls.filter((call) => call.type === 'cancel').length, 1);
  for (const state of ['queued', 'cancelled', 'failure', 'success']) {
    assert.ok(calls.some((call) => call.type === 'info' && call.message.startsWith(`PASS ${state}:`)));
  }
});

test('live contract rediscovers and cancels a queued fixture when initial lookup fails', async () => {
  const { calls, core, github } = liveContractHarness({ failFirstRunLookup: true });
  await assert.rejects(
    runLiveContract({
      github,
      core,
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        ref: 'main',
        runId: 8,
        runAttempt: 1,
      },
    }),
    /simulated lookup failure/,
  );
  assert.equal(calls.filter((call) => call.type === 'cancel').length, 1);
});

test('alert copy names the runner and gives a recovery path', () => {
  const label = 'desktop-release-darwin-arm64';
  assert.match(alertTitle(label), new RegExp(label));
  const body = alertBody({
    label,
    queuedAt: '2026-09-05T12:00:00Z',
    runUrl: 'https://github.example/readiness/1',
  });
  assert.match(body, new RegExp(label));
  assert.match(body, new RegExp(`${THRESHOLD_MINUTES} minutes`));
  assert.match(body, /manually rerun/);
});

test('hosted monitor is scheduled, least-privilege, and does not manage runners', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/desktop-release-runner-monitor.yml', import.meta.url),
    'utf8',
  );
  const cron = workflowCron(workflow);
  assertGithubActionsCron(cron);
  const maximumGapMinutes = maximumScheduleGapMinutes(cron);
  assert.ok(
    maximumGapMinutes <= THRESHOLD_MINUTES,
    `monitor maximum schedule gap (${maximumGapMinutes}m) must not exceed stale-runner threshold (${THRESHOLD_MINUTES}m)`,
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /permissions:\s*\n\s+actions: read\s*\n\s+contents: read\s*\n\s+issues: write/);
  assert.doesNotMatch(workflow, /self-hosted|administration:|organization:|runner-groups:/);

  const monitor = fs.readFileSync(
    new URL('../.github/scripts/monitor-release-runner-readiness.cjs', import.meta.url),
    'utf8',
  );
  assert.match(monitor, /listWorkflowRuns/);
  assert.match(monitor, /listJobsForWorkflowRun/);
  assert.doesNotMatch(monitor, /deleteSelfHostedRunner|removeAllCustomLabels|setCustomLabels|updateRepository/);
});

test('monitor creates one alert for a stale label and closes it after recovery', async () => {
  const calls = [];
  let jobs = [{
    name: 'readiness-linux-x64',
    status: 'queued',
    created_at: '2020-01-01T00:00:00Z',
  }];
  const github = {
    paginate: async () => {
      return calls.some((call) => call.type === 'create')
        ? [{
            number: 7,
            title: alertTitle('desktop-release-linux-x64'),
            created_at: '2026-09-05T12:00:00Z',
          }]
        : [];
    },
    rest: {
      actions: {
        listWorkflowRuns: async ({ status }) => ({
          data: {
            workflow_runs: status === 'queued' || status === 'completed'
              ? [{ id: status === 'queued' ? 42 : 43, html_url: `https://example.test/run/${status}` }]
              : [],
          },
        }),
        listJobsForWorkflowRun: async ({ run_id }) => ({
          data: { jobs: run_id === 42 ? jobs : [] },
        }),
      },
      issues: {
        listForRepo: 'listForRepo',
        create: async (request) => {
          calls.push({ type: 'create', request });
          return { data: { html_url: 'https://example.test/issues/7' } };
        },
        createComment: async (request) => calls.push({ type: 'comment', request }),
        update: async (request) => calls.push({ type: 'update', request }),
      },
    },
  };
  const core = {
    info: () => {},
    setFailed: (message) => calls.push({ type: 'failed', message }),
    warning: () => calls.push({ type: 'warning' }),
  };
  const context = { repo: { owner: 'owner', repo: 'repo' } };

  await run({ github, context, core });
  assert.equal(calls.filter((call) => call.type === 'create').length, 1);
  assert.match(calls.find((call) => call.type === 'failed').message, /desktop-release-linux-x64/);

  await run({ github, context, core });
  assert.equal(calls.filter((call) => call.type === 'create').length, 1);
  assert.equal(calls.filter((call) => call.type === 'warning').length, 1);

  jobs = [];
  await run({ github, context, core });
  assert.equal(calls.filter((call) => call.type === 'comment').length, 0);
  assert.equal(calls.filter((call) => call.type === 'update').length, 0);

  github.rest.actions.listJobsForWorkflowRun = async ({ run_id }) => ({
    data: {
      jobs: run_id === 43
        ? [{
            name: 'readiness-linux-x64',
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-09-05T12:30:00Z',
            completed_at: '2026-09-05T12:35:00Z',
          }]
        : [],
    },
  });
  await run({ github, context, core });
  assert.equal(calls.filter((call) => call.type === 'comment').length, 1);
  assert.equal(calls.filter((call) => call.type === 'update').length, 1);
  assert.equal(calls.find((call) => call.type === 'update').request.state, 'closed');
});

test('cancelled and failed follow-up jobs do not close an alert', async () => {
  for (const conclusion of ['cancelled', 'failure']) {
    const calls = [];
    const github = {
      paginate: async () => [{
        number: 9,
        title: alertTitle('desktop-release-win-x64'),
        created_at: '2026-09-05T12:00:00Z',
      }],
      rest: {
        actions: {
          listWorkflowRuns: async ({ status }) => ({
            data: {
              workflow_runs: status === 'completed'
                ? [{ id: 99, html_url: 'https://example.test/run/99' }]
                : [],
            },
          }),
          listJobsForWorkflowRun: async () => ({
            data: {
              jobs: [{
                name: 'readiness-win-x64',
                status: 'completed',
                conclusion,
                created_at: '2026-09-05T12:30:00Z',
                completed_at: '2026-09-05T12:35:00Z',
              }],
            },
          }),
        },
        issues: {
          listForRepo: 'listForRepo',
          create: async () => assert.fail('must not create a duplicate alert'),
          createComment: async () => calls.push('comment'),
          update: async () => calls.push('update'),
        },
      },
    };
    await run({
      github,
      context: { repo: { owner: 'owner', repo: 'repo' } },
      core: { info: () => {}, setFailed: () => {}, warning: () => {} },
    });
    assert.deepEqual(calls, []);
  }
});

test('independent watchdog is scheduled, least-privilege, and never uses release runners', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/desktop-release-runner-monitor-watchdog.yml', import.meta.url),
    'utf8',
  );
  const cron = workflowCron(workflow);
  assertGithubActionsCron(cron);
  const maximumGapMinutes = maximumScheduleGapMinutes(cron);
  assert.ok(
    maximumGapMinutes * 2 <= watchdog.SILENCE_MINUTES,
    `watchdog maximum schedule gap (${maximumGapMinutes}m) must leave a full extra cadence inside its silence threshold (${watchdog.SILENCE_MINUTES}m)`,
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /permissions:\s*\n\s+actions: read\s*\n\s+contents: read\s*\n\s+issues: write/);
  assert.doesNotMatch(workflow, /self-hosted|administration:|organization:|runner-groups:/);

  const script = fs.readFileSync(
    new URL('../.github/scripts/watch-release-runner-monitor.cjs', import.meta.url),
    'utf8',
  );
  assert.match(script, /listWorkflowRuns/);
  assert.doesNotMatch(script, /listJobsForWorkflowRun|deleteSelfHostedRunner|removeAllCustomLabels|setCustomLabels/);
});

test('watchdog alert names and links the silent monitor', () => {
  const body = watchdog.alertBody({
    latestRunUrl: 'https://github.example/monitor/7',
    lastCompletedAt: '2026-09-05T12:00:00Z',
  });
  assert.match(watchdog.ALERT_TITLE, new RegExp(watchdog.MONITOR_NAME));
  assert.match(body, new RegExp(watchdog.MONITOR_NAME));
  assert.match(body, /https:\/\/github\.example\/monitor\/7/);
  assert.match(body, new RegExp(`${watchdog.SILENCE_MINUTES} minutes`));
  assert.match(body, /Owner: repository maintainers/);
  assert.match(body, /dispatch .* manually/);
});

function watchdogHarness({ runs, openIssues = [] }) {
  const calls = [];
  const github = {
    paginate: async () => openIssues,
    rest: {
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }),
      },
      issues: {
        listForRepo: 'listForRepo',
        create: async (request) => {
          calls.push({ type: 'create', request });
          return { data: { html_url: 'https://example.test/issues/heartbeat' } };
        },
        createComment: async (request) => calls.push({ type: 'comment', request }),
        update: async (request) => calls.push({ type: 'update', request }),
      },
    },
  };
  const invocation = {
    github,
    context: { repo: { owner: 'owner', repo: 'repo' } },
    core: {
      info: (message) => calls.push({ type: 'info', message }),
      warning: (message) => calls.push({ type: 'warning', message }),
      setFailed: (message) => calls.push({ type: 'failed', message }),
    },
    now: Date.parse('2026-09-05T12:30:00Z'),
  };
  return { calls, invocation };
}

test('watchdog treats exactly 30 minutes since completion as silent', async () => {
  const { calls, invocation } = watchdogHarness({
    runs: [{
      status: 'completed',
      conclusion: 'success',
      updated_at: '2026-09-05T12:00:00Z',
      html_url: 'https://example.test/runs/threshold',
    }],
  });

  await watchdog.run(invocation);

  assert.equal(calls.filter((call) => call.type === 'create').length, 1);
  assert.equal(calls.filter((call) => call.type === 'failed').length, 1);
});

test('watchdog with no run history links the monitor workflow Actions page', async () => {
  const { calls, invocation } = watchdogHarness({ runs: [] });

  await watchdog.run(invocation);

  const created = calls.find((call) => call.type === 'create');
  assert.ok(created);
  assert.match(
    created.request.body,
    /https:\/\/github\.com\/owner\/repo\/actions\/workflows\/desktop-release-runner-monitor\.yml/,
  );
  assert.match(created.request.body, /No completed run was found/);
});

test('watchdog treats malformed completion timestamps as missing and opens an alert', async () => {
  const { calls, invocation } = watchdogHarness({
    runs: [{
      status: 'completed',
      updated_at: 'not-a-timestamp',
      html_url: 'https://example.test/runs/malformed',
    }],
  });

  await watchdog.run(invocation);

  const created = calls.find((call) => call.type === 'create');
  assert.ok(created);
  assert.match(created.request.body, /runs\/malformed/);
  assert.match(created.request.body, /Last completion: No completed run was found/);
  assert.equal(calls.filter((call) => call.type === 'failed').length, 1);
});

test('watchdog treats completed runs with missing timestamp fields as silent', async () => {
  const { calls, invocation } = watchdogHarness({
    runs: [{
      status: 'completed',
      html_url: 'https://example.test/runs/missing-timestamp',
    }],
  });

  await watchdog.run(invocation);

  const created = calls.find((call) => call.type === 'create');
  assert.ok(created);
  assert.match(created.request.body, /Last completion: No completed run was found/);
  assert.equal(calls.filter((call) => call.type === 'failed').length, 1);
});

test('watchdog skips a malformed preferred timestamp when a valid fallback exists', async () => {
  const run = {
    status: 'completed',
    updated_at: 'not-a-timestamp',
    run_started_at: '2026-09-05T12:05:00Z',
    created_at: '2026-09-05T12:00:00Z',
  };

  assert.equal(watchdog.completedAt(run), '2026-09-05T12:05:00Z');
  assert.equal(watchdog.isSilent(run, Date.parse('2026-09-05T12:30:00Z')), false);
});

test('watchdog links a newer in-progress run but measures silence from the older completion', async () => {
  const { calls, invocation } = watchdogHarness({
    runs: [
      {
        status: 'in_progress',
        created_at: '2026-09-05T12:20:00Z',
        html_url: 'https://example.test/runs/in-progress',
      },
      {
        status: 'completed',
        conclusion: 'success',
        updated_at: '2026-09-05T11:59:59Z',
        html_url: 'https://example.test/runs/completed',
      },
    ],
  });

  await watchdog.run(invocation);

  const created = calls.find((call) => call.type === 'create');
  assert.ok(created);
  assert.match(created.request.body, /runs\/in-progress/);
  assert.match(created.request.body, /Last completion: 2026-09-05T11:59:59Z/);
});

test('cancelled monitor runs count as heartbeat completions', async () => {
  const { calls, invocation } = watchdogHarness({
    runs: [{
      status: 'completed',
      conclusion: 'cancelled',
      updated_at: '2026-09-05T12:05:00Z',
      html_url: 'https://example.test/runs/cancelled',
    }],
  });

  await watchdog.run(invocation);

  assert.equal(calls.filter((call) => call.type === 'create').length, 0);
  assert.equal(calls.filter((call) => call.type === 'failed').length, 0);
});

test('watchdog opens one alert after silence and closes it only after a newer completion', async () => {
  const calls = [];
  let runs = [{
    status: 'completed',
    updated_at: '2026-09-05T11:00:00Z',
    html_url: 'https://example.test/runs/old',
  }];
  const github = {
    paginate: async () => calls.some((call) => call.type === 'create')
      ? [{
          number: 11,
          title: watchdog.ALERT_TITLE,
          created_at: '2026-09-05T12:00:00Z',
          html_url: 'https://example.test/issues/11',
        }]
      : [],
    rest: {
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }),
      },
      issues: {
        listForRepo: 'listForRepo',
        create: async (request) => {
          calls.push({ type: 'create', request });
          return { data: { html_url: 'https://example.test/issues/11' } };
        },
        createComment: async (request) => calls.push({ type: 'comment', request }),
        update: async (request) => calls.push({ type: 'update', request }),
      },
    },
  };
  const invocation = {
    github,
    context: { repo: { owner: 'owner', repo: 'repo' } },
    core: {
      info: () => {},
      warning: () => calls.push({ type: 'warning' }),
      setFailed: (message) => calls.push({ type: 'failed', message }),
    },
    now: Date.parse('2026-09-05T12:00:01Z'),
  };

  await watchdog.run(invocation);
  assert.equal(calls.filter((call) => call.type === 'create').length, 1);
  assert.match(calls.find((call) => call.type === 'create').request.body, /runs\/old/);

  await watchdog.run(invocation);
  assert.equal(calls.filter((call) => call.type === 'create').length, 1);
  assert.equal(calls.filter((call) => call.type === 'warning').length, 1);

  runs = [{
    status: 'completed',
    conclusion: 'failure',
    updated_at: '2026-09-05T12:05:00Z',
    html_url: 'https://example.test/runs/recovered',
  }];
  await watchdog.run(invocation);
  assert.equal(calls.filter((call) => call.type === 'comment').length, 1);
  assert.equal(calls.filter((call) => call.type === 'update').length, 1);
});

test('watchdog keeps a valid alert open until a strictly newer completion arrives', async () => {
  const alertCreatedAt = '2026-09-05T12:00:00Z';
  const { calls, invocation } = watchdogHarness({
    runs: [{
      status: 'completed',
      updated_at: '2026-09-05T11:59:59Z',
      html_url: 'https://example.test/runs/older',
    }],
    openIssues: [{
      number: 13,
      title: watchdog.ALERT_TITLE,
      created_at: alertCreatedAt,
      html_url: 'https://example.test/issues/13',
    }],
  });

  await watchdog.run(invocation);
  assert.equal(calls.filter((call) => call.type === 'comment').length, 0);
  assert.equal(calls.filter((call) => call.type === 'update').length, 0);

  invocation.github.rest.actions.listWorkflowRuns = async () => ({
    data: {
      workflow_runs: [{
        status: 'completed',
        updated_at: alertCreatedAt,
        html_url: 'https://example.test/runs/equal',
      }],
    },
  });
  await watchdog.run(invocation);
  assert.equal(calls.filter((call) => call.type === 'comment').length, 0);
  assert.equal(calls.filter((call) => call.type === 'update').length, 0);

  invocation.github.rest.actions.listWorkflowRuns = async () => ({
    data: {
      workflow_runs: [{
        status: 'completed',
        updated_at: '2026-09-05T12:00:01Z',
        html_url: 'https://example.test/runs/newer',
      }],
    },
  });
  await watchdog.run(invocation);
  assert.equal(calls.filter((call) => call.type === 'comment').length, 1);
  assert.equal(calls.filter((call) => call.type === 'update').length, 1);
  assert.match(
    calls.find((call) => call.type === 'comment').request.body,
    /runs\/newer/,
  );
  assert.equal(calls.find((call) => call.type === 'update').request.state, 'closed');
});

for (const [description, createdAt] of [
  ['malformed', 'not-a-timestamp'],
  ['missing', undefined],
]) {
  test(`watchdog closes a recovered alert with a ${description} issue creation timestamp`, async () => {
    const { calls, invocation } = watchdogHarness({
      runs: [{
        status: 'completed',
        updated_at: '2026-09-05T12:05:00Z',
        html_url: `https://example.test/runs/recovered-${description}`,
      }],
      openIssues: [{
        number: 12,
        title: watchdog.ALERT_TITLE,
        created_at: createdAt,
        html_url: `https://example.test/issues/${description}`,
      }],
    });

    await watchdog.run(invocation);

    const comment = calls.find((call) => call.type === 'comment');
    assert.ok(comment);
    assert.match(comment.request.body, new RegExp(`runs/recovered-${description}`));
    assert.equal(calls.filter((call) => call.type === 'update').length, 1);
    assert.equal(calls.find((call) => call.type === 'update').request.state, 'closed');
    assert.match(
      calls.find((call) => call.type === 'warning').message,
      /no valid creation timestamp; closing it because a valid current completion was observed/,
    );
  });
}