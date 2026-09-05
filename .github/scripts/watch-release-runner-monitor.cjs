const MONITOR_WORKFLOW = 'desktop-release-runner-monitor.yml';
const MONITOR_NAME = 'Monitor desktop release runner readiness';
const SILENCE_MINUTES = 30;
const ALERT_TITLE = `[release-runner-monitor-silent] ${MONITOR_NAME} has not completed`;

function workflowUrl({ owner, repo }) {
  return `https://github.com/${owner}/${repo}/actions/workflows/${MONITOR_WORKFLOW}`;
}

function completedAt(run) {
  if (run.status !== 'completed') return undefined;
  return run.updated_at || run.run_started_at || run.created_at;
}

function isSilent(run, now = Date.now(), silenceMinutes = SILENCE_MINUTES) {
  const timestamp = run && completedAt(run);
  return !timestamp || Date.parse(timestamp) <= now - silenceMinutes * 60_000;
}

function alertBody({ latestRunUrl, lastCompletedAt }) {
  return [
    `The independent watchdog has not seen **${MONITOR_NAME}** complete within ${SILENCE_MINUTES} minutes.`,
    '',
    `Latest monitor run: ${latestRunUrl}`,
    `Last completion: ${lastCompletedAt || 'No completed run was found'}`,
    '',
    'Owner: repository maintainers responsible for desktop releases.',
    `Recovery: inspect the linked run, restore the monitor workflow's schedule and permissions, then dispatch **${MONITOR_NAME}** manually.`,
    'This issue closes only after the watchdog observes a monitor completion newer than this alert.',
    '',
    '<!-- release-runner-monitor-watchdog -->',
  ].join('\n');
}

async function run({ github, context, core, now = Date.now() }) {
  const { owner, repo } = context.repo;
  const response = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: MONITOR_WORKFLOW,
    per_page: 20,
  });
  const runs = response.data.workflow_runs;
  const latestRun = runs[0];
  const latestCompletedRun = runs.find((candidate) => completedAt(candidate));
  const latestRunUrl = latestRun?.html_url || workflowUrl({ owner, repo });
  const lastCompletedAt = latestCompletedRun && completedAt(latestCompletedRun);

  const openIssues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    creator: 'github-actions[bot]',
    per_page: 100,
  });
  const alert = openIssues.find((issue) => issue.title === ALERT_TITLE);

  if (isSilent(latestCompletedRun, now)) {
    if (alert) {
      core.warning(`${MONITOR_NAME} is still silent; alert issue is already open: ${alert.html_url}`);
      return;
    }
    const created = await github.rest.issues.create({
      owner,
      repo,
      title: ALERT_TITLE,
      body: alertBody({ latestRunUrl, lastCompletedAt }),
    });
    core.setFailed(`${MONITOR_NAME} has not completed within ${SILENCE_MINUTES} minutes: ${created.data.html_url}`);
    return;
  }

  if (!alert || Date.parse(lastCompletedAt) <= Date.parse(alert.created_at)) return;
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: alert.number,
    body: `Recovery detected: **${MONITOR_NAME}** completed at ${lastCompletedAt}. Latest run: ${latestRunUrl}`,
  });
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: alert.number,
    state: 'closed',
    state_reason: 'completed',
  });
  core.info(`Closed recovered heartbeat alert for ${MONITOR_NAME}`);
}

module.exports = {
  ALERT_TITLE,
  MONITOR_NAME,
  MONITOR_WORKFLOW,
  SILENCE_MINUTES,
  alertBody,
  completedAt,
  isSilent,
  run,
  workflowUrl,
};