#!/usr/bin/env node

// Wires the checked-in .githooks directory as git's hooks path so the
// pre-push hook (which runs scripts/check-lockfile-urls.js) is active for
// every clone after an install. Safe to run anywhere: silently no-ops when
// git or a .git directory is unavailable (e.g. npm ci in a tarball build).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.log('[setup-git-hooks] no .git directory; skipping hooks setup');
    process.exit(0);
  }
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT });
  // Ensure the hook is executable (fresh checkouts on some systems drop the bit).
  fs.chmodSync(path.join(ROOT, '.githooks', 'pre-push'), 0o755);
  console.log('[setup-git-hooks] core.hooksPath set to .githooks (pre-push lockfile check active)');
} catch (error) {
  // Never fail an install over hook wiring.
  console.log(`[setup-git-hooks] skipped: ${error.message}`);
}
