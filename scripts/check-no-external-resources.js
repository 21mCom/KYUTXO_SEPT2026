#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// KYUTXO is offline-first: the desktop app must never reach out to the public
// internet for fonts, scripts, styles, or any other resource. This guard scans
// the source HTML and the built web output for external resource references
// (e.g. the Google Fonts CDN links that once silently contacted Google on every
// launch) and fails if any non-allow-listed external host sneaks back in.

// Intentional runtime allowances. These are the blockchain-sync endpoints the
// Electron CSP `connect-src` explicitly permits (see electron/main.cjs). They
// are reached via fetch/XHR for transaction sync, never loaded as page
// resources, so referencing them is legitimate and must not trip this check.
const ALLOWED_HOSTS = new Set([
  'mempool.space',
  'blockstream.info',
]);

// Files / directories that are scanned. The source entry HTML plus the built
// web bundle (HTML + CSS), where any leaked CDN link would actually ship.
const SOURCE_FILES = [
  path.resolve(ROOT, 'client/index.html'),
];
const BUILD_DIR = path.resolve(ROOT, 'dist/public');
const BUILD_EXTENSIONS = new Set(['.html', '.css']);

// Known font CDN hosts called out explicitly so the failure message is clear,
// even though the generic external-host detection below would also catch them.
const KNOWN_CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// Match resource-loading references that point at an absolute http(s) URL:
//   <link ... href="https://...">
//   <script ... src="https://...">
//   url(https://...)            (CSS @font-face / @import / background, etc.)
//   @import "https://...";
const PATTERNS = [
  /<link\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'>\s)]+)/gi,
  /<script\b[^>]*\bsrc\s*=\s*["']?(https?:\/\/[^"'>\s)]+)/gi,
  /url\(\s*["']?(https?:\/\/[^"')]+)/gi,
  /@import\s+["'](https?:\/\/[^"']+)/gi,
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function collectBuildFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectBuildFiles(full, files);
    } else if (BUILD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

function scanFile(file) {
  const offenders = [];
  const contents = fs.readFileSync(file, 'utf8');
  const lines = contents.split('\n');

  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const url = match[1];
        const host = hostOf(url);
        if (host && !ALLOWED_HOSTS.has(host)) {
          offenders.push({
            lineNumber: index + 1,
            url,
            host,
            text: line.trim(),
          });
        }
      }
    }
  });

  return offenders;
}

function main() {
  const filesToScan = [];

  for (const file of SOURCE_FILES) {
    if (fs.existsSync(file)) {
      filesToScan.push(file);
    } else {
      console.warn(`[check-no-external-resources] WARN: source file not found, skipping: ${path.relative(ROOT, file)}`);
    }
  }

  const buildFiles = collectBuildFiles(BUILD_DIR);
  filesToScan.push(...buildFiles);

  if (buildFiles.length === 0) {
    console.warn(
      `[check-no-external-resources] WARN: no built output found at ${path.relative(ROOT, BUILD_DIR)} ` +
        `(run "npm run build" to also scan the production bundle).`
    );
  }

  const offenders = [];
  for (const file of filesToScan) {
    for (const offender of scanFile(file)) {
      offenders.push({ file: path.relative(ROOT, file), ...offender });
    }
  }

  if (offenders.length === 0) {
    console.log(
      '\x1b[32m%s\x1b[0m',
      `[check-no-external-resources] OK: no external resource references found ` +
        `(scanned ${filesToScan.length} file(s)).`
    );
    console.log(`  Allow-listed hosts: ${[...ALLOWED_HOSTS].join(', ')}`);
    process.exit(0);
  }

  console.error(
    '\x1b[31m%s\x1b[0m',
    `[check-no-external-resources] FAIL: found ${offenders.length} external resource reference(s).\n` +
      `KYUTXO is offline-first: external CDN/script/style/font links break the offline and privacy guarantees.\n`
  );

  for (const o of offenders) {
    const cdnNote = KNOWN_CDN_HOSTS.includes(o.host) ? '  (known font CDN)' : '';
    console.error(`  ${o.file}:${o.lineNumber}  [${o.host}]${cdnNote}`);
    console.error(`    ${o.text}`);
    console.error(`    -> ${o.url}\n`);
  }

  console.error(
    `To fix: remove the external reference and bundle the resource locally instead ` +
      `(e.g. self-host fonts via @fontsource-variable). If a host is an intentional, ` +
      `CSP-allowed runtime endpoint, add it to ALLOWED_HOSTS in scripts/check-no-external-resources.js.`
  );
  process.exit(1);
}

main();
