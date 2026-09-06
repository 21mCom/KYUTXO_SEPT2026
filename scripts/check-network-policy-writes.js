#!/usr/bin/env node
// Guard: network-policy fields may only be persisted by modules that use the
// shared node-settings serialization boundary.
//
// This scans production TypeScript sources with the TypeScript parser, tracks
// named and namespace imports of node-settings-crud, and rejects direct
// add/put/update payloads containing a protected policy field outside the
// approved modules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = process.env.CHECK_NETWORK_POLICY_SOURCE_DIR
  ? path.resolve(process.env.CHECK_NETWORK_POLICY_SOURCE_DIR)
  : path.join(ROOT, 'client/src');

const APPROVED_RELATIVE_FILES = new Set([
  'hooks/use-node-settings.ts',
  'lib/network-privacy.ts',
]);
const DB_TYPES_FILE = path.join(SOURCE_DIR, 'lib/db-types.ts');
const POLICY_FIELDS_EXPORT = 'NODE_SETTINGS_POLICY_FIELDS';
const ORDINARY_FIELDS_EXPORT = 'NODE_SETTINGS_ORDINARY_FIELDS';
const WRITE_EXPORTS = new Set([
  'addNodeSettings',
  'putNodeSettings',
  'updateNodeSettings',
]);

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name)
    ) {
      yield fullPath;
    }
  }
}

function isNodeSettingsCrudImport(moduleName) {
  return /(?:^|\/)data\/node-settings-crud$/.test(moduleName);
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function unwrapExpression(expression) {
  while (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function readNodeSettingsClassification() {
  if (!fs.existsSync(DB_TYPES_FILE)) {
    return {
      failures: [`missing NodeSettings classification source: ${path.relative(SOURCE_DIR, DB_TYPES_FILE)}`],
      policyFields: new Set(),
    };
  }

  const source = fs.readFileSync(DB_TYPES_FILE, 'utf8');
  const sourceFile = ts.createSourceFile(
    DB_TYPES_FILE,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let nodeSettings;
  const classifications = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'NodeSettings') {
      nodeSettings = statement;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        ![POLICY_FIELDS_EXPORT, ORDINARY_FIELDS_EXPORT].includes(declaration.name.text) ||
        !declaration.initializer
      ) {
        continue;
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isArrayLiteralExpression(initializer)) continue;
      classifications.set(
        declaration.name.text,
        initializer.elements
          .filter(ts.isStringLiteral)
          .map(element => element.text),
      );
    }
  }

  const failures = [];
  if (!nodeSettings) failures.push('lib/db-types.ts does not declare NodeSettings');
  for (const exportName of [POLICY_FIELDS_EXPORT, ORDINARY_FIELDS_EXPORT]) {
    if (!classifications.has(exportName)) {
      failures.push(`lib/db-types.ts does not declare ${exportName} as a string-literal array`);
    }
  }
  if (failures.length > 0) return { failures, policyFields: new Set() };

  const interfaceFields = new Set(
    nodeSettings.members
      .filter(ts.isPropertySignature)
      .map(member => propertyNameText(member.name))
      .filter(Boolean),
  );
  const policyFields = new Set(classifications.get(POLICY_FIELDS_EXPORT));
  const ordinaryFields = new Set(classifications.get(ORDINARY_FIELDS_EXPORT));

  for (const field of policyFields) {
    if (ordinaryFields.has(field)) failures.push(`NodeSettings field "${field}" has multiple classifications`);
    if (!interfaceFields.has(field)) failures.push(`classified policy field "${field}" is not in NodeSettings`);
  }
  for (const field of ordinaryFields) {
    if (!interfaceFields.has(field)) failures.push(`classified ordinary field "${field}" is not in NodeSettings`);
  }
  for (const field of interfaceFields) {
    if (!policyFields.has(field) && !ordinaryFields.has(field)) {
      failures.push(`NodeSettings field "${field}" is unclassified`);
    }
  }

  return { failures, policyFields };
}

function findPolicyFields(node, localInitializers, found = new Set(), visited = new Set()) {
  if (ts.isIdentifier(node) && localInitializers.has(node.text) && !visited.has(node.text)) {
    visited.add(node.text);
    findPolicyFields(localInitializers.get(node.text), localInitializers, found, visited);
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    const field = propertyNameText(node.name);
    if (field && POLICY_FIELDS.has(field)) found.add(field);
  }
  ts.forEachChild(node, child => {
    findPolicyFields(child, localInitializers, found, visited);
  });
  return found;
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${position.line + 1}:${position.character + 1}`;
}

const classification = readNodeSettingsClassification();
if (classification.failures.length > 0) {
  console.error('check-network-policy-writes: NodeSettings field classification is incomplete:\n');
  for (const failure of classification.failures) console.error(` - ${failure}`);
  console.error(
    `\nClassify every NodeSettings field in ${POLICY_FIELDS_EXPORT} or ${ORDINARY_FIELDS_EXPORT}.`,
  );
  process.exit(1);
}
const POLICY_FIELDS = classification.policyFields;

const files = [...walk(SOURCE_DIR)];
if (files.length === 0) {
  console.error(
    `check-network-policy-writes: no production TypeScript files found under ${SOURCE_DIR}`,
  );
  process.exit(1);
}

const failures = [];
for (const file of files) {
  const relativeFile = path.relative(SOURCE_DIR, file).split(path.sep).join('/');
  if (APPROVED_RELATIVE_FILES.has(relativeFile)) continue;

  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const localWrites = new Map();
  const namespaceImports = new Set();
  const localInitializers = new Map();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!isNodeSettingsCrudImport(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const exportedName = element.propertyName?.text ?? element.name.text;
        if (WRITE_EXPORTS.has(exportedName)) {
          localWrites.set(element.name.text, exportedName);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceImports.add(bindings.name.text);
    }
  }

  function collectLocalInitializers(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      localInitializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectLocalInitializers);
  }
  collectLocalInitializers(sourceFile);

  function visit(node) {
    if (ts.isCallExpression(node)) {
      let writeName;
      if (ts.isIdentifier(node.expression)) {
        writeName = localWrites.get(node.expression.text);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        namespaceImports.has(node.expression.expression.text) &&
        WRITE_EXPORTS.has(node.expression.name.text)
      ) {
        writeName = node.expression.name.text;
      }
      if (writeName) {
        const fields = new Set();
        for (const argument of node.arguments) {
          findPolicyFields(argument, localInitializers, fields);
        }
        if (fields.size > 0) {
          failures.push(
            `${relativeFile}:${lineAndColumn(sourceFile, node)} calls ${writeName} with protected field(s): ${[...fields].sort().join(', ')}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

if (failures.length > 0) {
  console.error(
    'check-network-policy-writes: direct network-policy persistence bypasses the shared serialization boundary:\n',
  );
  for (const failure of failures) console.error(` - ${failure}`);
  console.error(
    '\nRoute policy changes through useNodeSettings/updateSettings or an approved helper in client/src/lib/network-privacy.ts.',
  );
  process.exit(1);
}

console.log(
  `check-network-policy-writes: OK — ${files.length} production TypeScript source(s) contain no unapproved direct network-policy writes.`,
);