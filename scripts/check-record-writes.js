#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const WRITE_METHODS = [
  'add', 'put', 'update', 'delete',
  'bulkAdd', 'bulkPut', 'bulkDelete',
  'modify', 'clear',
];

const PATTERN = new RegExp(
  `db\\.records\\.(${WRITE_METHODS.join('|')})\\b`
);

const ALLOWED_FILES = [
  path.resolve(ROOT, 'client/src/lib/data/record-crud.ts'),
];

const SCAN_DIR = path.resolve(ROOT, 'client/src');

const EXTENSIONS = new Set(['.ts', '.tsx']);

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const files = collectFiles(SCAN_DIR);
const violations = [];

for (const file of files) {
  const resolved = path.resolve(file);
  if (ALLOWED_FILES.includes(resolved)) continue;

  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) {
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: lines[i].trim(),
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} direct db.records write(s) outside the CRUD layer:\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}\n`);
  }
  console.error(
    'All record writes must go through client/src/lib/data/record-crud.ts.'
  );
  console.error(
    'Import the appropriate function from record-crud.ts (or via dataFacade.ts).\n'
  );
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    'No direct db.records writes found outside the CRUD layer.'
  );
}
