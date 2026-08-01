#!/usr/bin/env node

// Guards package-lock.json against download URLs that break "npm ci" outside
// Replit:
//  1. package-firewall.replit.local URLs — Replit's npm proxy; unreachable
//     from external CI (e.g. the GitHub Windows build).
//  2. Malformed registry.npmjs.org tarball URLs missing the "/-/" segment
//     (e.g. https://registry.npmjs.org/node-fetch-3.3.2.tgz). These come from
//     naive firewall-URL rewrites, 404 on the real registry, and would
//     otherwise slip past a firewall-string-only check.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const LOCKFILE = path.resolve(ROOT, 'package-lock.json');
const FORBIDDEN = 'package-firewall.replit.local';
const REGISTRY = 'https://registry.npmjs.org/';

function main() {
  if (!fs.existsSync(LOCKFILE)) {
    console.error(`[check-lockfile-urls] package-lock.json not found at ${LOCKFILE}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(LOCKFILE, 'utf8');

  // Class 1: internal Replit firewall links (line scan keeps line numbers).
  const firewallOffenders = [];
  contents.split('\n').forEach((line, index) => {
    if (line.includes(FORBIDDEN)) {
      firewallOffenders.push({ lineNumber: index + 1, text: line.trim() });
    }
  });

  // Class 2: malformed npm registry tarball URLs (structured scan so the
  // offending package is named). A valid registry tarball URL always contains
  // the "/-/" path segment: https://registry.npmjs.org/<name>/-/<base>-<version>.tgz
  const malformedOffenders = [];
  let lock;
  try {
    lock = JSON.parse(contents);
  } catch (error) {
    console.error(`[check-lockfile-urls] FAIL: package-lock.json is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const resolved = entry && entry.resolved;
    if (typeof resolved !== 'string') continue;
    if (resolved.startsWith(REGISTRY) && !resolved.includes('/-/')) {
      malformedOffenders.push({ key: key || '(root)', resolved });
    }
  }

  if (firewallOffenders.length === 0 && malformedOffenders.length === 0) {
    console.log('[check-lockfile-urls] OK: no internal Replit or malformed registry download links found in package-lock.json');
    process.exit(0);
  }

  if (firewallOffenders.length > 0) {
    console.error(
      `[check-lockfile-urls] FAIL: found ${firewallOffenders.length} internal Replit download link(s) in package-lock.json.\n` +
        `These "${FORBIDDEN}" URLs only resolve inside Replit and will break external CI (e.g. "npm ci" on GitHub).\n`
    );
    for (const offender of firewallOffenders.slice(0, 20)) {
      console.error(`  line ${offender.lineNumber}: ${offender.text}`);
    }
    if (firewallOffenders.length > 20) {
      console.error(`  ...and ${firewallOffenders.length - 20} more`);
    }
  }

  if (malformedOffenders.length > 0) {
    console.error(
      `[check-lockfile-urls] FAIL: found ${malformedOffenders.length} malformed npm registry URL(s) in package-lock.json ` +
        `(missing the "/-/" tarball segment — these 404 on the real registry):\n`
    );
    for (const offender of malformedOffenders.slice(0, 20)) {
      console.error(`  ${offender.key}: ${offender.resolved}`);
    }
    if (malformedOffenders.length > 20) {
      console.error(`  ...and ${malformedOffenders.length - 20} more`);
    }
  }

  console.error(
    '\nTo fix: every "resolved" URL must use the canonical registry form\n' +
      '  https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz\n' +
      '(for scoped packages, <name> keeps the @scope/ prefix and <basename> drops it).\n' +
      'Derive <name> from the lockfile key after the last "node_modules/" and <version>\n' +
      'from the entry — do NOT string-replace the host portion only. Then run\n' +
      '"npm install" to prove the URLs fetch, re-run this check, and commit the lockfile.'
  );
  process.exit(1);
}

main();
