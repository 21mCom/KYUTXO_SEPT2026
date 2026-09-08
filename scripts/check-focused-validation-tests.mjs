#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep intentional exceptions visible here, with a durable reason. Do not use
// this list for tests that merely run elsewhere (for example in GitHub Actions):
// this guard specifically requires eligible focused tests to run in Replit's
// named validation cycle.
export const INTENTIONAL_EXCLUSIONS = Object.freeze({
  'check-packaged-vault-lock-native.test.mjs':
    'Release-only native power policy coverage runs in the desktop package matrix; its checked-in workflow assertion intentionally tracks release configuration outside the Replit validation cycle.',
});

const FOCUSED_TEST_PATTERN = /^check-.*\.test\.mjs$/;
const WORKFLOW_HEADER = '[[workflows.workflow]]';

export function focusedCheckTests(scriptsDirectory) {
  return fs
    .readdirSync(scriptsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && FOCUSED_TEST_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function validationCommands(replitSource) {
  return replitSource
    .split(WORKFLOW_HEADER)
    .slice(1)
    .filter((block) => /^\s*isValidation\s*=\s*true\s*$/m.test(block))
    .flatMap((block) =>
      [...block.matchAll(/^\s*args\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gm)].map((match) =>
        JSON.parse(`"${match[1]}"`),
      ),
    );
}

export function checkFocusedValidationTests({
  scriptsDirectory,
  replitSource,
  exclusions = INTENTIONAL_EXCLUSIONS,
}) {
  const files = focusedCheckTests(scriptsDirectory);
  const commands = validationCommands(replitSource);
  const errors = [];

  for (const [name, reason] of Object.entries(exclusions)) {
    if (!files.includes(name)) {
      errors.push(`intentional exclusion ${name} does not match a focused test file`);
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      errors.push(`intentional exclusion ${name} must document a non-empty reason`);
    }
  }

  for (const name of files) {
    if (Object.hasOwn(exclusions, name)) continue;
    const scriptPath = `scripts/${name}`;
    if (!commands.some((command) => command.includes(scriptPath))) {
      errors.push(
        `${scriptPath} is not referenced by any named workflow with isValidation = true`,
      );
    }
  }

  return { files, commands, errors };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const result = checkFocusedValidationTests({
    scriptsDirectory: path.join(root, 'scripts'),
    replitSource: fs.readFileSync(path.join(root, '.replit'), 'utf8'),
  });

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[focused-validation-tests] FAIL: ${error}`);
    process.exit(1);
  }

  console.log(
    `[focused-validation-tests] PASS: ${result.files.length - Object.keys(INTENTIONAL_EXCLUSIONS).length} focused check test(s) are wired into named validation; ${Object.keys(INTENTIONAL_EXCLUSIONS).length} documented exclusion(s)`,
  );
}