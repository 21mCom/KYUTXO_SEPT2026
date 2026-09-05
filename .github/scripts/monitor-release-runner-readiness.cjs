const READINESS_WORKFLOW = 'desktop-release-runner-readiness.yml';
const THRESHOLD_MINUTES = 15;
const ALERT_PREFIX = '[release-runner-offline]';

const JOB_LABELS = new Map([
  ['readiness-win-x64', 'desktop-release-win-x64'],
  ['readiness-darwin-x64', 'desktop-release-darwin-x64'],
  ['readiness-darwin-arm64', 'desktop-release-darwin-arm64'],
  ['readiness-linux-x64', 'desktop-release-linux-x64'],
  ['readiness-linux-arm64', 'desktop-release-linux-arm64'],
]);

function staleQueuedLabels(jobs, now = Date.now(), thresholdMinutes = THRESHOLD_MINUTES) {
  const cutoff = now - thresholdMinutes * 60_000;
  return [...new Set(
    jobs
      .filter((job) => job.status === 'queued')
      .filter((job) => Date.parse(job.created_at) <= cutoff)
      .map((job) => JOB_LABELS.get(job.name))
      .filter(Boolean),
  )].sort();
}

function releaseRunnerLabelForJobName(jobName) {
  return JOB_LABELS.get(jobName);
}

function alertTitle(label) {
  return `${ALERT_PREFIX} ${label} has not accepted its readiness job`;
}

function alertBody({ label, runUrl, queuedAt }) {
  return [
    `The hosted readiness monitor found that \`${label}\` has remained queued for more than ${THRESHOLD_MINUTES} minutes.`,
    '',
    `Readiness run: ${runUrl}`,
    `Queued since: ${queuedAt}`,
    '',
    'Restore the runner registration and its logged-in interactive desktop session, then manually rerun **Check desktop release runner readiness**.',
    'This issue will close automatically after a later monitor pass confirms that this label no longer has a stale queued readiness job.',
    '',
    '<!-- release-runner-readiness-monitor -->',
  ].join('\n');
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const runResponses = await Promise.all(
    ['queued', 'in_progress', 'completed'].map((status) => github.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: READINESS_WORKFLOW,
      status,
      per_page: 20,
    })),
  );
  const runs = runResponses.flatMap((response) => response.data.workflow_runs);
  const jobsByRun = await Promise.all(
    runs.map(async (workflowRun) => ({
      workflowRun,
      jobs: (
        await github.rest.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: workflowRun.id,
          filter: 'latest',
          per_page: 100,
        })
      ).data.jobs,
    })),
  );

  const staleByLabel = new Map();
  const successfulAtByLabel = new Map();
  for (const { workflowRun, jobs } of jobsByRun) {
    for (const label of staleQueuedLabels(jobs)) {
      const job = jobs.find((candidate) => releaseRunnerLabelForJobName(candidate.name) === label);
      staleByLabel.set(label, {
        label,
        queuedAt: job.created_at,
        runUrl: workflowRun.html_url,
      });
    }
    for (const job of jobs) {
      const label = releaseRunnerLabelForJobName(job.name);
      if (!label || job.status !== 'completed' || job.conclusion !== 'success') continue;
      const completedAt = job.completed_at || job.started_at || job.created_at;
      if (!completedAt) continue;
      const prior = successfulAtByLabel.get(label);
      if (!prior || Date.parse(completedAt) > Date.parse(prior)) {
        successfulAtByLabel.set(label, completedAt);
      }
    }
  }

  const openIssues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    creator: 'github-actions[bot]',
    per_page: 100,
  });
  const alerts = openIssues.filter((issue) => issue.title.startsWith(`${ALERT_PREFIX} `));

  for (const alert of staleByLabel.values()) {
    const title = alertTitle(alert.label);
    if (alerts.some((issue) => issue.title === title)) {
      core.warning(`${alert.label} is still unavailable; alert issue is already open`);
      continue;
    }
    const created = await github.rest.issues.create({
      owner,
      repo,
      title,
      body: alertBody(alert),
    });
    core.setFailed(`${alert.label} stayed queued beyond ${THRESHOLD_MINUTES} minutes: ${created.data.html_url}`);
  }

  for (const issue of alerts) {
    const label = [...JOB_LABELS.values()].find((candidate) => issue.title === alertTitle(candidate));
    if (!label || staleByLabel.has(label)) continue;
    const successfulAt = successfulAtByLabel.get(label);
    if (!successfulAt || Date.parse(successfulAt) <= Date.parse(issue.created_at)) continue;
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `Recovery detected: \`${label}\` completed a newer readiness job successfully at ${successfulAt}.`,
    });
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      state: 'closed',
      state_reason: 'completed',
    });
    core.info(`Closed recovered runner alert for ${label}`);
  }
}

module.exports = {
  ALERT_PREFIX,
  JOB_LABELS,
  THRESHOLD_MINUTES,
  alertBody,
  alertTitle,
  run,
  releaseRunnerLabelForJobName,
  staleQueuedLabels,
};
