import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkWorkflowSchedules,
  validateGitHubActionsCron,
} from './check-workflow-schedules.mjs';

const REPOSITORY_WORKFLOWS = fileURLToPath(new URL('../.github/workflows', import.meta.url));

function withWorkflowFiles(files, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-schedules-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, name), contents);
    }
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('every checked-in GitHub Actions cron schedule is discovered and valid', () => {
  const result = checkWorkflowSchedules(REPOSITORY_WORKFLOWS);
  assert.equal(result.errors.length, 0, result.errors.join('\n'));

  const expected = result.files.flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return [...text.matchAll(/^\s*-\s+cron\s*:/gm)].map(() => file);
  });
  assert.ok(expected.length > 0, 'repository must contain at least one cron schedule');
  assert.equal(result.schedules.length, expected.length, 'guard must discover every cron entry');
});

test('GitHub Actions cron validation accepts supported lists, ranges, and steps', () => {
  for (const cron of ['*/5 * * * *', '0/15 6-18 * * 1,3,5', '7,22,37,52 * * * *']) {
    assert.equal(validateGitHubActionsCron(cron), true, cron);
  }
});

test('GitHub Actions cron validation rejects bad field counts, ranges, and zero steps', () => {
  for (const cron of [
    '17 13 * *',
    '17 13 * * 1 extra',
    '60 13 * * 1',
    '17 24 * * 1',
    '17 13 0 * 1',
    '17 13 * 13 1',
    '17 13 * * 7',
    '*/0 13 * * 1',
    '17-5 13 * * 1',
    '17 nope * * 1',
  ]) {
    assert.equal(validateGitHubActionsCron(cron), false, cron);
  }
});

test('guard checks every schedule entry in every workflow file', () => {
  withWorkflowFiles(
    {
      'first.yml': `on:\n  schedule:\n    - cron: "0 0 * * 1"\n    - cron: "*/0 * * * *"\n`,
      'second.yaml': `on: { schedule: [{ cron: "61 2 * * 2" }] }\n`,
      'ignored.txt': `on:\n  schedule:\n    - cron: "not a workflow"\n`,
    },
    (directory) => {
      const result = checkWorkflowSchedules(directory);
      assert.equal(result.files.length, 2);
      assert.equal(result.schedules.length, 3);
      assert.equal(result.errors.length, 2);
      assert.match(result.errors[0], /first\.yml.*schedule\[1\].*"\*\/0 \* \* \* \*"/);
      assert.match(result.errors[1], /second\.yaml.*schedule\[0\].*"61 2 \* \* 2"/);
    },
  );
});

test('guard fails closed for malformed schedule shapes and non-string cron values', () => {
  withWorkflowFiles(
    {
      'not-a-list.yml': `on:\n  schedule: { cron: "0 0 * * *" }\n`,
      'not-a-string.yml': `on:\n  schedule:\n    - cron: 12345\n`,
    },
    (directory) => {
      const result = checkWorkflowSchedules(directory);
      assert.equal(result.errors.length, 2);
      assert.match(result.errors[0], /on\.schedule must be a list/);
      assert.match(result.errors[1], /not a valid GitHub Actions five-field schedule/);
    },
  );
});