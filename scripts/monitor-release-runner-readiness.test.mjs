import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  THRESHOLD_MINUTES,
  alertBody,
  alertTitle,
  staleQueuedLabels,
  run,
} = require('../.github/scripts/monitor-release-runner-readiness.cjs');
const watchdog = require('../.github/scripts/watch-release-runner-monitor.cjs');

test('stale queued readiness jobs resolve to their exact release-runner labels', () => {
  const now = Date.parse('2026-09-05T12:30:00Z');
  const jobs = [
    { name: 'readiness-win-x64', status: 'queued', created_at: '2026-09-05T12:14:59Z' },
    { name: 'readiness-linux-arm64', status: 'queued', created_at: '2026-09-05T12:20:00Z' },
    { name: 'readiness-darwin-x64', status: 'in_progress', created_at: '2026-09-05T12:00:00Z' },
    { name: 'unrelated-job', status: 'queued', created_at: '2026-09-05T12:00:00Z' },
  ];

  assert.deepEqual(staleQueuedLabels(jobs, now), ['desktop-release-win-x64']);
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
  assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/);
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
  assert.match(workflow, /cron: '7,22,37,52 \* \* \* \*'/);
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