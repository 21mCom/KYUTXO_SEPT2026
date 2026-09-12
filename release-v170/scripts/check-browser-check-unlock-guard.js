#!/usr/bin/env node
// Guard: check scripts must not hardcode LoginScreen, migration-overlay, or
// generic fresh-vault onboarding testids — they must go through
// scripts/browser-check-utils.mjs.
//
// WHY: every scripts/check-*.mjs script that drives a real browser needs to
// get past the lock screen. Before this guard existed, ~80 scripts each
// carried their own inline copy of "fill input-password, click
// button-submit, wait for it to go away." If LoginScreen.tsx or
// LegacyMigrationOverlay.tsx ever rename one of these testids, every inline
// copy breaks silently — the affected check just times out at unlock with no
// obvious cause (see scripts/browser-check-utils.mjs for the shared
// unlockIfNeeded / dismissMigrationOverlayIfPresent / waitForLoginScreenVisible
// helpers). This guard fails fast so a new/edited check script can't
// reintroduce the duplication.
//
// Rule: no scripts/*.mjs or scripts/*.js file (other than
// browser-check-utils.mjs itself and the explicit allowlists below) may
// contain a string literal for one of the guarded testids. Route generic
// checks through the shared helpers instead.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = process.env.BROWSER_CHECK_UNLOCK_GUARD_SCRIPTS_DIR
  ? path.resolve(process.env.BROWSER_CHECK_UNLOCK_GUARD_SCRIPTS_DIR)
  : __dirname;

// The authoritative source of these testids.
const SOURCE_FILES = [
  path.join(SCRIPTS_DIR, '..', 'client/src/components/LoginScreen.tsx'),
  path.join(SCRIPTS_DIR, '..', 'client/src/components/LegacyMigrationOverlay.tsx'),
  path.join(SCRIPTS_DIR, '..', 'client/src/components/NetworkPrivacyOnboarding.tsx'),
];

const UTILS_FILE = path.join(SCRIPTS_DIR, 'browser-check-utils.mjs');

// input-password / input-confirm-password are unique to LoginScreen.tsx;
// legacy-migration-overlay / button-dismiss-migration are unique to
// LegacyMigrationOverlay.tsx. (button-submit is intentionally NOT included:
// it is also used by unrelated forms, e.g. client/src/pages/Evidence.tsx, so
// it can't be linted as an unlock-only signal.)
const UNLOCK_TESTIDS = [
  'input-password',
  'input-confirm-password',
  'legacy-migration-overlay',
  'button-dismiss-migration',
];

const ONBOARDING_TESTIDS = [
  'network-onboarding-source',
  'choice-network-offline',
  'choice-network-public-direct',
  'button-save-network-choice',
  'network-onboarding-import',
  'button-onboarding-finish',
];

// Files that legitimately need direct testid access because they test the
// LoginScreen/migration-overlay's own behavior (wrong-password rejection,
// stuck-fill detection, etc.) rather than merely getting past it to test
// something else.
const UNLOCK_ALLOWLIST = new Set([
  path.join(SCRIPTS_DIR, 'check-packaged-vault-lock-native.mjs'),
  path.join(SCRIPTS_DIR, 'check-packaged-wrong-password-browser.mjs'),
]);

// This check owns the first-run onboarding journey itself, including proving
// that an existing vault never sees the wizard, so direct selector access is
// intentional. Generic fresh-vault checks must use the shared helper.
const ONBOARDING_ALLOWLIST = new Set([
  path.join(SCRIPTS_DIR, 'check-first-run-network-privacy-browser.mjs'),
]);

// Self-check: fail loudly if a hardcoded reference no longer exists, so a
// rename/move doesn't silently disable this guard.
const missing = [
  ...SOURCE_FILES,
  UTILS_FILE,
  ...UNLOCK_ALLOWLIST,
  ...ONBOARDING_ALLOWLIST,
].filter((f) => !fs.existsSync(f));
if (missing.length > 0) {
  console.error(
    'check-browser-check-unlock-guard self-check failed: expected file(s) missing:\n' +
      missing.map((f) => `  ${path.relative(process.cwd(), f)}`).join('\n') +
      '\n  -> If a file was renamed/moved, update scripts/check-browser-check-unlock-guard.js.',
  );
  process.exit(1);
}

const GUARDED_TESTIDS = [...UNLOCK_TESTIDS, ...ONBOARDING_TESTIDS];
const TESTID_PATTERN = new RegExp("[\"'`](" + GUARDED_TESTIDS.join('|') + ")[\"'`]");
const STRING_LITERAL_SOURCE = String.raw`["'\x60]([a-z0-9-]*)["'\x60]`;
const CONCATENATED_STRING_PATTERN = new RegExp(
  `${STRING_LITERAL_SOURCE}(?:\\s*\\+\\s*${STRING_LITERAL_SOURCE})+`,
  'g',
);
const STRING_LITERAL_PATTERN = new RegExp(STRING_LITERAL_SOURCE, 'g');

const SELF_FILE = path.basename(__filename);

function evaluateStaticString(node, bindings, functions, seen = new Set()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return evaluateStaticString(node.expression, bindings, functions, seen);
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return undefined;
    const initializer = bindings.get(node.text);
    if (!initializer) return undefined;
    return evaluateStaticString(initializer, bindings, functions, new Set([...seen, node.text]));
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateStaticString(node.left, bindings, functions, seen);
    const right = evaluateStaticString(node.right, bindings, functions, seen);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = evaluateStaticString(span.expression, bindings, functions, seen);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    let objectNode = node.expression;
    if (ts.isIdentifier(objectNode)) {
      if (seen.has(objectNode.text)) return undefined;
      objectNode = bindings.get(objectNode.text);
      if (!objectNode) return undefined;
      seen = new Set([...seen, node.expression.text]);
    }
    if (!ts.isObjectLiteralExpression(objectNode)) return undefined;
    const propertyName = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : node.argumentExpression
        ? evaluateStaticString(node.argumentExpression, bindings, functions, seen)
        : undefined;
    if (propertyName === undefined) return undefined;
    const property = objectNode.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) &&
        ((ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
          candidate.name.text === propertyName),
    );
    return property && ts.isPropertyAssignment(property)
      ? evaluateStaticString(property.initializer, bindings, functions, seen)
      : undefined;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join'
  ) {
    let arrayNode = node.expression.expression;
    if (ts.isIdentifier(arrayNode)) {
      if (seen.has(arrayNode.text)) return undefined;
      arrayNode = bindings.get(arrayNode.text);
      if (!arrayNode) return undefined;
      seen = new Set([...seen, node.expression.expression.text]);
    }
    if (!ts.isArrayLiteralExpression(arrayNode)) return undefined;
    const separator =
      node.arguments.length === 0
        ? ','
        : evaluateStaticString(node.arguments[0], bindings, functions, seen);
    if (separator === undefined) return undefined;
    const values = arrayNode.elements.map((element) =>
      evaluateStaticString(element, bindings, functions, seen),
    );
    return values.some((value) => value === undefined) ? undefined : values.join(separator);
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const functionName = node.expression.text;
    if (seen.has(functionName)) return undefined;
    let callable = functions.get(functionName) ?? bindings.get(functionName);
    const callableAliases = new Set([functionName]);
    while (callable && ts.isIdentifier(callable)) {
      if (callableAliases.has(callable.text) || seen.has(callable.text)) return undefined;
      callableAliases.add(callable.text);
      callable = functions.get(callable.text) ?? bindings.get(callable.text);
    }
    if (
      !callable ||
      (!ts.isFunctionDeclaration(callable) &&
        !ts.isFunctionExpression(callable) &&
        !ts.isArrowFunction(callable))
    ) {
      return undefined;
    }
    const localBindings = new Map(bindings);
    for (let index = 0; index < callable.parameters.length; index += 1) {
      const parameter = callable.parameters[index];
      const argument = node.arguments[index];
      if (!ts.isIdentifier(parameter.name) || !argument) return undefined;
      localBindings.set(parameter.name.text, argument);
    }
    let returnedExpression;
    if (ts.isBlock(callable.body)) {
      const statements = [...callable.body.statements];
      const returnStatement = statements.pop();
      if (!returnStatement || !ts.isReturnStatement(returnStatement)) return undefined;
      for (const statement of statements) {
        if (
          !ts.isVariableStatement(statement) ||
          (statement.declarationList.flags & ts.NodeFlags.Const) === 0
        ) {
          return undefined;
        }
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined;
          localBindings.set(declaration.name.text, declaration.initializer);
        }
      }
      returnedExpression = returnStatement.expression;
    } else {
      returnedExpression = callable.body;
    }
    return returnedExpression
      ? evaluateStaticString(
          returnedExpression,
          localBindings,
          functions,
          new Set([...seen, functionName]),
        )
      : undefined;
  }
  return undefined;
}

function findComputedTestidHits(source, file, full) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bindings = new Map();
  const functions = new Map();
  const hits = [];

  function resolveObjectLiteral(node, seen = new Set()) {
    if (ts.isParenthesizedExpression(node)) {
      return resolveObjectLiteral(node.expression, seen);
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return undefined;
      const initializer = bindings.get(node.text);
      return initializer
        ? resolveObjectLiteral(initializer, new Set([...seen, node.text]))
        : undefined;
    }
    return ts.isObjectLiteralExpression(node) ? node : undefined;
  }

  function resolveArrayLiteral(node, seen = new Set()) {
    if (ts.isParenthesizedExpression(node)) {
      return resolveArrayLiteral(node.expression, seen);
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return undefined;
      const initializer = bindings.get(node.text);
      return initializer
        ? resolveArrayLiteral(initializer, new Set([...seen, node.text]))
        : undefined;
    }
    return ts.isArrayLiteralExpression(node) ? node : undefined;
  }

  function recordConstBinding(name, initializer) {
    if (ts.isIdentifier(name)) {
      bindings.set(name.text, initializer);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      const objectLiteral = resolveObjectLiteral(initializer);
      if (!objectLiteral) return;
      for (const element of name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
        const sourceName = element.propertyName ?? element.name;
        if (!ts.isIdentifier(sourceName) && !ts.isStringLiteral(sourceName)) continue;
        const property = objectLiteral.properties.find(
          (candidate) =>
            ts.isPropertyAssignment(candidate) &&
            (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
            candidate.name.text === sourceName.text,
        );
        if (property && ts.isPropertyAssignment(property)) {
          bindings.set(element.name.text, property.initializer);
        }
      }
      return;
    }
    if (!ts.isArrayBindingPattern(name)) return;
    const arrayLiteral = resolveArrayLiteral(initializer);
    if (!arrayLiteral) return;
    for (let index = 0; index < name.elements.length; index += 1) {
      const element = name.elements[index];
      if (
        ts.isOmittedExpression(element) ||
        element.dotDotDotToken ||
        !ts.isIdentifier(element.name)
      ) {
        continue;
      }
      const value = arrayLiteral.elements[index];
      if (value && !ts.isSpreadElement(value)) {
        bindings.set(element.name.text, value);
      }
    }
  }

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.set(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      node.parent &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      recordConstBinding(node.name, node.initializer);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'getByTestId' &&
      node.arguments.length > 0
    ) {
      const testid = evaluateStaticString(node.arguments[0], bindings, functions);
      if (GUARDED_TESTIDS.includes(testid)) {
        const allowed =
          (UNLOCK_TESTIDS.includes(testid) && UNLOCK_ALLOWLIST.has(full)) ||
          (ONBOARDING_TESTIDS.includes(testid) && ONBOARDING_ALLOWLIST.has(full));
        if (!allowed) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.arguments[0].getStart(sourceFile)).line + 1;
          hits.push({ line, testid });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}

const files = fs
  .readdirSync(SCRIPTS_DIR)
  .filter(
    (f) => (f.endsWith('.mjs') || f.endsWith('.js')) && f !== path.basename(UTILS_FILE) && f !== SELF_FILE,
  )
  .filter((f) => f.startsWith('check-') || f.startsWith('browser-'))
  .sort();

if (files.length === 0) {
  console.error(
    'check-browser-check-unlock-guard: no scripts/check-*.mjs files found — glob or layout changed?',
  );
  process.exit(1);
}

const failures = [];

for (const file of files) {
  const full = path.join(SCRIPTS_DIR, file);

  const source = fs.readFileSync(full, 'utf8');
  const lines = source.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(TESTID_PATTERN);
    const allowed =
      (UNLOCK_TESTIDS.includes(m?.[1]) && UNLOCK_ALLOWLIST.has(full)) ||
      (ONBOARDING_TESTIDS.includes(m?.[1]) && ONBOARDING_ALLOWLIST.has(full));
    if (m && !allowed) {
      hits.push({ line: i + 1, testid: m[1], text: line.trim() });
    }
  });
  for (const match of source.matchAll(CONCATENATED_STRING_PATTERN)) {
    const testid = [...match[0].matchAll(STRING_LITERAL_PATTERN)]
      .map((literalMatch) => literalMatch[1])
      .join('');
    if (!GUARDED_TESTIDS.includes(testid)) continue;
    const allowed =
      (UNLOCK_TESTIDS.includes(testid) && UNLOCK_ALLOWLIST.has(full)) ||
      (ONBOARDING_TESTIDS.includes(testid) && ONBOARDING_ALLOWLIST.has(full));
    if (allowed) continue;
    const line = source.slice(0, match.index).split('\n').length;
    if (!hits.some((hit) => hit.line === line && hit.testid === testid)) {
      hits.push({ line, testid, text: lines[line - 1].trim() });
    }
  }
  for (const hit of findComputedTestidHits(source, file, full)) {
    if (!hits.some((existing) => existing.line === hit.line && existing.testid === hit.testid)) {
      hits.push({ ...hit, text: lines[hit.line - 1].trim() });
    }
  }
  if (hits.length > 0) {
    failures.push({ file, hits });
  }
}

if (failures.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${failures.length} check script(s) hardcoding unlock/onboarding testids instead of using scripts/browser-check-utils.mjs:\n`,
  );
  for (const { file, hits } of failures) {
    for (const hit of hits) {
      console.error(`  ${file}:${hit.line}  [${hit.testid}]`);
      console.error(`    ${hit.text}`);
    }
    console.error(
      "    -> Import the relevant unlock or completeFreshVaultOnboardingIfPresent helper from './browser-check-utils.mjs' instead.\n",
    );
  }
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    'All check scripts clean: no hardcoded unlock/onboarding testids found outside explicit allowlists.',
  );
  console.log(`  Scanned: ${files.length} file(s). Guarded testids: ${GUARDED_TESTIDS.join(', ')}`);
}
