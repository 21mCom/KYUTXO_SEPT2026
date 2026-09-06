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
  const modules = new Map();

  function parseModule(relative, suppliedSource) {
    if (modules.has(relative)) return modules.get(relative);
    const moduleSource = suppliedSource ?? readRequired(relative);
    const sourceFile = ts.createSourceFile(
      relative,
      moduleSource,
      ts.ScriptTarget.Latest,
      true,
      relative.endsWith('.ts') || relative.endsWith('.tsx')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS,
    );
    const module = {
      relative,
      sourceFile,
      localFunctions: new Map(),
      imports: new Map(),
      exports: new Map(),
      starExports: [],
      dependencies: [],
    };
    modules.set(relative, module);
    if (sourceFile.parseDiagnostics.length > 0) {
      for (const diagnostic of sourceFile.parseDiagnostics) {
        failures.push(
          `${relative} could not be parsed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
        );
      }
      return module;
    }

    function collectLocalFunctions(node) {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        module.localFunctions.set(node.name.text, node);
      } else if (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        module.localFunctions.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collectLocalFunctions);
    }
    collectLocalFunctions(sourceFile);

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) &&
          statement.name &&
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        module.exports.set('default', { local: statement.name.text });
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveLocalImport(relative, statement.moduleSpecifier.text);
        if (!target) continue;
        module.dependencies.push(target);
        const clause = statement.importClause;
        if (clause?.name) module.imports.set(clause.name.text, { target, imported: 'default' });
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            module.imports.set(element.name.text, {
              target,
              imported: element.propertyName?.text ?? element.name.text,
            });
          }
        } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          module.imports.set(clause.namedBindings.name.text, { target, namespace: true });
        }
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          const target = resolveLocalImport(relative, statement.moduleSpecifier.text);
          if (!target) continue;
          module.dependencies.push(target);
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) {
              module.exports.set(element.name.text, {
                target,
                imported: element.propertyName?.text ?? element.name.text,
              });
            }
          } else {
            module.starExports.push(target);
          }
        } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            module.exports.set(element.name.text, {
              local: element.propertyName?.text ?? element.name.text,
            });
          }
        }
      }
    }
    return module;
  }

  const entryModule = parseModule(focusedRelative, source);

  const reached = [];
  const visitedFunctions = new Set();
  const visitedModules = new Set();

  function resolveExport(module, name, seen = new Set()) {
    const key = `${module.relative}:${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const localName = name === 'default' ? 'default' : name;
    if (module.localFunctions.has(localName)) {
      return { module, declaration: module.localFunctions.get(localName) };
    }
    const direct = module.exports.get(name);
    if (direct) {
      if (direct.local && module.localFunctions.has(direct.local)) {
        return { module, declaration: module.localFunctions.get(direct.local) };
      }
      return resolveExport(parseModule(direct.target), direct.imported, seen);
    }
    for (const target of module.starExports) {
      const resolved = resolveExport(parseModule(target), name, seen);
      if (resolved) return resolved;
    }
    return null;
  }

  function resolveCall(module, expression) {
    if (ts.isIdentifier(expression)) {
      const local = module.localFunctions.get(expression.text);
      if (local) return { module, declaration: local };
      const imported = module.imports.get(expression.text);
      if (imported && !imported.namespace) {
        return resolveExport(parseModule(imported.target), imported.imported);
      }
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const imported = module.imports.get(expression.expression.text);
      if (imported?.namespace) {
        return resolveExport(parseModule(imported.target), expression.name.text);
      }
    }
    return null;
  }

  function visitExpression(module, node) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    reached.push(node.getText(module.sourceFile));
    if (ts.isCallExpression(node)) {
      const resolved = resolveCall(module, node.expression);
      if (resolved && !visitedFunctions.has(resolved.declaration)) {
        visitedFunctions.add(resolved.declaration);
        if (ts.isBlock(resolved.declaration.body)) {
          visitStatements(resolved.module, resolved.declaration.body.statements);
        } else {
          visitExpression(resolved.module, resolved.declaration.body);
        }
      }
    }
    ts.forEachChild(node, (child) => visitExpression(module, child));
  }

  function visitStatement(module, statement) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return true;
    if (ts.isFunctionDeclaration(statement)) return true;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      reached.push(statement.getText(module.sourceFile));
      if (statement.expression) visitExpression(module, statement.expression);
      return false;
    }
    if (ts.isIfStatement(statement)) {
      reached.push(statement.expression.getText(module.sourceFile));
      visitExpression(module, statement.expression);
      if (statement.expression.kind === ts.SyntaxKind.FalseKeyword) {
        if (statement.elseStatement) visitStatement(module, statement.elseStatement);
      } else if (statement.expression.kind === ts.SyntaxKind.TrueKeyword) {
        visitStatement(module, statement.thenStatement);
      } else {
        visitStatement(module, statement.thenStatement);
        if (statement.elseStatement) visitStatement(module, statement.elseStatement);
      }
      return true;
    }
    if (ts.isBlock(statement)) {
      visitStatements(module, statement.statements);
      return true;
    }
    if (ts.isVariableStatement(statement)) {
      const executableDeclarations = statement.declarationList.declarations.filter(
        (declaration) => !declaration.initializer ||
          (!ts.isArrowFunction(declaration.initializer) &&
            !ts.isFunctionExpression(declaration.initializer)),
      );
      for (const declaration of executableDeclarations) {
        reached.push(declaration.getText(module.sourceFile));
        if (declaration.initializer) visitExpression(module, declaration.initializer);
      }
      return true;
    }
    reached.push(statement.getText(module.sourceFile));
    ts.forEachChild(statement, (child) => visitExpression(module, child));
    return true;
  }

  function visitStatements(module, statements) {
    for (const statement of statements) {
      if (!visitStatement(module, statement)) break;
    }
  }

  function visitModule(module) {
    if (visitedModules.has(module.relative)) return;
    visitedModules.add(module.relative);
    for (const dependency of module.dependencies) visitModule(parseModule(dependency));
    visitStatements(module, module.sourceFile.statements);
  }

  visitModule(entryModule);
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