#!/usr/bin/env node
// Guard: check scripts must not hardcode LoginScreen, migration-overlay, or
// generic fresh-vault onboarding testids — they must go through
// scripts/browser-check-utils.mjs.
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
// browser-check-utils.mjs itself and the explicit allowlists below) may
// contain a string literal for one of the guarded testids. Route generic
// checks through the shared helpers instead.

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
  path.join(SCRIPTS_DIR, '..', 'client/src/components/NetworkPrivacyOnboarding.tsx'),
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

const ONBOARDING_TESTIDS = [
  'network-onboarding-source',
  'choice-network-public-direct',
  'button-save-network-choice',
  'network-onboarding-import',
  'button-onboarding-finish',
];

// Files that legitimately need direct testid access because they test the
// LoginScreen/migration-overlay's own behavior (wrong-password rejection,
// stuck-fill detection, etc.) rather than merely getting past it to test
// something else.
const UNLOCK_ALLOWLIST = new Set([
  path.join(SCRIPTS_DIR, 'check-packaged-vault-lock-native.mjs'),
  path.join(SCRIPTS_DIR, 'check-wrong-password-packaged.mjs'),
]);

// This check owns the first-run onboarding journey itself, including proving
// that an existing vault never sees the wizard, so direct selector access is
// intentional. Generic fresh-vault checks must use the shared helper.
const ONBOARDING_ALLOWLIST = new Set([
  path.join(SCRIPTS_DIR, 'check-first-run-network-privacy-browser.mjs'),
]);

// Self-check: fail loudly if a hardcoded reference no longer exists, so a
// rename/move doesn't silently disable this guard.
const missing = [
  ...SOURCE_FILES,
  UTILS_FILE,
  ...UNLOCK_ALLOWLIST,
  ...ONBOARDING_ALLOWLIST,
].filter((f) => !fs.existsSync(f));
if (missing.length > 0) {
  console.error(
    'check-browser-check-unlock-guard self-check failed: expected file(s) missing:\n' +
      missing.map((f) => `  ${path.relative(process.cwd(), f)}`).join('\n') +
      '\n  -> If a file was renamed/moved, update scripts/check-browser-check-unlock-guard.js.',
  );
  process.exit(1);
}

const GUARDED_TESTIDS = [...UNLOCK_TESTIDS, ...ONBOARDING_TESTIDS];
const TESTID_PATTERN = new RegExp(`['"](${GUARDED_TESTIDS.join('|')})['"]`);

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

  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(TESTID_PATTERN);
    const allowed =
      (UNLOCK_TESTIDS.includes(m?.[1]) && UNLOCK_ALLOWLIST.has(full)) ||
      (ONBOARDING_TESTIDS.includes(m?.[1]) && ONBOARDING_ALLOWLIST.has(full));
    if (m && !allowed) {
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
    `Found ${failures.length} check script(s) hardcoding unlock/onboarding testids instead of using scripts/browser-check-utils.mjs:\n`,
  );
  for (const { file, hits } of failures) {
    for (const hit of hits) {
      console.error(`  ${file}:${hit.line}  [${hit.testid}]`);
      console.error(`    ${hit.text}`);
    }
    console.error(
      "    -> Import the relevant unlock or completeFreshVaultOnboardingIfPresent helper from './browser-check-utils.mjs' instead.\n",
    );
  }
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    'All check scripts clean: no hardcoded unlock/onboarding testids found outside explicit allowlists.',
  );
  console.log(`  Scanned: ${files.length} file(s). Guarded testids: ${GUARDED_TESTIDS.join(', ')}`);
}
