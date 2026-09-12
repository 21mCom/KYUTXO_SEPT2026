const {
  releaseRunnerLabelForJobName,
} = require('./monitor-release-runner-readiness.cjs');

const FIXTURE_WORKFLOW = 'desktop-release-runner-monitor-contract-fixture.yml';
const FIXTURE_JOB_NAME = 'readiness-linux-x64';
const EXPECTED_LABEL = 'desktop-release-linux-x64';
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 3 * 60_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, load, accept, {
  timeoutMs = POLL_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await load();
    if (accept(latest)) return latest;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${description}; last observed value: ${JSON.stringify(latest)}`);
}

async function dispatchFixture({ github, owner, repo, ref, contractId, outcome }) {
  const displayTitle = `${contractId}-${outcome}`;
  const dispatchedAfter = Date.now() - 5_000;
  await github.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: FIXTURE_WORKFLOW,
    ref,
    inputs: { contract_id: contractId, outcome },
  });

  return waitFor(
    `${outcome} fixture run to appear`,
    async () => (
      await github.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: FIXTURE_WORKFLOW,
        event: 'workflow_dispatch',
        per_page: 20,
      })
    ).data.workflow_runs,
    (runs) => runs.find((run) => (
      run.display_title === displayTitle
      && Date.parse(run.created_at) >= dispatchedAfter
    )),
  ).then((runs) => runs.find((run) => run.display_title === displayTitle));
}

async function contractRuns({ github, owner, repo, contractId }) {
  const runs = (
    await github.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: FIXTURE_WORKFLOW,
      event: 'workflow_dispatch',
      per_page: 100,
    })
  ).data.workflow_runs;
  return runs.filter((run) => run.display_title.startsWith(`${contractId}-`));
}

async function fixtureJobs({ github, owner, repo, runId }) {
  return (
    await github.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      filter: 'latest',
      per_page: 100,
    })
  ).data.jobs;
}

function matchingFixtureJob(jobs) {
  return jobs.find((job) => job.name === FIXTURE_JOB_NAME);
}

async function waitForJob({ github, owner, repo, runId, description, accept }) {
  const jobs = await waitFor(
    description,
    () => fixtureJobs({ github, owner, repo, runId }),
    (observedJobs) => {
      const job = matchingFixtureJob(observedJobs);
      return job && accept(job);
    },
  );
  return matchingFixtureJob(jobs);
}

async function runLiveContract({ github, context, core }) {
  const { owner, repo } = context.repo;
  const ref = context.ref;
  const contractId = `release-runner-monitor-contract-${context.runId}-${context.runAttempt}`;
  const activeRunIds = new Set();

  try {
    const queuedRun = await dispatchFixture({
      github, owner, repo, ref, contractId, outcome: 'queued',
    });
    activeRunIds.add(queuedRun.id);
    const queuedJob = await waitForJob({
      github,
      owner,
      repo,
      runId: queuedRun.id,
      description: 'the controlled readiness fixture job to be queued',
      accept: (job) => job.status === 'queued',
    });
    const label = releaseRunnerLabelForJobName(queuedJob.name);
    if (label !== EXPECTED_LABEL) {
      throw new Error(`Expected ${FIXTURE_JOB_NAME} to resolve to ${EXPECTED_LABEL}, got ${label || 'no label'}`);
    }
    core.info(`PASS queued: ${queuedJob.name} resolved to ${label}`);

    await github.rest.actions.cancelWorkflowRun({ owner, repo, run_id: queuedRun.id });
    const cancelledJob = await waitForJob({
      github,
      owner,
      repo,
      runId: queuedRun.id,
      description: 'the controlled readiness fixture job to become cancelled',
      accept: (job) => job.status === 'completed' && job.conclusion === 'cancelled',
    });
    activeRunIds.delete(queuedRun.id);
    core.info(`PASS cancelled: ${cancelledJob.name} completed as cancelled`);

    for (const outcome of ['failure', 'success']) {
      const fixtureRun = await dispatchFixture({
        github, owner, repo, ref, contractId, outcome,
      });
      activeRunIds.add(fixtureRun.id);
      const completedJob = await waitForJob({
        github,
        owner,
        repo,
        runId: fixtureRun.id,
        description: `the controlled readiness fixture job to complete as ${outcome}`,
        accept: (job) => job.status === 'completed',
      });
      activeRunIds.delete(fixtureRun.id);
      if (completedJob.conclusion !== outcome) {
        throw new Error(`Expected ${outcome} fixture conclusion, got ${completedJob.conclusion}`);
      }
      if (releaseRunnerLabelForJobName(completedJob.name) !== EXPECTED_LABEL) {
        throw new Error(`${outcome} fixture did not retain the exact readiness matrix job name`);
      }
      core.info(`PASS ${outcome}: ${completedJob.name} completed as ${outcome}`);
    }
  } finally {
    try {
      for (const run of await contractRuns({ github, owner, repo, contractId })) {
        if (run.status !== 'completed') activeRunIds.add(run.id);
      }
    } catch (error) {
      core.warning(`Could not rediscover contract fixture runs during cleanup: ${error.message}`);
    }
    await Promise.allSettled([...activeRunIds].map((runId) => (
      github.rest.actions.cancelWorkflowRun({ owner, repo, run_id: runId })
    )));
  }
}

module.exports = {
  EXPECTED_LABEL,
  FIXTURE_JOB_NAME,
  FIXTURE_WORKFLOW,
  contractRuns,
  matchingFixtureJob,
  runLiveContract,
  waitFor,
};