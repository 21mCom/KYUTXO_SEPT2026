#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sourceRoot = path.resolve(process.env.PACKAGED_STORAGE_SCAN_ROOT || path.join(ROOT, 'client/src'));

// These files are the explicit browser/legacy adapters. They may construct or
// call Dexie; application modules may only use the repository boundary.
const dexieAdapters = new Set([
  path.resolve(sourceRoot, 'lib/database.ts'),
  path.resolve(sourceRoot, 'lib/vault.ts'),
  path.resolve(sourceRoot, 'lib/repository/dexie.ts'),
  // Non-vault, disposable browser report caches. None is authoritative vault
  // storage and each can be rebuilt from repository data.
  path.resolve(sourceRoot, 'lib/data/dormant-coins-report-store.ts'),
  path.resolve(sourceRoot, 'lib/data/privacy-audit-session-store.ts'),
  path.resolve(sourceRoot, 'lib/data/stale-balance-report-store.ts'),
  // Explicit development fixture database; production code never selects it.
  path.resolve(sourceRoot, 'lib/legacy-vault-fixture.ts'),
]);

function isProductionSource(file) {
  return /\.(?:ts|tsx)$/.test(file) &&
    !/\.test\.(?:ts|tsx)$/.test(file) &&
    !file.replaceAll('\\', '/').includes('/__tests__/');
}

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, output);
    else if (isProductionSource(file)) output.push(file);
  }
  return output;
}

if (!fs.existsSync(sourceRoot)) {
  console.error(`Packaged storage scan root is missing: ${sourceRoot}`);
  process.exit(1);
}

const violations = [];
for (const file of walk(sourceRoot)) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // A renderer callback cannot provide native atomicity. Cross-table work
    // must use one of the finite protected commands instead.
    if (/\b(?:repository|getVaultRepository\(\))\.transaction\s*\(/.test(line)) {
      violations.push({ file, line: index + 1, reason: 'repository.transaction() is forbidden' });
    }
    // Prevent new production modules from opening another live IndexedDB.
    if (!dexieAdapters.has(path.resolve(file)) &&
        (/\bnew\s+Dexie\s*\(/.test(line) || /\bextends\s+Dexie\b/.test(line))) {
      violations.push({ file, line: index + 1, reason: 'Dexie construction is browser-adapter-only' });
    }
    // The concrete fallback must not leak into packaged-reachable consumers.
    if (!file.endsWith(path.join('lib', 'repository', 'index.ts')) &&
        /from\s+['"][^'"]*repository\/dexie['"]/.test(line)) {
      violations.push({ file, line: index + 1, reason: 'Dexie adapter import is boundary-only' });
    }
  }
}

if (violations.length) {
  console.error('Packaged storage boundary violations:');
  for (const violation of violations) {
    console.error(`  ${path.relative(ROOT, violation.file)}:${violation.line} ${violation.reason}`);
  }
  process.exit(1);
}

console.log('Packaged storage boundary clean.');