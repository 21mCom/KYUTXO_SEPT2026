import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NATIVE_POWER_ACTIONS,
  POLICY_CASES,
  lockSignalsSeen,
  nativeEventsSeen,
  nativePowerAction,
} from './check-packaged-vault-lock-native.mjs';

test('defines native suspend and screen-lock actions for every supported host', () => {
  for (const platform of ['win', 'darwin', 'linux']) {
    assert.ok(NATIVE_POWER_ACTIONS[platform].screenLock.command);
    assert.ok(NATIVE_POWER_ACTIONS[platform].suspend.command);
    assert.ok(Array.isArray(NATIVE_POWER_ACTIONS[platform].screenLock.args));
    assert.ok(Array.isArray(NATIVE_POWER_ACTIONS[platform].suspend.args));
  }
});

test('native command overrides are explicit argv arrays, never shell strings', () => {
  assert.deepEqual(
    nativePowerAction('linux', 'screenLock', {
      KYUTXO_SCREEN_LOCK_COMMAND: '["custom-lock","--test"]',
    }),
    { command: 'custom-lock', args: ['--test'] },
  );
  assert.throws(
    () =>
      nativePowerAction('linux', 'suspend', {
        KYUTXO_SUSPEND_COMMAND: 'systemctl suspend',
      }),
    /must be JSON/,
  );
});

test('policy cases cover enabled signals and each disabled lifecycle toggle', () => {
  assert.deepEqual(POLICY_CASES[0].screenLockSignals, ['lock-screen']);
  assert.deepEqual(POLICY_CASES[0].suspendSignals, ['suspend', 'resume']);
  assert.deepEqual(POLICY_CASES[0].env, {
    KYUTXO_LOCK_ON_SUSPEND: '1',
    KYUTXO_LOCK_ON_RESUME: '1',
    KYUTXO_LOCK_ON_SCREEN_LOCK: '1',
  });
  assert.deepEqual(POLICY_CASES[1].screenLockSignals, []);
  assert.equal(POLICY_CASES[1].env.KYUTXO_LOCK_ON_SUSPEND, '1');
  assert.equal(POLICY_CASES[1].env.KYUTXO_LOCK_ON_RESUME, '1');
  assert.equal(POLICY_CASES[1].env.KYUTXO_LOCK_ON_SCREEN_LOCK, '0');
  assert.deepEqual(POLICY_CASES[2].suspendSignals, ['resume']);
  assert.deepEqual(POLICY_CASES[3].suspendSignals, ['suspend']);
  assert.equal(POLICY_CASES[2].env.KYUTXO_LOCK_ON_SUSPEND, '0');
  assert.equal(POLICY_CASES[2].env.KYUTXO_LOCK_ON_RESUME, '1');
  assert.equal(POLICY_CASES[3].env.KYUTXO_LOCK_ON_SUSPEND, '1');
  assert.equal(POLICY_CASES[3].env.KYUTXO_LOCK_ON_RESUME, '0');
});

test('parses ordered native events and exact vault-lock signals from packaged logs', () => {
  const output = [
    '[KYUTXO] Screen locked',
    '[KYUTXO] Vault lock signal: lock-screen',
    '[KYUTXO] System suspending (going to sleep)',
    '[KYUTXO] Vault lock signal: suspend',
    '[KYUTXO] System resumed from sleep',
    '[KYUTXO] Vault lock signal: resume',
  ].join('\n');

  assert.deepEqual(nativeEventsSeen(output), ['lock-screen', 'suspend', 'resume']);
  assert.deepEqual(lockSignalsSeen(output), ['lock-screen', 'suspend', 'resume']);
});