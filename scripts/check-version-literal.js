#!/usr/bin/env node

// Guards against hardcoded KYUTXO_APP_VERSION strings in source files outside
// package.json. Every consumer must import from package.json instead so that a
// release bump never needs to touch more than one file.
//
// Pattern detected:
//   KYUTXO_APP_VERSION = "x.y.z"   (the assignment form, not the usage)
//
// Allowed locations: none — the export in declaration-prefs.ts now derives the
// value from package.json, so no source file should ever assign a literal.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Directories / extensions to scan
const SCAN_DIRS = [
  path.resolve(ROOT, 'client/src'),
  path.resolve(ROOT, 'electron'),
  path.resolve(ROOT, 'server'),
];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// Regex: matches the literal-assignment form  KYUTXO_APP_VERSION = "..."
// This intentionally does NOT flag usages like  `v${KYUTXO_APP_VERSION}`.
const VERSION_LITERAL_RE = /KYUTXO_APP_VERSION\s*=\s*["']\d+\.\d+\.\d+/;
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.electron.ts'];
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

function walkDir(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, files);
    } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walkDir(dir)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (VERSION_LITERAL_RE.test(lines[i])) {
        violations.push(`  ${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
}

for (const configName of VITE_CONFIGS) {
  const configPath = path.join(ROOT, configName);
  const content = fs.readFileSync(configPath, 'utf8');
  if (
    !content.includes('__APP_VERSION__: JSON.stringify(pkgVersion)') ||
    !content.includes('require("./package.json")') ||
    !content.includes('html.replaceAll("__APP_VERSION__", pkgVersion)')
  ) {
    violations.push(
      `  ${configName}: must inject __APP_VERSION__ from package.json so every renderer build has the version constant`,
    );
  }
}

if (
  packageLock.version !== packageJson.version ||
  packageLock.packages?.['']?.version !== packageJson.version
) {
  violations.push('  package-lock.json: root versions must match package.json');
}

const requiredPatterns = [
  ['client/index.html', '<title>KYUTXO v__APP_VERSION__ - Bitcoin Metadata Manager</title>'],
  ['client/src/components/AppSidebar.tsx', 'v{__APP_VERSION__}'],
  ['electron/main.cjs', 'title: `KYUTXO v${appVersion} - Bitcoin Metadata Manager`'],
];
for (const [file, pattern] of requiredPatterns) {
  if (!fs.readFileSync(path.join(ROOT, file), 'utf8').includes(pattern)) {
    violations.push(`  ${file}: missing package-derived visible version surface`);
  }
}

const builder = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8'));
for (const target of ['win', 'mac', 'linux']) {
  if (!builder[target]?.artifactName?.includes('${version}')) {
    violations.push(`  electron-builder.json: ${target}.artifactName must include \${version}`);
  }
}

for (const workflowName of ['.github/workflows/build.yml', '.github/workflows/desktop-package-matrix.yml']) {
  const workflow = fs.readFileSync(path.join(ROOT, workflowName), 'utf8');
  if (
    !workflow.includes('name: Read package version') ||
    !workflow.includes('steps.version.outputs.version')
  ) {
    violations.push(`  ${workflowName}: uploaded package artifacts must derive their version from package.json`);
  }
}

if (violations.length > 0) {
  console.error('[check-version-literal] Version source-of-truth violation found.');
  console.error('  Derive version constants from package.json in every build target.');
  console.error('');
  console.error('Violations:');
  for (const v of violations) {
    console.error(v);
  }
  process.exit(1);
}

console.log('[check-version-literal] OK — no hardcoded KYUTXO_APP_VERSION literals found.');
