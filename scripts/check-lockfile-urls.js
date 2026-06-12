#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const LOCKFILE = path.resolve(ROOT, 'package-lock.json');
const FORBIDDEN = 'package-firewall.replit.local';

function main() {
  if (!fs.existsSync(LOCKFILE)) {
    console.error(`[check-lockfile-urls] package-lock.json not found at ${LOCKFILE}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(LOCKFILE, 'utf8');
  const lines = contents.split('\n');
  const offenders = [];

  lines.forEach((line, index) => {
    if (line.includes(FORBIDDEN)) {
      offenders.push({ lineNumber: index + 1, text: line.trim() });
    }
  });

  if (offenders.length === 0) {
    console.log('[check-lockfile-urls] OK: no internal Replit download links found in package-lock.json');
    process.exit(0);
  }

  console.error(
    `[check-lockfile-urls] FAIL: found ${offenders.length} internal Replit download link(s) in package-lock.json.\n` +
      `These "${FORBIDDEN}" URLs only resolve inside Replit and will break external CI (e.g. "npm ci" on GitHub).\n`
  );

  const preview = offenders.slice(0, 20);
  for (const offender of preview) {
    console.error(`  line ${offender.lineNumber}: ${offender.text}`);
  }
  if (offenders.length > preview.length) {
    console.error(`  ...and ${offenders.length - preview.length} more`);
  }

  console.error(
    `\nTo fix: rewrite every "${FORBIDDEN}" reference to "https://registry.npmjs.org/".\n` +
      `For example:\n` +
      `  sed -i 's#https://[^"]*${FORBIDDEN}[^"]*/#https://registry.npmjs.org/#g' package-lock.json\n` +
      `then re-run this check and commit the corrected lockfile.`
  );
  process.exit(1);
}

main();
