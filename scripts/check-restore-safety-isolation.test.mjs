import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-restore-safety-isolation.js',
);

function validReplit() {
  return `
[[workflows.workflow]]
name = "Project"
[[workflows.workflow.tasks]]
task = "workflow.run"
args = "restore-safety-isolation-guard"

[[workflows.workflow]]
name = "encrypted-backup-restore-safety-browser-check"
[[workflows.workflow.tasks]]
task = "shell.exec"
args = "node scripts/check-encrypted-backup-restore-safety-browser.mjs"
[workflows.workflow.metadata]
isValidation = true

[[workflows.workflow]]
name = "restore-safety-isolation-guard"
[[workflows.workflow.tasks]]
task = "shell.exec"
args = "node scripts/check-restore-safety-isolation.js && node --test scripts/check-restore-safety-isolation.test.mjs"
[workflows.workflow.metadata]
isValidation = true
`;
}

function runFixture({ inbox = '// inbox-only journey\n', replit = validReplit() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-isolation-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(
    path.join(root, 'scripts/check-transaction-inbox-saved-view-snooze-browser.mjs'),
    inbox,
  );
  fs.writeFileSync(
    path.join(root, 'scripts/check-encrypted-backup-restore-safety-browser.mjs'),
    '// focused proof\n',
  );
  fs.writeFileSync(path.join(root, '.replit'), replit);
  try {
    return spawnSync(process.execPath, [guard], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_RESTORE_SAFETY_ROOT: root },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('accepts an isolated inbox check and complete validation wiring', () => {
  const result = runFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('rejects backup imports and restore selectors in the inbox check', () => {
  const result = runFixture({
    inbox: [
      "import JSZip from 'jszip';",
      "await import('/src/lib/backup/export.ts');",
      "page.getByTestId('input-restore-file');",
    ].join('\n'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check-transaction-inbox-saved-view-snooze-browser\.mjs:1/);
  assert.match(result.stderr, /check-transaction-inbox-saved-view-snooze-browser\.mjs:2/);
  assert.match(result.stderr, /check-transaction-inbox-saved-view-snooze-browser\.mjs:3/);
});

test('rejects a focused restore check that is no longer validation', () => {
  const result = runFixture({
    replit: validReplit().replace(
      /(\[\[workflows\.workflow\]\]\nname = "encrypted-backup-restore-safety-browser-check"[\s\S]*?)isValidation = true/,
      '$1isValidation = false',
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /encrypted-backup-restore-safety-browser-check is no longer marked/);
});

test('rejects a guard omitted from the normal validation set', () => {
  const result = runFixture({
    replit: validReplit().replace(
      'args = "restore-safety-isolation-guard"',
      'args = "some-other-check"',
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing from the normal Project validation set/);
});

test('the real repository passes the guard', () => {
  const result = spawnSync(process.execPath, [guard], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});