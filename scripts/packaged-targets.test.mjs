import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_PACKAGED_TARGETS,
  electronBuilderTargetArgs,
  expectedUnpackedDirectory,
  getPackagedTarget,
  parsePackagedTargetArgs,
} from './packaged-targets.mjs';
import {
  assertVersionAgreement,
  expectedArtifactName,
  expectedArtifactNames,
  parseAppImageDesktopVersion,
} from './check-packaged-app-version.mjs';

test('declares one explicit native verification target per supported package', () => {
  assert.deepEqual(
    SUPPORTED_PACKAGED_TARGETS.map(({ platform, arch }) => `${platform}/${arch}`),
    ['win/x64', 'darwin/x64', 'darwin/arm64', 'linux/x64', 'linux/arm64'],
  );
});

test('builder arguments preserve the requested platform and architecture', () => {
  assert.deepEqual(electronBuilderTargetArgs('win', 'x64'), ['--win', '--x64']);
  assert.deepEqual(electronBuilderTargetArgs('darwin', 'arm64'), ['--mac', '--arm64']);
  assert.deepEqual(electronBuilderTargetArgs('linux', 'arm64'), ['--linux', '--arm64']);
});

test('rejects an unlisted target instead of silently testing a fallback', () => {
  assert.throws(
    () => getPackagedTarget('win', 'arm64'),
    /Unsupported packaged target win\/arm64/,
  );
  assert.throws(
    () => electronBuilderTargetArgs('freebsd', 'x64'),
    /Unsupported packaged target freebsd\/x64/,
  );
});

test('target paths and artifact extensions remain platform-specific', () => {
  assert.equal(
    expectedUnpackedDirectory('/workspace', 'darwin', 'x64'),
    '/workspace/release/mac',
  );
  assert.equal(
    expectedUnpackedDirectory('/workspace', 'linux', 'arm64'),
    '/workspace/release/linux-arm64-unpacked',
  );
});

test('CLI parsing requires explicit target identity', () => {
  assert.deepEqual(
    parsePackagedTargetArgs([
      '--platform',
      'linux',
      '--arch',
      'x64',
      '--unpacked-dir',
      '/tmp/linux',
      '--require-electron',
    ]),
    {
      platform: 'linux',
      arch: 'x64',
      unpackedDir: '/tmp/linux',
      requireElectron: true,
      localDiagnostic: false,
    },
  );
  assert.throws(() => parsePackagedTargetArgs(['--platform', 'linux']), /--platform and --arch/);
});

test('supports equals syntax without silently dropping the release target', () => {
  assert.deepEqual(
    parsePackagedTargetArgs(['--platform=darwin', '--arch=arm64', '--require-electron']),
    {
      platform: 'darwin',
      arch: 'arm64',
      unpackedDir: undefined,
      requireElectron: true,
      localDiagnostic: false,
    },
  );
});

test('host-derived fallback requires an unmistakable local diagnostic mode', () => {
  assert.throws(() => parsePackagedTargetArgs([]), /--platform and --arch are required/);
  assert.deepEqual(parsePackagedTargetArgs(['--local-diagnostic']), {
    platform: undefined,
    arch: undefined,
    unpackedDir: undefined,
    requireElectron: false,
    localDiagnostic: true,
  });
  assert.throws(
    () => parsePackagedTargetArgs(['--local-diagnostic', '--platform', 'linux', '--arch', 'x64']),
    /cannot be combined/,
  );
});

test('release artifact names bind every platform to package.json version', () => {
  assert.equal(expectedArtifactName('win', 'x64', '1.2.3'), 'KYUTXO-1.2.3-Portable.exe');
  assert.equal(expectedArtifactName('darwin', 'arm64', '1.2.3'), 'KYUTXO-1.2.3-arm64.dmg');
  assert.equal(expectedArtifactName('linux', 'x64', '1.2.3'), 'KYUTXO-1.2.3-x64.AppImage');
  assert.deepEqual(expectedArtifactNames('darwin', 'x64', '1.2.3'), [
    'KYUTXO-1.2.3-x64.dmg',
    'KYUTXO-1.2.3-x64.zip',
  ]);
});

test('version agreement rejects filename and internal metadata drift independently', () => {
  assert.doesNotThrow(() => assertVersionAgreement({
    packageVersion: '1.2.3',
    artifactPath: '/release/KYUTXO-1.2.3-x64.AppImage',
    internalVersion: '1.2.3',
    platform: 'linux',
    arch: 'x64',
  }));
  assert.throws(() => assertVersionAgreement({
    packageVersion: '1.2.3',
    artifactPath: '/release/KYUTXO-1.2.2-x64.AppImage',
    internalVersion: '1.2.3',
    platform: 'linux',
    arch: 'x64',
  }), /filename version mismatch/);
  assert.throws(() => assertVersionAgreement({
    packageVersion: '1.2.3',
    artifactPath: '/release/KYUTXO-1.2.3-x64.AppImage',
    internalVersion: '1.2.2',
    platform: 'linux',
    arch: 'x64',
  }), /Internal app version mismatch/);
});

test('reads the AppImage version from installed desktop metadata', () => {
  assert.equal(
    parseAppImageDesktopVersion('[Desktop Entry]\nName=KYUTXO\nX-AppImage-Version=1.2.3\n'),
    '1.2.3',
  );
  assert.throws(() => parseAppImageDesktopVersion('[Desktop Entry]\nName=KYUTXO\n'), /no X-AppImage-Version/);
});

test('desktop package matrix verifies internal version before upload', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'desktop-package-matrix.yml'),
    'utf8',
  );
  const checkIndex = workflow.indexOf('node scripts/check-packaged-app-version.mjs');
  const uploadIndex = workflow.indexOf('- name: Upload verified package');
  assert.ok(checkIndex !== -1, 'matrix must run the packaged app version verifier');
  assert.ok(uploadIndex !== -1 && checkIndex < uploadIndex, 'version verifier must block upload');
  assert.match(workflow, /--platform \$\{\{ matrix\.platform \}\}/);
  assert.match(workflow, /--arch \$\{\{ matrix\.arch \}\}/);
});