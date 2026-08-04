#!/usr/bin/env node
// Guard: every engine browser check must SHARE the engine bridge, not re-copy it.
//
// WHY: the two original engine-served browser checks each pasted their own
// `window.electronAPI.engine` addInitScript bridge, and the copies drifted.
// Task #1866 consolidated them onto scripts/engine-bridge-mock.mjs
// (buildEngineBridgeInitScript). Nothing else stops a FUTURE engine check
// (e.g. a UTXOs engine check) from pasting its own inline bridge again and
// reintroducing that drift risk — this guard fails fast when one does.
//
// Rules:
//   1. every file matching scripts/check-*engine-browser*.mjs must import
//      buildEngineBridgeInitScript from ./engine-bridge-mock.mjs
//   2. NO scripts/check-*.mjs file (engine-named or not) may define an inline
//      engine bridge, i.e. assign `window.electronAPI = { ... engine`
//      (or `window.electronAPI.engine = ...`) itself.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
// Test hook: node --test suite (check-engine-bridge-shared.test.mjs) points
// this at fixture directories so a broken regex can't silently pass everything.
const SCRIPTS_DIR =
  process.env.CHECK_ENGINE_BRIDGE_SCRIPTS_DIR || path.dirname(__filename);

const allCheckScripts = fs
  .readdirSync(SCRIPTS_DIR)
  // node:test companions (check-*.test.mjs) are test suites, not check
  // scripts — their fixture strings intentionally contain inline bridges.
  .filter((f) => /^check-.*\.mjs$/.test(f) && !/\.test\.mjs$/.test(f))
  .sort();

const engineChecks = allCheckScripts.filter((f) =>
  /^check-.*engine-browser.*\.mjs$/.test(f),
);

if (engineChecks.length === 0) {
  console.error(
    'check-engine-bridge-shared: no scripts/check-*engine-browser*.mjs files found — glob or layout changed?',
  );
  process.exit(1);
}

const IMPORT_RE =
  /import\s*\{[^}]*\bbuildEngineBridgeInitScript\b[^}]*\}\s*from\s*['"]\.\/engine-bridge-mock\.mjs['"]/;
// Inline bridge definitions: `window.electronAPI = { ... engine` (possibly
// across lines) or direct `window.electronAPI.engine =` assignment.
const INLINE_OBJECT_RE = /window\.electronAPI\s*=\s*\{[\s\S]{0,400}?\bengine\b/;
const INLINE_ASSIGN_RE = /window\.electronAPI\.engine\s*=/;

const failures = [];

for (const file of engineChecks) {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
  if (!IMPORT_RE.test(src)) {
    failures.push({
      file,
      problem:
        "missing import: import { buildEngineBridgeInitScript } from './engine-bridge-mock.mjs'; — engine browser checks must share the bridge builder",
    });
  }
}

for (const file of allCheckScripts) {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
  if (INLINE_OBJECT_RE.test(src) || INLINE_ASSIGN_RE.test(src)) {
    failures.push({
      file,
      problem:
        'inline engine bridge definition (window.electronAPI ... engine) — use buildEngineBridgeInitScript from ./engine-bridge-mock.mjs instead',
    });
  }
}

if (failures.length > 0) {
  console.error(
    'check-engine-bridge-shared: engine bridge sharing violation(s).\n' +
      'Engine browser checks must build their window.electronAPI.engine bridge via the\n' +
      'shared builder so bridge semantics cannot drift between checks:\n' +
      "  import { buildEngineBridgeInitScript } from './engine-bridge-mock.mjs';\n",
  );
  for (const { file, problem } of failures) {
    console.error(`  scripts/${file}: ${problem}`);
  }
  process.exit(1);
}

console.log(
  `check-engine-bridge-shared: OK — ${engineChecks.length} engine browser check(s) share the bridge builder; no inline bridges in ${allCheckScripts.length} check script(s).`,
);
