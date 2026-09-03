import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('pull requests and all packages are gated by typecheck and the documented fast tier', () => {
  assert.match(workflow, /pull_request:\s*\n\s+branches:/);
  assert.match(workflow, /name: Type-check\s*\n\s+run: npm run check/);
  assert.match(workflow, /name: Run fast test tier\s*\n\s+run: npm run test:fast/);
  assert.ok(packageJson.scripts['test:fast']);
  assert.match(packageJson.scripts['test:unit'], /--maxWorkers=1/);
  assert.equal(packageJson.scripts['test:scripts'], 'node scripts/run-node-tests.mjs');
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
  assert.match(workflow, /find release-assets[^]*-name '\*\.exe'/);
  assert.match(workflow, /find release-assets[^]*-name '\*\.exe\.sha256'/);
  assert.match(
    workflow,
    /gh release create "\$RELEASE_TAG" "\$\{EXES\[@\]\}" "\$\{SUMS\[@\]\}"/,
  );
});