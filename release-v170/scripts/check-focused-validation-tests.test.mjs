import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkFocusedValidationTests,
  validationCommands,
} from './check-focused-validation-tests.mjs';

function withScripts(names, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focused-validation-tests-'));
  try {
    for (const name of names) fs.writeFileSync(path.join(directory, name), '');
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const validation = (command, enabled = true) => `
[[workflows.workflow]]
name = "fixture"
[[workflows.workflow.tasks]]
task = "shell.exec"
args = "${command}"
[workflows.workflow.metadata]
isValidation = ${enabled}
`;

test('extracts commands only from named validation workflows', () => {
  const source = [
    validation('node --test scripts/check-wired.test.mjs'),
    validation('node --test scripts/check-disabled.test.mjs', false),
  ].join('\n');
  assert.deepEqual(validationCommands(source), [
    'node --test scripts/check-wired.test.mjs',
  ]);
});

test('an unregistered focused check test fails the guard', () => {
  withScripts(['check-wired.test.mjs', 'check-dormant.test.mjs', 'other.test.mjs'], (directory) => {
    const result = checkFocusedValidationTests({
      scriptsDirectory: directory,
      replitSource: validation('node --test scripts/check-wired.test.mjs'),
      exclusions: {},
    });
    assert.deepEqual(result.files, ['check-dormant.test.mjs', 'check-wired.test.mjs']);
    assert.deepEqual(result.errors, [
      'scripts/check-dormant.test.mjs is not referenced by any named workflow with isValidation = true',
    ]);
  });
});

test('documented intentional exclusions are accepted', () => {
  withScripts(['check-platform-only.test.mjs'], (directory) => {
    const result = checkFocusedValidationTests({
      scriptsDirectory: directory,
      replitSource: '',
      exclusions: {
        'check-platform-only.test.mjs': 'Requires physical hardware unavailable in validation.',
      },
    });
    assert.deepEqual(result.errors, []);
  });
});

test('stale or undocumented exclusions fail closed', () => {
  withScripts(['check-present.test.mjs'], (directory) => {
    const result = checkFocusedValidationTests({
      scriptsDirectory: directory,
      replitSource: '',
      exclusions: {
        'check-present.test.mjs': '',
        'check-missing.test.mjs': 'No longer exists.',
      },
    });
    assert.deepEqual(result.errors, [
      'intentional exclusion check-present.test.mjs must document a non-empty reason',
      'intentional exclusion check-missing.test.mjs does not match a focused test file',
    ]);
  });
});

test('every checked-in focused check test is registered or explicitly excluded', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = checkFocusedValidationTests({
    scriptsDirectory: path.join(root, 'scripts'),
    replitSource: fs.readFileSync(path.join(root, '.replit'), 'utf8'),
  });
  assert.ok(result.files.length > 0, 'guard must discover focused check tests');
  assert.equal(result.errors.length, 0, result.errors.join('\n'));
});