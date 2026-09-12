#!/usr/bin/env node
// Guard: check scripts must not hardcode the LoginScreen/migration-overlay
// unlock testids — they must go through scripts/browser-check-utils.mjs.
//
// WHY: every scripts/check-*.mjs script that drives a real browser needs to
// get past the lock screen. Before this guard existed, ~80 scripts each
// carried their own inline copy of "fill input-password, click
// button-submit, wait for it to go away." If LoginScreen.tsx or
// LegacyMigrationOverlay.tsx ever rename one of these testids, every inline
// copy breaks silently — the affected check just times out at unlock with no
// obvious cause (see scripts/browser-check-utils.mjs for the shared
// unlockIfNeeded / dismissMigrationOverlayIfPresent / waitForLoginScreenVisible
// helpers). This guard fails fast so a new/edited check script can't
// reintroduce the duplication.
//
// Rule: no scripts/*.mjs or scripts/*.js file (other than
// browser-check-utils.mjs itself and the ALLOWLIST below) may contain a
// string literal for one of the UNLOCK_TESTIDS. Route through the shared
// helpers instead.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = __dirname;

// The authoritative source of these testids.
const SOURCE_FILES = [
  path.join(SCRIPTS_DIR, '..', 'client/src/components/LoginScreen.tsx'),
  path.join(SCRIPTS_DIR, '..', 'client/src/components/LegacyMigrationOverlay.tsx'),
];

const UTILS_FILE = path.join(SCRIPTS_DIR, 'browser-check-utils.mjs');

// input-password / input-confirm-password are unique to LoginScreen.tsx;
// legacy-migration-overlay / button-dismiss-migration are unique to
// LegacyMigrationOverlay.tsx. (button-submit is intentionally NOT included:
// it is also used by unrelated forms, e.g. client/src/pages/Evidence.tsx, so
// it can't be linted as an unlock-only signal.)
const UNLOCK_TESTIDS = [
  'input-password',
  'input-confirm-password',
  'legacy-migration-overlay',
  'button-dismiss-migration',
];

// Files that legitimately need direct testid access because they test the
// LoginScreen/migration-overlay's own behavior (wrong-password rejection,
// stuck-fill detection, etc.) rather than merely getting past it to test
// something else.
const ALLOWLIST = new Set([
  path.join(SCRIPTS_DIR, 'check-wrong-password-packaged.mjs'),
]);

// Self-check: fail loudly if a hardcoded reference no longer exists, so a
// rename/move doesn't silently disable this guard.
const missing = [...SOURCE_FILES, UTILS_FILE, ...ALLOWLIST].filter((f) => !fs.existsSync(f));
if (missing.length > 0) {
  console.error(
    'check-browser-check-unlock-guard self-check failed: expected file(s) missing:\n' +
      missing.map((f) => `  ${path.relative(process.cwd(), f)}`).join('\n') +
      '\n  -> If a file was renamed/moved, update scripts/check-browser-check-unlock-guard.js.',
  );
  process.exit(1);
}

const TESTID_PATTERN = new RegExp(`['"](${UNLOCK_TESTIDS.join('|')})['"]`);

const SELF_FILE = path.basename(__filename);

const files = fs
  .readdirSync(SCRIPTS_DIR)
  .filter(
    (f) => (f.endsWith('.mjs') || f.endsWith('.js')) && f !== path.basename(UTILS_FILE) && f !== SELF_FILE,
  )
  .filter((f) => f.startsWith('check-') || f.startsWith('browser-'))
  .sort();

if (files.length === 0) {
  console.error(
    'check-browser-check-unlock-guard: no scripts/check-*.mjs files found — glob or layout changed?',
  );
  process.exit(1);
}

const failures = [];

for (const file of files) {
  const full = path.join(SCRIPTS_DIR, file);
  if (ALLOWLIST.has(full)) continue;

  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(TESTID_PATTERN);
    if (m) {
      hits.push({ line: i + 1, testid: m[1], text: line.trim() });
    }
  });
  if (hits.length > 0) {
    failures.push({ file, hits });
  }
}

if (failures.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${failures.length} check script(s) hardcoding unlock testids instead of using scripts/browser-check-utils.mjs:\n`,
  );
  for (const { file, hits } of failures) {
    for (const hit of hits) {
      console.error(`  ${file}:${hit.line}  [${hit.testid}]`);
      console.error(`    ${hit.text}`);
    }
    console.error(
      "    -> Import { unlockIfNeeded, dismissMigrationOverlayIfPresent, waitForLoginScreenVisible } from './browser-check-utils.mjs' instead.\n",
    );
  }
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    'All check scripts clean: no hardcoded unlock testids found outside browser-check-utils.mjs.',
  );
  console.log(`  Scanned: ${files.length} file(s). Guarded testids: ${UNLOCK_TESTIDS.join(', ')}`);
}
