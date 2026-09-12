#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[release-fixtures]';
const DEFAULT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCUMENT_GLOBS = ['*.pdf', '*.doc', '*.docx', '*.odt'];
const GIT_TIMEOUT_MS = 30_000;
const FAST_TEST_COMMAND_TIMEOUT_MS = 15 * 60_000;
const FULL_TEST_COMMAND_TIMEOUT_MS = 60 * 60_000;

function testCommandTimeout(command) {
  return command.some((argument) => argument.includes('test:full'))
    ? FULL_TEST_COMMAND_TIMEOUT_MS
    : FAST_TEST_COMMAND_TIMEOUT_MS;
}

function trackedDocuments(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...DOCUMENT_GLOBS], {
    cwd: root,
    encoding: 'buffer',
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.toString('utf8').trim();
    throw new Error(`could not list tracked sample documents${detail ? `: ${detail}` : ''}`);
  }
  const files = [];
  let start = 0;
  for (let index = 0; index < result.stdout.length; index += 1) {
    if (result.stdout[index] !== 0) continue;
    if (index > start) files.push(result.stdout.subarray(start, index));
    start = index + 1;
  }
  return files.sort(Buffer.compare);
}

function digest(filePath) {
  if (!fs.existsSync(filePath)) return '<missing>';
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshot(root, files) {
  return new Map(files.map((file) => [file, digest(absoluteFilename(root, file))]));
}

function displayFilename(file) {
  const decoded = file.toString('utf8');
  if (Buffer.from(decoded, 'utf8').equals(file)) {
    return /[\u0000-\u001f\u007f-\u009f]/u.test(decoded) ? JSON.stringify(decoded) : decoded;
  }

  let displayed = '"';
  for (const byte of file) {
    if (byte === 0x22) displayed += '\\"';
    else if (byte === 0x5c) displayed += '\\\\';
    else if (byte === 0x0a) displayed += '\\n';
    else if (byte === 0x0d) displayed += '\\r';
    else if (byte === 0x09) displayed += '\\t';
    else if (byte >= 0x20 && byte <= 0x7e) displayed += String.fromCharCode(byte);
    else displayed += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return `${displayed}"`;
}

function absoluteFilename(root, file) {
  return Buffer.concat([Buffer.from(`${root}${path.sep}`), file]);
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

  const timeout = testCommandTimeout(command);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: timeout,
  });

  const modified = files
    .map((file) => {
      const after = digest(absoluteFilename(root, file));
      if (before.get(file) === after) return null;
      return {
        file,
        status: after === '<missing>' ? 'deleted' : 'rewritten',
      };
    })
    .filter(Boolean);
  if (modified.length > 0) {
    console.error(
      `${TAG} FAIL: test command modified ${modified.length} checked-in sample document(s):`,
    );
    for (const { file, status } of modified) {
      console.error(`  ${status}: ${displayFilename(file)}`);
    }
    console.error(`${TAG} Files were left untouched so the changes can be inspected.`);
  }

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
      console.error(`${TAG} FAIL: timed out running test command after ${timeout}ms`);
    } else {
      console.error(`${TAG} FAIL: could not run test command: ${result.error.message}`);
    }
  }

  if (modified.length > 0 || result.error) process.exit(1);
  process.exit(result.status ?? 1);
}

main();