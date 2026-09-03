#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptsDir = path.join(ROOT, 'scripts');
const testFiles = fs
  .readdirSync(scriptsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('scripts', name));

if (testFiles.length === 0) {
  console.error('[node-tests] FAIL: no scripts/*.test.mjs files found');
  process.exit(1);
}

console.log(`[node-tests] running ${testFiles.length} script test files`);
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: ROOT,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[node-tests] FAIL: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);