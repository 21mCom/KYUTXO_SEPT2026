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

const READ_METHODS = [
  'toArray', 'get', 'bulkGet', 'count', 'where', 'orderBy',
  'each', 'filter', 'first', 'last', 'primaryKeys', 'anyOf',
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
  {
    table: 'evidence',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/evidence-crud.ts'),
    label: 'evidence-crud.ts',
  },
  {
    table: 'evidenceAttachments',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/evidence-crud.ts'),
    label: 'evidence-crud.ts',
  },
  {
    table: 'lineageSnapshots',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/lineage-crud.ts'),
    label: 'lineage-crud.ts',
  },
  {
    table: 'attachments',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/attachments-crud.ts'),
    label: 'attachments-crud.ts',
  },
  {
    table: 'priceData',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/price-data-crud.ts'),
    label: 'price-data-crud.ts',
  },
  {
    table: 'settings',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/settings-crud.ts'),
    label: 'settings-crud.ts',
  },
  {
    table: 'nodeSettings',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/node-settings-crud.ts'),
    label: 'node-settings-crud.ts',
  },
  {
    table: 'customFields',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/custom-fields-crud.ts'),
    label: 'custom-fields-crud.ts',
  },
  {
    table: 'recordOrigins',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/record-origins-crud.ts'),
    label: 'record-origins-crud.ts',
  },
  {
    table: 'derivationTemplates',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/derivation-templates-crud.ts'),
    label: 'derivation-templates-crud.ts',
  },
  {
    table: 'addressSyncState',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/address-sync-crud.ts'),
    label: 'address-sync-crud.ts',
  },
  {
    table: 'pausedSyncState',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/paused-sync-crud.ts'),
    label: 'paused-sync-crud.ts',
  },
  {
    table: 'skippedAddresses',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/sync-protection-crud.ts'),
    label: 'sync-protection-crud.ts',
  },
  {
    table: 'addressBlacklist',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/sync-protection-crud.ts'),
    label: 'sync-protection-crud.ts',
  },
  {
    table: 'partialExportBundles',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/partial-export-crud.ts'),
    label: 'partial-export-crud.ts',
  },
  {
    table: 'savedPsbts',
    crudFile: path.resolve(ROOT, 'client/src/lib/data/saved-psbts-crud.ts'),
    label: 'saved-psbts-crud.ts',
  },
];

// Files that legitimately need direct table access — e.g. database initialization,
// generic legacy migration utilities that iterate every table by reflection,
// internal data-engine modules that compose primitive Dexie queries to build
// higher-level helpers, and equivalence/regression tests that exercise the
// underlying Dexie surface directly.
const ALWAYS_ALLOWED_FILES = new Set([
  path.resolve(ROOT, 'client/src/lib/database.ts'),
  path.resolve(ROOT, 'client/src/lib/legacy-decrypt.ts'),
  path.resolve(ROOT, 'client/src/lib/legacy-decrypt-files.ts'),
  path.resolve(ROOT, 'client/src/lib/transaction-sync.ts'),
  path.resolve(ROOT, 'client/src/lib/lineageEngine.ts'),
  path.resolve(ROOT, 'client/src/lib/provenance.ts'),
  path.resolve(ROOT, 'client/src/lib/data/fund-trail-engine.ts'),
  path.resolve(ROOT, 'client/src/lib/attachments.ts'),
  path.resolve(ROOT, 'client/src/lib/lightning-detection.ts'),
  path.resolve(ROOT, 'client/src/lib/wallet-import/merge-utils.ts'),
  path.resolve(ROOT, 'client/src/lib/testSeedData.ts'),
  path.resolve(ROOT, 'client/src/lib/records-query.ts'),
  path.resolve(ROOT, 'client/src/lib/records-query.equivalence.test.ts'),
  path.resolve(ROOT, 'client/src/lib/privacy-audit.e2e-proximity.test.ts'),
  path.resolve(ROOT, 'client/src/lib/privacy-audit.e2e-entity-contacts.test.ts'),
  path.resolve(ROOT, 'client/src/lib/privacy-audit.e2e-entity-citations.test.ts'),
  path.resolve(ROOT, 'client/src/pages/PrivacyAudit.peelGraph.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/PrivacyAudit.peelGraph.coinjoin.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/PrivacyAudit.peelGraphContrast.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/PrivacyAudit.peelList.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/Reports.privacyEntityGamblingMixerP2PCitationEndToEnd.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/Reports.privacyProximityGamblingMixerP2PCitationEndToEnd.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/Reports.privacyProximityPaymentServiceCitationEndToEnd.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/Reports.privacyProximityMultiEntityCitationEndToEnd.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/Reports.privacyEntityMiningPoolCitationEndToEnd.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/__tests__/balance-import-history-cancel.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/__tests__/balance-import-history-complete.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/__tests__/balance-import-history-partial.test.tsx'),
  path.resolve(ROOT, 'client/src/pages/__tests__/balance-import-history-failures.test.tsx'),
  path.resolve(ROOT, 'client/src/lib/privacy-audit.ts'),
  path.resolve(ROOT, 'client/src/lib/data/record-queries.ts'),
  path.resolve(ROOT, 'client/src/lib/data/address-stats.ts'),
  path.resolve(ROOT, 'client/src/lib/data/vocabulary-crud.ts'),
]);

const TABLE_NAMES = GUARDED_TABLES.map(g => g.table);
const WRITE_PATTERN = new RegExp(
  `db\\.(${TABLE_NAMES.join('|')})\\.(${WRITE_METHODS.join('|')})\\b`
);
const READ_PATTERN = new RegExp(
  `db\\.(${TABLE_NAMES.join('|')})\\.(${READ_METHODS.join('|')})\\b`
);

const ALLOWED_FILES_SET = new Set([
  ...GUARDED_TABLES.map(g => g.crudFile),
  ...ALWAYS_ALLOWED_FILES,
]);

const SCAN_DIR = path.resolve(ROOT, 'client/src');
const EXTENSIONS = new Set(['.ts', '.tsx']);

// Self-check: if any hardcoded file (a CRUD layer or an allow-listed file) no
// longer exists (renamed/moved/deleted), fail loudly instead of silently
// guarding nothing / allow-listing stale paths.
const CRUD_FILES = new Set(GUARDED_TABLES.map(g => g.crudFile));
const missingRefs = [...ALLOWED_FILES_SET].filter(f => !fs.existsSync(f));
if (!fs.existsSync(SCAN_DIR)) missingRefs.push(SCAN_DIR);
if (missingRefs.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    'check-crud-guards self-check failed: expected file(s) missing:\n'
  );
  for (const f of missingRefs) {
    const label =
      f === SCAN_DIR
        ? ' (SCAN_DIR)'
        : CRUD_FILES.has(f)
          ? ' (GUARDED_TABLES crudFile)'
          : ' (ALWAYS_ALLOWED_FILES entry)';
    console.error(`  ${path.relative(ROOT, f)}${label}`);
  }
  console.error(
    '\n  -> If a file was renamed/moved, update GUARDED_TABLES / ALWAYS_ALLOWED_FILES in scripts/check-crud-guards.js.'
  );
  console.error('     If it was deleted, remove the stale entry.');
  process.exit(1);
}

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
const writeViolations = [];
const readViolations = [];

for (const file of files) {
  const resolved = path.resolve(file);
  if (ALLOWED_FILES_SET.has(resolved)) continue;

  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const writeMatch = lines[i].match(WRITE_PATTERN);
    if (writeMatch) {
      const tableName = writeMatch[1];
      const guard = GUARDED_TABLES.find(g => g.table === tableName);
      writeViolations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: lines[i].trim(),
        table: tableName,
        crudLabel: guard ? guard.label : 'unknown',
      });
      continue;
    }
    const readMatch = lines[i].match(READ_PATTERN);
    if (readMatch) {
      const tableName = readMatch[1];
      const guard = GUARDED_TABLES.find(g => g.table === tableName);
      readViolations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: lines[i].trim(),
        table: tableName,
        crudLabel: guard ? guard.label : 'unknown',
      });
    }
  }
}

const totalViolations = writeViolations.length + readViolations.length;

if (writeViolations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${writeViolations.length} direct write(s) to guarded tables outside their CRUD layers:\n`
  );
  for (const v of writeViolations) {
    console.error(`  ${v.file}:${v.line}  [db.${v.table}]`);
    console.error(`    ${v.text}`);
    console.error(`    -> Route through ${v.crudLabel} (or via dataFacade.ts)\n`);
  }
}

if (readViolations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${readViolations.length} direct read(s) of guarded tables outside their CRUD layers:\n`
  );
  for (const v of readViolations) {
    console.error(`  ${v.file}:${v.line}  [db.${v.table}]`);
    console.error(`    ${v.text}`);
    console.error(`    -> Route through ${v.crudLabel} (or via dataFacade.ts)\n`);
  }
}

if (totalViolations > 0) {
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    `All guarded tables clean: no direct reads or writes found outside CRUD layers.`
  );
  console.log(`  Guarded: ${TABLE_NAMES.join(', ')}`);
}
