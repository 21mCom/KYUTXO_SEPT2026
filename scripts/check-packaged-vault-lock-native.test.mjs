import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  NATIVE_POWER_ACTIONS,
  POLICY_CASES,
  lockSignalsSeen,
  nativeEventsSeen,
  nativePowerAction,
  runPolicyCase,
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

test('policy execution reads the current app output before comparing lock signals', async () => {
  let appOutput = '';
  const result = await runPolicyCase(
    { platform: 'linux' },
    { getOutput: () => appOutput },
    {},
    null,
    POLICY_CASES[0],
    'screenLock',
    {
      runNativeAction: async () => {
        appOutput += [
          '[KYUTXO] Screen locked',
          '[KYUTXO] Vault lock signal: lock-screen',
        ].join('\n');
      },
      waitForNativeEvents: async () => {},
      sleep: async () => {},
      assertRendererLockState: async (_page, shouldBeLocked) => {
        assert.equal(shouldBeLocked, true);
        return 'renderer lock verified';
      },
    },
  );

  assert.equal(result.passed, true);
  assert.match(result.detail, /signals=\["lock-screen"\]/);
  assert.match(result.detail, /renderer lock verified/);
});

test('release publishing requires five self-hosted native smoke jobs without changing PR safety', () => {
  const releaseWorkflow = fs.readFileSync(
    new URL('../.github/workflows/build.yml', import.meta.url),
    'utf8',
  );
  const pullRequestMatrix = fs.readFileSync(
    new URL('../.github/workflows/desktop-package-matrix.yml', import.meta.url),
    'utf8',
  );

  for (const label of [
    'desktop-release-win-x64',
    'desktop-release-darwin-x64',
    'desktop-release-darwin-arm64',
    'desktop-release-linux-x64',
    'desktop-release-linux-arm64',
  ]) {
    assert.match(releaseWorkflow, new RegExp(`runner_label: ${label}`));
  }
  assert.match(
    releaseWorkflow,
    /native-power-smoke:[\s\S]*?\n\s*needs: verify-desktop-package-matrix[\s\S]*?\n\s*if: >-\s*\n\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/,
  );
  assert.match(releaseWorkflow, /runs-on:\s*\n\s*- self-hosted/);
  assert.match(releaseWorkflow, /KYUTXO_NATIVE_POWER_SMOKE: '1'/);
  assert.match(releaseWorkflow, /node scripts\/check-packaged-vault-lock-native\.mjs/);
  assert.match(releaseWorkflow, /Expected 5 PASS results and no FAIL results/);
  assert.match(
    releaseWorkflow,
    /publish-release:[\s\S]*?\n\s*needs: \[build-windows, native-power-smoke\]/,
  );
  assert.match(
    releaseWorkflow,
    /needs\.native-power-smoke\.result == 'success'/,
  );
  assert.match(releaseWorkflow, /if: always\(\)\s*\n\s*uses: actions\/upload-artifact@/);
  assert.match(releaseWorkflow, /find native-power-smoke .* -name '\*\.log'/);
  assert.match(releaseWorkflow, /Missing required native power smoke evidence/);
  assert.match(releaseWorkflow, /Verified \$\{expected\.length\} native power smoke evidence logs/);

  assert.doesNotMatch(pullRequestMatrix, /KYUTXO_NATIVE_POWER_SMOKE/);
  assert.doesNotMatch(
    pullRequestMatrix,
    /node scripts\/check-packaged-vault-lock-native\.mjs(?:\s|$)/,
  );
  assert.doesNotMatch(pullRequestMatrix, /self-hosted/);
});