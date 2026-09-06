#!/usr/bin/env node
// Guard the boundary between the Transaction Inbox journey and the focused
// encrypted-backup restore proof. Restore dependencies in the inbox check make
// an unrelated feature edit capable of weakening a destructive-operation
// safety proof, while missing validation wiring makes the focused proof inert.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CHECK_RESTORE_SAFETY_ROOT
  ? path.resolve(process.env.CHECK_RESTORE_SAFETY_ROOT)
  : path.resolve(scriptDir, '..');
const inboxRelative = 'scripts/check-transaction-inbox-saved-view-snooze-browser.mjs';
const focusedRelative = 'scripts/check-encrypted-backup-restore-safety-browser.mjs';
const dotReplitRelative = '.replit';
const guardWorkflow = 'restore-safety-isolation-guard';
const focusedWorkflow = 'encrypted-backup-restore-safety-browser-check';
const failures = [];
const localImportPattern =
  /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const coupledPattern =
  /\b(?:backup|restore)\w*\b|JSZip|input-restore|button-open-restore/i;
const focusedRequirements = [
  ...[
    'button-open-restore',
    'input-restore-file',
    'radio-replace',
    'input-restore-password',
    'button-continue-restore',
    'restore-preferences-preview',
    'button-confirm-restore',
  ].map((selector) => ({
    description: `restore selector ${selector}`,
    pattern: new RegExp(`getByTestId\\(\\s*['"]${selector}['"]\\s*\\)`),
  })),
  {
    description: 'malformed plaintext non-destructive assertion',
    pattern:
      /record\(\s*['"]malformed-plaintext-non-destructive['"]\s*,\s*!malformedConfirmVisible\s*&&\s*JSON\.stringify\(afterMalformed\)\s*===\s*JSON\.stringify\(beforeMalformed\)/s,
  },
  {
    description: 'wrong-password non-destructive assertion',
    pattern:
      /record\(\s*`\$\{label\}-wrong-password-non-destructive`\s*,\s*!previewVisible\s*&&\s*JSON\.stringify\(afterWrong\)\s*===\s*JSON\.stringify\(beforeWrong\)/s,
  },
  {
    description: 'corrupt-ciphertext non-destructive assertion',
    pattern:
      /record\(\s*`\$\{label\}-corrupt-ciphertext-non-destructive`\s*,\s*failureMessageVisible\s*&&\s*!corruptPreviewVisible\s*&&\s*JSON\.stringify\(afterCorrupt\)\s*===\s*JSON\.stringify\(beforeWrong\)/s,
  },
  {
    description: 'successful intact-backup retry assertion',
    pattern:
      /record\(\s*`\$\{label\}-correct-password-retry`\s*,\s*verification\.passed\s*,\s*verification\.detail\s*,?\s*\)/s,
  },
  {
    description: 'v3 restore proof invocation',
    pattern: /label:\s*['"]v3['"]/,
  },
  {
    description: 'legacy restore proof invocation',
    pattern: /label:\s*['"]legacy['"]/,
  },
  {
    description: 'corrupt legacy ciphertext proof input',
    pattern: /corruptBackupBuffer:\s*corruptLegacyBackup/,
  },
  {
    description: 'failed-step enforcement',
    pattern:
      /failed = steps\.filter\(\(step\) => !step\.passed\)[\s\S]*?failed\.length[\s\S]*?throw new Error\(/,
  },
];

function reachedFocusedSyntax(source) {
  const sourceFile = ts.createSourceFile(
    focusedRelative,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    for (const diagnostic of sourceFile.parseDiagnostics) {
      failures.push(
        `${focusedRelative} could not be parsed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      );
    }
    return '';
  }

  const localFunctions = new Map();
  function collectLocalFunctions(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      localFunctions.set(node.name.text, node);
    } else if (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      localFunctions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectLocalFunctions);
  }
  collectLocalFunctions(sourceFile);

  const reached = [];
  const visitedFunctions = new Set();

  function visitExpression(node) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    reached.push(node.getText(sourceFile));
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
      if (ts.isIdentifier(callee)) {
        const declaration = localFunctions.get(callee.text);
        if (declaration && !visitedFunctions.has(declaration)) {
          visitedFunctions.add(declaration);
          if (ts.isBlock(declaration.body)) {
            visitStatements(declaration.body.statements);
          } else {
            visitExpression(declaration.body);
          }
        }
      }
    }
    ts.forEachChild(node, visitExpression);
  }

  function visitStatement(statement) {
    if (ts.isFunctionDeclaration(statement)) return true;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      reached.push(statement.getText(sourceFile));
      if (statement.expression) visitExpression(statement.expression);
      return false;
    }
    if (ts.isIfStatement(statement)) {
      reached.push(statement.expression.getText(sourceFile));
      visitExpression(statement.expression);
      if (statement.expression.kind === ts.SyntaxKind.FalseKeyword) {
        if (statement.elseStatement) visitStatement(statement.elseStatement);
      } else if (statement.expression.kind === ts.SyntaxKind.TrueKeyword) {
        visitStatement(statement.thenStatement);
      } else {
        visitStatement(statement.thenStatement);
        if (statement.elseStatement) visitStatement(statement.elseStatement);
      }
      return true;
    }
    if (ts.isBlock(statement)) {
      visitStatements(statement.statements);
      return true;
    }
    if (ts.isVariableStatement(statement)) {
      const executableDeclarations = statement.declarationList.declarations.filter(
        (declaration) => !declaration.initializer ||
          (!ts.isArrowFunction(declaration.initializer) &&
            !ts.isFunctionExpression(declaration.initializer)),
      );
      for (const declaration of executableDeclarations) {
        reached.push(declaration.getText(sourceFile));
        if (declaration.initializer) visitExpression(declaration.initializer);
      }
      return true;
    }
    reached.push(statement.getText(sourceFile));
    ts.forEachChild(statement, visitExpression);
    return true;
  }

  function visitStatements(statements) {
    for (const statement of statements) {
      if (!visitStatement(statement)) break;
    }
  }

  visitStatements(sourceFile.statements);
  return reached.join('\n');
}

function readRequired(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    failures.push(`${relative} is missing.`);
    return '';
  }
  return fs.readFileSync(absolute, 'utf8');
}

function workflowBlock(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(
    new RegExp(
      `\\[\\[workflows\\.workflow\\]\\]\\s*\\nname\\s*=\\s*"${escaped}"[\\s\\S]*?(?=\\n\\[\\[workflows\\.workflow\\]\\]|$)`,
    ),
  );
  return match?.[0] ?? '';
}

function resolveLocalImport(importerRelative, specifier) {
  if (!specifier.startsWith('.')) return null;

  const base = path.resolve(root, path.dirname(importerRelative), specifier);
  const relativeBase = path.relative(root, base);
  if (relativeBase.startsWith('..') || path.isAbsolute(relativeBase)) {
    failures.push(`${importerRelative} imports a local file outside the project root: ${specifier}`);
    return null;
  }

  const extensions = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
  const candidates = path.extname(base)
    ? [base]
    : [
        base,
        ...extensions.map((extension) => `${base}${extension}`),
        ...extensions.map((extension) => path.join(base, `index${extension}`)),
      ];
  const resolved = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!resolved) {
    failures.push(`${importerRelative} imports missing local helper ${specifier}.`);
    return null;
  }
  return path.relative(root, resolved).split(path.sep).join('/');
}

function inboxJourneyFiles(entryRelative) {
  const pending = [entryRelative];
  const visited = new Set();
  const files = [];

  while (pending.length > 0) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    visited.add(relative);

    const source = readRequired(relative);
    files.push({ relative, source });
    for (const match of source.matchAll(localImportPattern)) {
      const resolved = resolveLocalImport(relative, match[1] ?? match[2]);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return files;
}

const inboxFiles = inboxJourneyFiles(inboxRelative);
const focusedSource = readRequired(focusedRelative);
const dotReplit = readRequired(dotReplitRelative);
const focusedExecutableSyntax = reachedFocusedSyntax(focusedSource);

for (const requirement of focusedRequirements) {
  if (!requirement.pattern.test(focusedExecutableSyntax)) {
    failures.push(
      `${focusedRelative} is missing its required ${requirement.description}.`,
    );
  }
}

// Intentionally broad: this journey has no reason to name or import backup or
// restore concepts. Catching comments and fixture names prevents old coupled
// steps from being left behind as misleading scaffolding.
for (const { relative, source } of inboxFiles) {
  const coupledLines = source
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => coupledPattern.test(line));
  for (const hit of coupledLines) {
    failures.push(
      `${relative}:${hit.number} references restore/backup behavior: ${hit.line.trim()}`,
    );
  }
}

const focusedBlock = workflowBlock(dotReplit, focusedWorkflow);
if (!focusedBlock) {
  failures.push(`${focusedWorkflow} is not registered as a workflow in .replit.`);
} else {
  if (!focusedBlock.includes(`node ${focusedRelative}`)) {
    failures.push(`${focusedWorkflow} no longer runs ${focusedRelative}.`);
  }
  if (!/\bisValidation\s*=\s*true\b/.test(focusedBlock)) {
    failures.push(`${focusedWorkflow} is no longer marked isValidation = true.`);
  }
}

const guardBlock = workflowBlock(dotReplit, guardWorkflow);
if (!guardBlock || !/\bisValidation\s*=\s*true\b/.test(guardBlock)) {
  failures.push(`${guardWorkflow} must exist and be marked isValidation = true.`);
}
if (!guardBlock.includes('node scripts/check-restore-safety-isolation.js') ||
    !guardBlock.includes('node --test scripts/check-restore-safety-isolation.test.mjs')) {
  failures.push(`${guardWorkflow} must run both the guard and its script tests.`);
}

const projectBlock = workflowBlock(dotReplit, 'Project');
if (!new RegExp(`args\\s*=\\s*"${guardWorkflow}"`).test(projectBlock)) {
  failures.push(`${guardWorkflow} is missing from the normal Project validation set.`);
}

if (failures.length > 0) {
  console.error('check-restore-safety-isolation: FAILED\n');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(
  'check-restore-safety-isolation: OK — inbox is restore-independent and the focused safety proof plus guard remain complete and in validation.',
);