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

function runFixture({
  inbox = '// inbox-only journey\n',
  helpers = {},
  replit = validReplit(),
} = {}) {
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
  for (const [relative, source] of Object.entries(helpers)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
  }
  fs.writeFileSync(path.join(root, '.replit'), replit);
  try {
    return spawnSync(process.execPath, [guard], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_RESTORE_SAFETY_ROOT: root },
      timeout: 5_000,
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

test('accepts a clean local helper imported by the inbox check', () => {
  const result = runFixture({
    inbox: "import { openInbox } from './inbox-helpers.mjs';\nawait openInbox();\n",
    helpers: {
      'scripts/inbox-helpers.mjs': 'export function openInbox() {}\n',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('rejects restore coupling reached through transitive local helpers', () => {
  const result = runFixture({
    inbox: "import { openInbox } from './inbox-helpers.mjs';\nawait openInbox();\n",
    helpers: {
      'scripts/inbox-helpers.mjs': "export { openInbox } from './journeys/open-inbox.js';\n",
      'scripts/journeys/open-inbox.js': [
        'export async function openInbox() {',
        "  await import('../../client/src/lib/backup/export.ts');",
        '}',
      ].join('\n'),
      'client/src/lib/backup/export.ts':
        "export const openRestore = (page) => page.getByTestId('input-restore-file');\n",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/journeys\/open-inbox\.js:2/);
  assert.match(result.stderr, /client\/src\/lib\/backup\/export\.ts:1/);
});

test('rejects restore coupling reached through an extensionless local import', () => {
  const result = runFixture({
    inbox: "import { openInbox } from './inbox-helpers';\nawait openInbox();\n",
    helpers: {
      'scripts/inbox-helpers.ts': [
        'export function openInbox(page) {',
        "  return page.getByTestId('button-open-restore');",
        '}',
      ].join('\n'),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/inbox-helpers\.ts:2/);
});

test('rejects restore coupling reached through a directory index import', () => {
  const result = runFixture({
    inbox: "import { openInbox } from './inbox-helpers';\nawait openInbox();\n",
    helpers: {
      'scripts/inbox-helpers/index.tsx': [
        'export function openInbox() {',
        "  return 'backup journey';",
        '}',
      ].join('\n'),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/inbox-helpers\/index\.tsx:2/);
});

test('cyclic local helper imports terminate and still reject restore coupling', () => {
  const result = runFixture({
    inbox: "import { openInbox } from './helpers/first';\nawait openInbox();\n",
    helpers: {
      'scripts/helpers/first.js': [
        "import { second } from './second';",
        'export function openInbox() { return second(); }',
      ].join('\n'),
      'scripts/helpers/second.js': [
        "import { openInbox } from './first';",
        "export function second() { return 'restore flow'; }",
      ].join('\n'),
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/helpers\/second\.js:2/);
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