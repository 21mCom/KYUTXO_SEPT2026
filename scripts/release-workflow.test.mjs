import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
const matrixWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/desktop-package-matrix.yml'), 'utf8');
const builder = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    shell: process.platform === 'win32',
  });
}

function assertMixedSampleDamageIsRejected(t, publicScript, checkoutPrefix) {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), checkoutPrefix));
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));

  const sampleNames = [
    'tracked-release-sample.pdf',
    'tracked-release-sample.docx',
  ];
  const sourceSample = path.join(ROOT, 'proof-of-funds-Alice_Example-2026-06-30.pdf');
  const sourceBytesBefore = fs.readFileSync(sourceSample);
  const unguardedScript = `${publicScript}:unguarded`;
  fs.mkdirSync(path.join(checkout, 'scripts'));
  fs.copyFileSync(
    path.join(ROOT, 'scripts/check-release-fixtures.mjs'),
    path.join(checkout, 'scripts/check-release-fixtures.mjs'),
  );
  for (const sampleName of sampleNames) {
    fs.writeFileSync(path.join(checkout, sampleName), `original bytes for ${sampleName}`);
  }
  fs.writeFileSync(
    path.join(checkout, 'scripts/damage-samples.mjs'),
    [
      `import fs from 'node:fs';`,
      `fs.rmSync(${JSON.stringify(sampleNames[0])});`,
      `fs.writeFileSync(${JSON.stringify(sampleNames[1])}, 'rewritten');`,
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(checkout, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      scripts: {
        [publicScript]: packageJson.scripts[publicScript],
        [unguardedScript]: 'node scripts/damage-samples.mjs',
      },
    }),
  );

  assert.equal(run('git', ['init', '-q'], checkout).status, 0);
  assert.equal(run('git', ['add', '.'], checkout).status, 0);

  const result = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', publicScript], checkout);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /test command modified 2 checked-in sample document/);
  assert.match(output, new RegExp(`deleted: ${sampleNames[0].replace('.', '\\.')}`));
  assert.match(output, new RegExp(`rewritten: ${sampleNames[1].replace('.', '\\.')}`));
  assert.deepEqual(fs.readFileSync(sourceSample), sourceBytesBefore);
}

test('pull requests and all packages are gated by typecheck and the documented fast tier', () => {
  assert.match(workflow, /pull_request:\s*\n\s+branches:/);
  assert.match(workflow, /name: Type-check\s*\n\s+run: npm run check/);
  assert.match(workflow, /name: Run fast test tier\s*\n\s+run: npm run test:fast/);
  assert.equal(
    packageJson.scripts['test:fast'],
    'node scripts/check-release-fixtures.mjs -- npm run test:fast:unguarded',
  );
  assert.ok(packageJson.scripts['test:fast:unguarded']);
  assert.match(packageJson.scripts['test:unit'], /--maxWorkers=1/);
  assert.equal(packageJson.scripts['test:scripts'], 'node scripts/run-node-tests.mjs');
});

test('the pull-request fast-tier entry point names deleted and rewritten tracked samples', (t) => {
  assertMixedSampleDamageIsRejected(t, 'test:fast', 'fast-tier-fixture-checkout-');
});

test('tagged and explicitly requested releases run the full suite before packaging', () => {
  assert.match(workflow, /tags:\s*\['v\*'\]/);
  assert.match(workflow, /publish_release:\s*\n\s+description:/);
  assert.match(
    workflow,
    /name: Run full required suite for releases[\s\S]*if: >-[\s\S]*startsWith\(github\.ref, 'refs\/tags\/v'\)[\s\S]*inputs\.publish_release[\s\S]*run: npm run test:full/,
  );
  const fullSuiteIndex = workflow.indexOf('run: npm run test:full');
  const packageIndex = workflow.indexOf('run: npx electron-builder');
  assert.ok(fullSuiteIndex > -1 && fullSuiteIndex < packageIndex);
  assert.equal(
    packageJson.scripts['test:full'],
    'node scripts/check-release-fixtures.mjs -- npm run test:full:unguarded',
  );
  assert.doesNotMatch(packageJson.scripts['test:full:unguarded'], /\btest:fast\b/);
  assert.doesNotMatch(packageJson.scripts['test:full:unguarded'], /check-release-fixtures/);
});

test('the release full-suite entry point names deleted and rewritten tracked samples', (t) => {
  assertMixedSampleDamageIsRejected(t, 'test:full', 'full-tier-fixture-checkout-');
});

test('manual releases are bound to an existing version tag at the validated commit', () => {
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(
    workflow,
    /name: Bind release tag to the validated commit[\s\S]*workflow_dispatch[\s\S]*refs\/tags\/\$RELEASE_TAG[\s\S]*git rev-list -n 1 "\$RELEASE_TAG"[\s\S]*"\$TAG_COMMIT" != "\$GITHUB_SHA"/,
  );
  assert.match(
    workflow,
    /RELEASE_TAG: v\$\{\{ needs\.build-windows\.outputs\.version \}\}/,
  );
  assert.match(workflow, /gh release create[\s\S]*--verify-tag/);
});

test('ordinary branch pushes cannot publish a public release', () => {
  assert.doesNotMatch(workflow, /if:\s*github\.event_name == 'push'\s*\n\s+uses: .*release/i);
  assert.match(
    workflow,
    /publish-release:[\s\S]*if: >-[\s\S]*startsWith\(github\.ref, 'refs\/tags\/v'\)[\s\S]*inputs\.publish_release/,
  );
});

test('build is read-only, publishing is isolated, and every action is SHA-pinned', () => {
  assert.match(workflow, /^permissions:\s*\n\s+contents: read/m);
  assert.match(workflow, /publish-release:[\s\S]*permissions:\s*\n\s+contents: write/);
  const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 4);
  for (const action of uses) {
    if (action.startsWith('./')) continue;
    assert.match(action, /@[a-f0-9]{40}$/, `${action} must be pinned to a full commit SHA`);
  }
  assert.doesNotMatch(workflow, /softprops\//);
});

test('the exact packaged executable and checksum are uploaded and released together', () => {
  assert.match(workflow, /run: npm run release:checksums/);
  assert.match(workflow, /release\/\*\.exe\.sha256/);
  assert.match(
    workflow,
    /node scripts\/generate-sha256\.mjs --verify release-assets[^]*find release-assets/,
  );
  assert.match(workflow, /find release-assets[^]*-name '\*\.exe'/);
  assert.match(workflow, /find release-assets[^]*-name '\*\.exe\.sha256'/);
  assert.match(
    workflow,
    /gh release create "\$RELEASE_TAG" "\$\{EXES\[@\]\}" "\$\{SUMS\[@\]\}"/,
  );
});

test('package filenames and workflow artifacts carry the canonical package version', () => {
  assert.equal(packageJson.version, '1.1.69');
  for (const target of ['win', 'mac', 'linux']) {
    assert.match(builder[target].artifactName, /\$\{version\}/);
  }
  assert.match(workflow, /name: KYUTXO-\$\{\{ steps\.version\.outputs\.version \}\}-Portable-/);
  assert.match(matrixWorkflow, /name: Read package version[\s\S]*require\('\.\/package\.json'\)\.version/);
  assert.match(
    matrixWorkflow,
    /name: KYUTXO-\$\{\{ steps\.version\.outputs\.version \}\}-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}/,
  );
});
