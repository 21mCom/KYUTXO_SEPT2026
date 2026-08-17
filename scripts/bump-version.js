// Bumps the patch segment of the version in package.json.
//
// Usage: node scripts/bump-version.js
//
// ── Release pipeline ──────────────────────────────────────────────────────────
// After running this script, the following checks MUST be run (in order) before
// the release is published.  The pof-version-browser-check is the critical gate
// that confirms the new version string actually lands in a real Vite-bundled PDF
// (a Vite caching quirk or a broken import path could silently stamp "undefined"
// in the PDF without this check):
//
//   1. node scripts/check-version-literal.js
//        → guards against any hardcoded KYUTXO_APP_VERSION literals;
//          every consumer must derive the value from package.json.
//
//   2. pof-version-browser-check  (node scripts/check-pof-version-browser.mjs)
//        → opens a real Chromium browser, generates both a real and a sample
//          Proof-of-Funds PDF, and asserts that the Tool line in each PDF reads
//          "KYUTXO v<new-version> (Proof of Funds Declaration)".  This is the
//          only check that exercises the live Vite-bundled PDF code path.
//
// Both checks are wired as named workflows in .replit and can be triggered from
// the Replit workflow panel.  They must both be green before the version bump
// commit is merged.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const parts = pkg.version.split('.').map(Number);
parts[2] += 1;
pkg.version = parts.join('.');

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(pkg.version);
console.log('');
console.log('Next steps before publishing:');
console.log('  1. node scripts/check-version-literal.js');
console.log('  2. node scripts/check-pof-version-browser.mjs  (pof-version-browser-check workflow)');
