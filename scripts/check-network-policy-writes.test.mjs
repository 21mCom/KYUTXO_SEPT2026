import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-network-policy-writes.js',
);

function runGuard(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-policy-write-guard-'));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const file = path.join(directory, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    return spawnSync(process.execPath, [GUARD], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_NETWORK_POLICY_SOURCE_DIR: directory },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('passes unrelated writes and policy changes routed through the hook', () => {
  const result = runGuard({
    'components/Good.tsx': `
      import { updateNodeSettings } from '@/lib/data/node-settings-crud';
      updateNodeSettings('default', { requestTimeout: 10_000 });
      updateSettings({ networkAccessEnabled: false });
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('fails a direct named-import policy write', () => {
  const result = runGuard({
    'components/Bad.tsx': `
      import { updateNodeSettings } from '@/lib/data/node-settings-crud';
      updateNodeSettings('default', {
        networkAccessEnabled: false,
        networkPrivacyMode: undefined,
      });
    `,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /networkAccessEnabled/);
  assert.match(result.stderr, /networkPrivacyMode/);
  assert.match(result.stderr, /components\/Bad\.tsx/);
});

test('fails aliased and namespace-import writes', () => {
  const aliased = runGuard({
    'bad-alias.ts': `
      import { putNodeSettings as persist } from './lib/data/node-settings-crud';
      persist({ id: 'default', firstSyncConfirmedAt: Date.now() });
    `,
  });
  assert.equal(aliased.status, 1);
  assert.match(aliased.stderr, /firstSyncConfirmedAt/);

  const namespace = runGuard({
    'bad-namespace.ts': `
      import * as nodeSettingsCrud from './lib/data/node-settings-crud';
      nodeSettingsCrud.addNodeSettings({
        id: 'default',
        networkOnboardingStage: 'source',
      });
    `,
  });
  assert.equal(namespace.status, 1);
  assert.match(namespace.stderr, /networkOnboardingStage/);
});

test('fails a direct write whose payload is held in a local variable', () => {
  const result = runGuard({
    'bad-variable.ts': `
      import { updateNodeSettings } from './lib/data/node-settings-crud';
      const policyUpdates = {
        networkAccessEnabled: false,
        firstSyncConfirmedAt: undefined,
      };
      updateNodeSettings('default', policyUpdates);
    `,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /networkAccessEnabled/);
  assert.match(result.stderr, /firstSyncConfirmedAt/);
});

test('ignores test sources and permits the approved serialized modules', () => {
  const result = runGuard({
    'feature.test.ts': `
      import { updateNodeSettings } from './lib/data/node-settings-crud';
      updateNodeSettings('default', { networkAccessEnabled: true });
    `,
    'lib/network-privacy.ts': `
      import { updateNodeSettings } from './data/node-settings-crud';
      serializeNodeSettingsWrite(() =>
        updateNodeSettings('default', { networkAccessEnabled: false })
      );
    `,
    'hooks/use-node-settings.ts': `
      import { putNodeSettings } from '@/lib/data/node-settings-crud';
      serializeNodeSettingsWrite(() =>
        putNodeSettings({ id: 'default', networkPrivacyChosenAt: Date.now() })
      );
    `,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('the real production source tree passes', () => {
  const result = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});