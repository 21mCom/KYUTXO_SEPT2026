#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[release-fixtures]';
const DEFAULT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCUMENT_GLOBS = ['*.pdf', '*.doc', '*.docx', '*.odt'];

function trackedDocuments(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...DOCUMENT_GLOBS], {
    cwd: root,
    encoding: 'buffer',
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.toString('utf8').trim();
    throw new Error(`could not list tracked sample documents${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
}

function digest(filePath) {
  if (!fs.existsSync(filePath)) return '<missing>';
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshot(root, files) {
  return new Map(files.map((file) => [file, digest(path.join(root, file))]));
}

function main() {
  const separator = process.argv.indexOf('--');
  const command = separator === -1 ? [] : process.argv.slice(separator + 1);
  if (command.length === 0) {
    console.error(`${TAG} FAIL: expected a command after "--"`);
    process.exit(2);
  }

  const root = process.env.CHECK_RELEASE_FIXTURES_ROOT
    ? path.resolve(process.env.CHECK_RELEASE_FIXTURES_ROOT)
    : DEFAULT_ROOT;

  let files;
  try {
    files = trackedDocuments(root);
  } catch (error) {
    console.error(`${TAG} FAIL: ${error.message}`);
    process.exit(1);
  }

  const before = snapshot(root, files);
  console.log(`${TAG} protecting ${files.length} tracked sample document(s)`);

  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const modified = files.filter((file) => before.get(file) !== digest(path.join(root, file)));
  if (modified.length > 0) {
    console.error(
      `${TAG} FAIL: test command modified ${modified.length} checked-in sample document(s):`,
    );
    for (const file of modified) console.error(`  ${file}`);
    console.error(`${TAG} Files were left untouched so the changes can be inspected.`);
  }

  if (result.error) {
    console.error(`${TAG} FAIL: could not run test command: ${result.error.message}`);
  }

  if (modified.length > 0 || result.error) process.exit(1);
  process.exit(result.status ?? 1);
}

main();