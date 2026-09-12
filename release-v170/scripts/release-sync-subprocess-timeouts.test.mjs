import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT_PATH = /\bscripts\/([a-zA-Z0-9_./-]+\.(?:cjs|mjs|js))\b/g;
const NPM_RUN = /\bnpm(?:\.cmd)?\s+run\s+([a-zA-Z0-9:_-]+)/g;
const SYNC_APIS = new Set(['execFileSync', 'execSync', 'spawnSync']);

function packageScriptClosure(packageScripts, roots) {
  const names = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (names.has(name)) continue;
    names.add(name);
    const command = packageScripts[name];
    if (!command) continue;
    for (const match of command.matchAll(NPM_RUN)) pending.push(match[1]);
  }
  return names;
}

function scriptPaths(source) {
  return [...source.matchAll(SCRIPT_PATH)].map((match) => path.join('scripts', match[1]));
}

function localImportPath(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = path.extname(base)
    ? [base]
    : [`${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function importedLocalScripts(file, repositoryRoot = ROOT) {
  const source = fs.readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const imported = localImportPath(file, statement.moduleSpecifier.text);
    if (
      imported
      && imported.startsWith(repositoryRoot + path.sep)
      && !imported.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      imports.push(imported);
    }
  }
  return imports;
}

function releaseScriptFiles() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const workflows = [
    fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8'),
    fs.readFileSync(path.join(ROOT, '.github/workflows/desktop-package-matrix.yml'), 'utf8'),
  ].join('\n');
  const workflowPackageRoots = [...workflows.matchAll(NPM_RUN)].map((match) => match[1]);
  const packageNames = packageScriptClosure(packageJson.scripts, [
    ...workflowPackageRoots,
    'test:fast',
    'test:full',
    'release:checksums',
  ]);
  const wiring = [
    workflows,
    ...[...packageNames].map((name) => packageJson.scripts[name] ?? ''),
  ].join('\n');
  const files = new Set(
    scriptPaths(wiring).map((relativePath) => path.resolve(ROOT, relativePath)),
  );

  if (files.has(path.join(ROOT, 'scripts/run-node-tests.mjs'))) {
    for (const name of fs.readdirSync(path.join(ROOT, 'scripts'))) {
      if (name.endsWith('.test.mjs')) files.add(path.join(ROOT, 'scripts', name));
    }
  }

  const pending = [...files];
  while (pending.length > 0) {
    const file = pending.pop();
    for (const imported of importedLocalScripts(file)) {
      if (files.has(imported)) continue;
      files.add(imported);
      pending.push(imported);
    }
  }
  return files;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function hasTimeoutOption(call, api) {
  const optionsIndex = api === 'execSync' ? 1 : 2;
  const options = call.arguments[optionsIndex];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) => (
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && propertyName(property.name) === 'timeout'
  ));
}

function unboundedSyncCalls(file, source = fs.readFileSync(file, 'utf8')) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const directAliases = new Map();
  const namespaceAliases = new Set();

  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!['node:child_process', 'child_process'].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaceAliases.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        if (SYNC_APIS.has(importedName)) directAliases.set(element.name.text, importedName);
      }
    }
  }

  const failures = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      let api = ts.isIdentifier(node.expression) ? directAliases.get(node.expression.text) : null;
      if (
        !api
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && namespaceAliases.has(node.expression.expression.text)
        && SYNC_APIS.has(node.expression.name.text)
      ) {
        api = node.expression.name.text;
      }
      if (api && !hasTimeoutOption(node, api)) {
        failures.push(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return failures;
}

test('release synchronous subprocesses have explicit bounded timeouts', () => {
  const failures = [...releaseScriptFiles()]
    .map((file) => {
      const missing = unboundedSyncCalls(file);
      return missing.length ? `${path.relative(ROOT, file)}:${missing.join(',')}` : null;
    })
    .filter(Boolean);
  assert.deepEqual(failures, [], `unbounded release synchronous subprocesses: ${failures.join(' ')}`);
});

test('guard catches aliased and namespace synchronous subprocess calls', () => {
  const aliased = `
    import { spawnSync as run } from 'node:child_process';
    run('helper', [], { stdio: 'inherit' });
  `;
  const namespaced = `
    import * as childProcess from 'node:child_process';
    childProcess.execSync('helper', { encoding: 'utf8' });
  `;
  assert.deepEqual(unboundedSyncCalls('aliased.mjs', aliased), [3]);
  assert.deepEqual(unboundedSyncCalls('namespaced.mjs', namespaced), [3]);
});

test('package script closure follows npm run indirection', () => {
  const scripts = {
    release: 'npm run verify',
    verify: 'npm run verify:desktop',
    'verify:desktop': 'node scripts/check-desktop.mjs',
  };
  assert.deepEqual(
    [...packageScriptClosure(scripts, ['release'])].sort(),
    ['release', 'verify', 'verify:desktop'],
  );
});

test('local import discovery follows release helpers outside scripts', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-timeout-imports-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const scriptsDir = path.join(fixtureRoot, 'scripts');
  const electronDir = path.join(fixtureRoot, 'electron');
  fs.mkdirSync(scriptsDir);
  fs.mkdirSync(electronDir);
  const entry = path.join(scriptsDir, 'entry.mjs');
  const helper = path.join(electronDir, 'release-helper.mjs');
  fs.writeFileSync(entry, `import '../electron/release-helper.mjs';\n`);
  fs.writeFileSync(
    helper,
    `import { spawnSync } from 'node:child_process';\nspawnSync('helper', []);\n`,
  );

  const imports = importedLocalScripts(entry, fixtureRoot);
  assert.deepEqual(imports, [helper]);
  assert.deepEqual(unboundedSyncCalls(imports[0]), [2]);
});

test('release workflow phases and test tiers run the timeout guard', () => {
  const build = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
  const matrix = fs.readFileSync(path.join(ROOT, '.github/workflows/desktop-package-matrix.yml'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(build, /native-power-smoke:\s*\n\s+timeout-minutes:/);
  assert.match(build, /build-windows:\s*\n\s+timeout-minutes:/);
  assert.match(build, /publish-release:\s*\n\s+timeout-minutes:/);
  assert.match(matrix, /packaged-native-boundary:\s*\n\s+timeout-minutes:/);
  assert.match(packageJson.scripts['test:fast:unguarded'], /release-sync-subprocess-timeouts\.test\.mjs/);
  assert.equal(packageJson.scripts['test:scripts'], 'node scripts/run-node-tests.mjs');
});