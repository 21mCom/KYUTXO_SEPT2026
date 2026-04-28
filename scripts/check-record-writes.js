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

const GUARDED_TABLES = [
  {
    table: 'records',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/record-crud.ts'),
    label: 'record-crud.ts',
  },
  {
    table: 'blockchainTransactions',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/transaction-crud.ts'),
    label: 'transaction-crud.ts',
  },
  {
    table: 'transactionParticipants',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/transaction-crud.ts'),
    label: 'transaction-crud.ts',
  },
  {
    table: 'utxoLineage',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/lineage-crud.ts'),
    label: 'lineage-crud.ts',
  },
  {
    table: 'custodySegments',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/lineage-crud.ts'),
    label: 'lineage-crud.ts',
  },
];

const TABLE_NAMES = GUARDED_TABLES.map(g => g.table);
const PATTERN = new RegExp(
  `db\\.(${TABLE_NAMES.join('|')})\\.(${WRITE_METHODS.join('|')})\\b`
);

const ALLOWED_FILES_SET = new Set(GUARDED_TABLES.map(g => g.crudFile));

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
  if (ALLOWED_FILES_SET.has(resolved)) continue;

  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(PATTERN);
    if (match) {
      const tableName = match[1];
      const guard = GUARDED_TABLES.find(g => g.table === tableName);
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: lines[i].trim(),
        table: tableName,
        crudLabel: guard ? guard.label : 'unknown',
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} direct write(s) to guarded tables outside their CRUD layers:\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [db.${v.table}]`);
    console.error(`    ${v.text}`);
    console.error(`    -> Route through ${v.crudLabel} (or via dataFacade.ts)\n`);
  }
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    `All guarded tables clean: no direct writes found outside CRUD layers.`
  );
  console.log(`  Guarded: ${TABLE_NAMES.join(', ')}`);
}
