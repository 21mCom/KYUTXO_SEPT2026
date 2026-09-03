import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_PACKAGED_TARGETS,
  electronBuilderTargetArgs,
  expectedUnpackedDirectory,
  getPackagedTarget,
  parsePackagedTargetArgs,
} from './packaged-targets.mjs';

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