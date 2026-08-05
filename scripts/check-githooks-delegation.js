#!/usr/bin/env node
// Guard: the checked-in .githooks directory must keep commit checks alive.
//
// WHY: core.hooksPath points at .githooks, which REPLACES .git/hooks for git.
// The .githooks/pre-commit shim exists solely to delegate back to the
// installer-managed .git/hooks/pre-commit (written by scripts/install-hooks.sh).
// If that shim is deleted, renamed, loses its exec bit, or stops exec'ing the
// legacy hook path, every pre-commit check silently stops running — git shows
// no error at all. Same for .githooks/pre-push and its lockfile-URL gate.
// This guard fails fast when any of that drifts.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
// Test override: point the guard at a fixture hooks dir (see
// scripts/check-githooks-delegation.test.mjs). Defaults to the repo's .githooks.
const HOOKS_DIR = process.env.CHECK_GITHOOKS_DIR
  ? path.resolve(process.env.CHECK_GITHOOKS_DIR)
  : path.join(ROOT, '.githooks');

const failures = [];

function checkHook(name) {
  const file = path.join(HOOKS_DIR, name);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    failures.push(
      `.githooks/${name} is missing — with core.hooksPath=.githooks this silently disables all ${name} checks.`,
    );
    return null;
  }
  if (!stat.isFile()) {
    failures.push(`.githooks/${name} exists but is not a regular file.`);
    return null;
  }
  // Any exec bit (owner/group/other) — git requires the hook to be executable.
  if ((stat.mode & 0o111) === 0) {
    failures.push(
      `.githooks/${name} is not executable — git skips non-executable hooks WITHOUT any error. Fix with: chmod +x .githooks/${name}`,
    );
  }
  const content = fs.readFileSync(file, 'utf8');
  if (!content.startsWith('#!')) {
    failures.push(`.githooks/${name} is missing a shebang (#!) line.`);
  }
  return content;
}

const preCommit = checkHook('pre-commit');
const prePush = checkHook('pre-push');

if (preCommit !== null) {
  // The shim must resolve the legacy installer-managed hook via git and exec it.
  const resolvesLegacyPath =
    /git\s+rev-parse\s+--git-dir[\s\S]*hooks\/pre-commit/.test(preCommit) ||
    /\.git\/hooks\/pre-commit/.test(preCommit);
  const execsLegacyHook = /\bexec\s+"?\$?\{?legacy_hook\}?"?/.test(preCommit)
    ? true
    : /\bexec\b[^\n]*hooks\/pre-commit/.test(preCommit);
  if (!resolvesLegacyPath) {
    failures.push(
      '.githooks/pre-commit no longer references the legacy .git/hooks/pre-commit path (expected `$(git rev-parse --git-dir)/hooks/pre-commit`). The installer-managed pre-commit checks would silently stop running.',
    );
  }
  if (!execsLegacyHook) {
    failures.push(
      '.githooks/pre-commit no longer `exec`s the legacy hook — it must delegate with `exec "$legacy_hook" "$@"` so installer-managed pre-commit checks keep running.',
    );
  }
  if (!/"\$@"/.test(preCommit)) {
    failures.push(
      '.githooks/pre-commit must forward hook arguments with "$@" when exec-ing the legacy hook.',
    );
  }
}

if (prePush !== null) {
  if (!/check-lockfile-urls\.js/.test(prePush)) {
    failures.push(
      '.githooks/pre-push no longer runs scripts/check-lockfile-urls.js — the firewall-URL push gate would silently disappear.',
    );
  }
}

if (failures.length > 0) {
  console.error('check-githooks-delegation: FAILED\n');
  for (const f of failures) console.error(` - ${f}`);
  console.error(
    '\nSee scripts/install-hooks.sh and .githooks/* — core.hooksPath makes these shims the ONLY hooks git runs.',
  );
  process.exit(1);
}

console.log(
  'check-githooks-delegation: OK — .githooks/pre-commit and pre-push exist, are executable, and delegate correctly.',
);
