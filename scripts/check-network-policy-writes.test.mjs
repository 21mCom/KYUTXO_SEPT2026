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
const DB_TYPES = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/src/lib/db-types.ts'),
  'utf8',
);

function runGuard(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-policy-write-guard-'));
  try {
    const fixtureFiles = { 'lib/db-types.ts': DB_TYPES, ...files };
    for (const [relativePath, source] of Object.entries(fixtureFiles)) {
      const file = path.join(directory, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    return spawnSync(process.execPath, [GUARD], {
      encoding: 'utf8',
      timeout: 30_000,
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

test('fails closed when a new NodeSettings field has no classification', () => {
  const result = runGuard({
    'lib/db-types.ts': DB_TYPES.replace(
      'export interface NodeSettings {',
      'export interface NodeSettings {\n  privateRelayEnabled?: boolean;',
    ),
    'components/Unclassified.tsx': `
      import { updateNodeSettings } from '@/lib/data/node-settings-crud';
      updateNodeSettings('default', { privateRelayEnabled: true });
    `,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NodeSettings field "privateRelayEnabled" is unclassified/);
  assert.match(result.stderr, /NODE_SETTINGS_POLICY_FIELDS/);
  assert.match(result.stderr, /NODE_SETTINGS_ORDINARY_FIELDS/);
});

test('permits direct CRUD writes to explicitly ordinary NodeSettings fields', () => {
  const result = runGuard({
    'components/Ordinary.tsx': `
      import { putNodeSettings, updateNodeSettings } from '@/lib/data/node-settings-crud';
      updateNodeSettings('default', { requestTimeout: 10_000 });
      putNodeSettings({ id: 'default', providerType: 'blockstream' });
    `,
  });
  assert.equal(result.status, 0, result.stderr);
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

test('fails a direct write whose payload is populated through later property assignments', () => {
  const result = runGuard({
    'bad-mutated-variable.ts': `
      import { updateNodeSettings } from './lib/data/node-settings-crud';
      const policyUpdates = {};
      policyUpdates.networkAccessEnabled = false;
      policyUpdates['firstSyncConfirmedAt'] = undefined;
      updateNodeSettings('default', policyUpdates);
    `,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /networkAccessEnabled/);
  assert.match(result.stderr, /firstSyncConfirmedAt/);
});

test('permits unrelated mutations and mutations made after a CRUD write', () => {
  const result = runGuard({
    'good-mutated-variable.ts': `
      import { updateNodeSettings } from './lib/data/node-settings-crud';
      const ordinaryUpdates = {};
      ordinaryUpdates.requestTimeout = 10_000;
      const unrelated = {};
      unrelated.networkAccessEnabled = false;
      updateNodeSettings('default', ordinaryUpdates);

      const laterMutated = {};
      updateNodeSettings('default', laterMutated);
      laterMutated.networkAccessEnabled = false;
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
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
  const result = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});