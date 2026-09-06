import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  completeFreshVaultOnboardingIfPresent,
  dismissMigrationOverlayIfPresent,
  unlockIfNeeded,
  waitForExistingVaultLoginScreen,
} from './browser-check-utils.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const unlockGuardPath = path.join(scriptsDir, 'check-browser-check-unlock-guard.js');

function makeUnlockGuardFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-check-unlock-guard-'));
  const fixtureScriptsDir = path.join(root, 'scripts');
  const componentsDir = path.join(root, 'client/src/components');
  fs.mkdirSync(fixtureScriptsDir, { recursive: true });
  fs.mkdirSync(componentsDir, { recursive: true });

  for (const component of [
    'LoginScreen.tsx',
    'LegacyMigrationOverlay.tsx',
    'NetworkPrivacyOnboarding.tsx',
  ]) {
    fs.writeFileSync(path.join(componentsDir, component), '');
  }
  for (const script of [
    'browser-check-utils.mjs',
    'check-packaged-vault-lock-native.mjs',
    'check-packaged-wrong-password-browser.mjs',
  ]) {
    fs.writeFileSync(path.join(fixtureScriptsDir, script), '');
  }

  return { root, fixtureScriptsDir };
}

describe('browser-check unlock guard', () => {
  it('rejects statically assembled onboarding selectors while allowing the dedicated first-run journey', () => {
    const { root, fixtureScriptsDir } = makeUnlockGuardFixture();
    try {
      fs.writeFileSync(
        path.join(fixtureScriptsDir, 'check-generic-browser.mjs'),
        [
          'page.getByTestId(`network-onboarding-source`);',
          "page.getByTestId('button-' + \"onboarding-\" + `finish`);",
          "const choice = 'choice-network-';",
          "page.getByTestId(`${choice}offline`);",
          "const parts = ['button', 'save', 'network', 'choice'];",
          "page.getByTestId(parts.join('-'));",
          "const selectors = { source: ['network', 'onboarding', 'source'].join('-') };",
          "page.getByTestId(selectors.source);",
          "const { source } = selectors;",
          "page.getByTestId(source);",
          "const renamedSelectors = { finishButton: ['button', 'onboarding', 'finish'].join('-') };",
          "const { finishButton: finishAlias } = renamedSelectors;",
          "page.getByTestId(finishAlias);",
          "function onboardingChoice(kind) { return `choice-network-${kind}`; }",
          "page.getByTestId(onboardingChoice('public-direct'));",
          "function onboardingSource() { const suffix = ['onboarding', 'source'].join('-'); const selector = `network-${suffix}`; return selector; }",
          "page.getByTestId(onboardingSource());",
           "const onboardingImport = () => { const suffix = ['onboarding', 'import'].join('-'); return `network-${suffix}`; };",
           "page.getByTestId(onboardingImport());",
           "const onboardingFinish = function () { const prefix = ['button', 'onboarding'].join('-'); return `${prefix}-finish`; };",
           "page.getByTestId(onboardingFinish());",
           "const buildAliasedChoice = (kind) => `choice-network-${kind}`;",
           "const aliasedChoice = buildAliasedChoice;",
           "page.getByTestId(aliasedChoice('offline'));",
          "function dynamicChoice() { let suffix = 'network-'; return 'choice-' + suffix + runtimeChoice(); }",
          "page.getByTestId(dynamicChoice());",
          "function statefulFinish() { const selector = ['button', 'onboarding'].join('-'); recordSelector(selector); return selector + '-finish'; }",
          "page.getByTestId(statefulFinish());",
           "const mutableOfflineChoice = () => { let suffix = 'network-'; return 'choice-' + suffix + runtimeChoice(); };",
           "page.getByTestId(mutableOfflineChoice());",
           "const sideEffectingSource = function () { const selector = ['network', 'onboarding'].join('-'); recordSelector(selector); return selector + '-source'; };",
           "page.getByTestId(sideEffectingSource());",
           "let reassignedChoiceAlias = buildAliasedChoice;",
           "reassignedChoiceAlias = runtimeChoiceBuilder();",
           "page.getByTestId(reassignedChoiceAlias('offline'));",
           "const sideEffectingChoiceAlias = (recordSelectorUse(), buildAliasedChoice);",
           "page.getByTestId(sideEffectingChoiceAlias('offline'));",
           "const helperBag = { buildChoice: (kind) => `choice-network-${kind}` };",
           "const { buildChoice: destructuredChoiceAlias } = helperBag;",
           "page.getByTestId(destructuredChoiceAlias('offline'));",
           "const computedHelperName = runtimeHelperName();",
           "const { [computedHelperName]: computedChoiceAlias } = helperBag;",
           "page.getByTestId(computedChoiceAlias('offline'));",
           "let { buildChoice: mutableChoiceAlias } = helperBag;",
           "page.getByTestId(mutableChoiceAlias('offline'));",
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(fixtureScriptsDir, 'check-first-run-network-privacy-browser.mjs'),
        [
          'page.getByTestId(`button-onboarding-finish`);',
          "page.getByTestId('network-' + 'onboarding-source');",
          "const choice = 'choice-network-';",
          "page.getByTestId(`${choice}offline`);",
          "const selectors = { source: 'network-' + 'onboarding-source' };",
          "page.getByTestId(selectors.source);",
          "const { source: onboardingSource } = selectors;",
          "page.getByTestId(onboardingSource);",
          "const finish = () => ['button', 'onboarding', 'finish'].join('-');",
          "page.getByTestId(finish());",
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(fixtureScriptsDir, 'check-packaged-vault-lock-native.mjs'),
        [
          "const selectors = { password: ['input', 'password'].join('-') };",
          "page.getByTestId(selectors.password);",
          "const { password: passwordSelector } = selectors;",
          "page.getByTestId(passwordSelector);",
          "function migrationSelector() { return 'legacy-' + 'migration-overlay'; }",
          "page.getByTestId(migrationSelector());",
          '',
        ].join('\n'),
      );

      const result = spawnSync(process.execPath, [unlockGuardPath], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          BROWSER_CHECK_UNLOCK_GUARD_SCRIPTS_DIR: fixtureScriptsDir,
        },
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /check-generic-browser\.mjs:1\s+\[network-onboarding-source\]/);
      assert.match(result.stderr, /check-generic-browser\.mjs:2\s+\[button-onboarding-finish\]/);
      assert.match(result.stderr, /check-generic-browser\.mjs:4\s+\[choice-network-offline\]/);
      assert.match(result.stderr, /check-generic-browser\.mjs:6\s+\[button-save-network-choice\]/);
      assert.match(result.stderr, /check-generic-browser\.mjs:8\s+\[network-onboarding-source\]/);
      assert.match(result.stderr, /check-generic-browser\.mjs:10\s+\[network-onboarding-source\]/);
      assert.match(result.stderr, /check-generic-browser\.mjs:13\s+\[button-onboarding-finish\]/);
      assert.match(result.stderr, /check-generic-browser\.mjs:15\s+\[choice-network-public-direct\]/);
      assert.match(result.stderr, /check-generic-browser\.mjs:17\s+\[network-onboarding-source\]/);
       assert.match(result.stderr, /check-generic-browser\.mjs:19\s+\[network-onboarding-import\]/);
       assert.match(result.stderr, /check-generic-browser\.mjs:21\s+\[button-onboarding-finish\]/);
       assert.match(result.stderr, /check-generic-browser\.mjs:24\s+\[choice-network-offline\]/);
       assert.doesNotMatch(result.stderr, /check-generic-browser\.mjs:26\s+/);
       assert.doesNotMatch(result.stderr, /check-generic-browser\.mjs:28\s+/);
       assert.doesNotMatch(result.stderr, /check-generic-browser\.mjs:30\s+/);
       assert.doesNotMatch(result.stderr, /check-generic-browser\.mjs:32\s+/);
       assert.doesNotMatch(result.stderr, /check-generic-browser\.mjs:35\s+/);
       assert.doesNotMatch(result.stderr, /check-generic-browser\.mjs:37\s+/);
        assert.match(result.stderr, /check-generic-browser\.mjs:40\s+\[choice-network-offline\]/);
        assert.doesNotMatch(result.stderr, /check-generic-browser\.mjs:43\s+/);
        assert.doesNotMatch(result.stderr, /check-generic-browser\.mjs:45\s+/);
      assert.doesNotMatch(result.stderr, /check-first-run-network-privacy-browser\.mjs:/);
      assert.doesNotMatch(result.stderr, /check-packaged-vault-lock-native\.mjs:/);
      assert.match(result.stderr, /completeFreshVaultOnboardingIfPresent/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function timeoutError(message = 'locator timed out') {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function makePage({
  setup = false,
  alreadyUnlocked = false,
  overlay = false,
  overlayVisible = false,
  overlayError,
  onboarding = false,
} = {}) {
  const calls = [];
  const password = {
    waitFor: async (options) => {
      calls.push(['password.waitFor', options]);
      if (options.state === 'visible' && alreadyUnlocked) {
        throw timeoutError('password did not appear');
      }
    },
    fill: async (value) => calls.push(['password.fill', value]),
  };
  const confirm = {
    isVisible: async () => {
      calls.push(['confirm.isVisible']);
      return setup;
    },
    fill: async (value) => calls.push(['confirm.fill', value]),
  };
  const submit = {
    click: async () => calls.push(['submit.click']),
  };
  const migration = {
    waitFor: async () => {
      calls.push(['migration.waitFor']);
      if (!overlay) throw timeoutError('migration overlay did not appear');
    },
    isVisible: async () => {
      if (overlayError) throw overlayError;
      return overlayVisible;
    },
  };
  const dismiss = {
    isVisible: async () => false,
    click: async () => calls.push(['dismiss.click']),
  };
  const onboardingSource = {
    waitFor: async (options) => {
      calls.push(['onboardingSource.waitFor', options]);
      if (options.state === 'visible' && !onboarding) {
        throw timeoutError('fresh-vault onboarding did not appear');
      }
    },
  };
  const offlineChoice = {
    click: async () => calls.push(['offlineChoice.click']),
  };
  const onboardingImport = {
    waitFor: async (options) => calls.push(['onboardingImport.waitFor', options]),
  };
  const finishOnboarding = {
    click: async () => calls.push(['finishOnboarding.click']),
  };

  return {
    calls,
    getByTestId(testId) {
      return {
        'input-password': password,
        'input-confirm-password': confirm,
        'button-submit': submit,
        'legacy-migration-overlay': migration,
        'button-dismiss-migration': dismiss,
        'network-onboarding-source': onboardingSource,
        'choice-network-offline': offlineChoice,
        'network-onboarding-import': onboardingImport,
        'button-onboarding-finish': finishOnboarding,
      }[testId];
    },
    waitForTimeout: async () => calls.push(['waitForTimeout']),
  };
}

describe('browser-check unlock helper', () => {
  it('completes fresh-vault onboarding when it appears', async () => {
    const page = makePage({ onboarding: true });

    assert.equal(
      await completeFreshVaultOnboardingIfPresent(page, { label: 'fresh-vault-check' }),
      true,
    );
    assert.deepEqual(
      page.calls.map(([name]) => name),
      [
        'onboardingSource.waitFor',
        'offlineChoice.click',
        'onboardingImport.waitFor',
        'finishOnboarding.click',
        'onboardingSource.waitFor',
      ],
    );
    assert.equal(page.calls.at(-1)[1].state, 'detached');
  });

  it('leaves a fresh-vault check alone when onboarding does not appear', async () => {
    const page = makePage();

    assert.equal(await completeFreshVaultOnboardingIfPresent(page), false);
    assert.deepEqual(page.calls.map(([name]) => name), ['onboardingSource.waitFor']);
  });

  it('sets up a new vault through the confirmation form', async () => {
    const page = makePage({ setup: true });

    assert.equal(
      await unlockIfNeeded(page, 'setup-password', {
        label: 'setup-check',
        dismissMigration: false,
      }),
      true,
    );
    assert.deepEqual(
      page.calls.map(([name]) => name),
      [
        'password.waitFor',
        'confirm.isVisible',
        'password.fill',
        'confirm.fill',
        'submit.click',
        'password.waitFor',
      ],
    );
    assert.equal(page.calls[0][1].state, 'visible');
  });

  it('unlocks an existing vault without filling a confirmation field', async () => {
    const page = makePage();

    assert.equal(
      await unlockIfNeeded(page, 'unlock-password', {
        label: 'unlock-check',
        dismissMigration: false,
      }),
      true,
    );
    assert.deepEqual(
      page.calls.map(([name]) => name),
      ['password.waitFor', 'confirm.isVisible', 'password.fill', 'submit.click', 'password.waitFor'],
    );
  });

  it('recognizes an existing-vault login screen without a confirmation field', async () => {
    const page = makePage();

    assert.equal(await waitForExistingVaultLoginScreen(page, { timeoutMs: 1234 }), true);
    assert.deepEqual(
      page.calls.map(([name]) => name),
      ['password.waitFor', 'confirm.isVisible'],
    );
    assert.equal(page.calls[0][1].timeout, 1234);
  });

  it('rejects a setup screen when checking for an existing vault', async () => {
    const page = makePage({ setup: true });

    await assert.rejects(
      waitForExistingVaultLoginScreen(page),
      /still shows the setup confirmation field/,
    );
  });

  it('reports a labelled setup failure with the setup phase', async () => {
    const setupError = new Error('confirmation field detached');
    const page = makePage({ setup: true });
    page.getByTestId('input-confirm-password').fill = async () => {
      throw setupError;
    };

    await assert.rejects(
      unlockIfNeeded(page, 'setup-password', {
        label: 'setup-failure-check',
        dismissMigration: false,
      }),
      (error) => {
        assert.equal(
          error.message,
          '[setup-failure-check] browser check failed during vault setup confirmation entry: confirmation field detached',
        );
        assert.equal(error.cause, setupError);
        return true;
      },
    );
  });

  it('reports a labelled ordinary unlock failure with the unlock phase', async () => {
    const page = makePage();
    page.getByTestId('input-password').waitFor = async (options) => {
      page.calls.push(['password.waitFor', options]);
      if (options.state === 'detached') {
        throw timeoutError('login form stayed visible');
      }
    };

    await assert.rejects(
      unlockIfNeeded(page, 'unlock-password', {
        label: 'unlock-failure-check',
        dismissMigration: false,
      }),
      (error) => {
        assert.match(
          error.message,
          /^\[unlock-failure-check\] browser check failed during vault unlock completion:/,
        );
        assert.match(error.message, /login form stayed visible/);
        return true;
      },
    );
  });

  it('does not fail when the vault is already unlocked', async () => {
    const page = makePage({ alreadyUnlocked: true });

    assert.equal(await unlockIfNeeded(page, 'unused-password', { label: 'already-open-check' }), false);
    assert.deepEqual(
      page.calls.map(([name]) => name),
      ['password.waitFor', 'migration.waitFor'],
    );
  });

  it('reports a labelled migration-cleanup timeout with its failed phase', async () => {
    const page = makePage({ overlay: true, overlayVisible: true });

    await assert.rejects(
      dismissMigrationOverlayIfPresent(page, { label: 'migration-timeout-check', timeoutMs: 0 }),
      (error) => {
        assert.match(error.message, /^\[migration-timeout-check\] browser check failed during migration cleanup:/);
        assert.match(error.message, /did not clear within the timeout/);
        return true;
      },
    );
  });

  it('reports a labelled migration-cleanup page error instead of treating it as hidden', async () => {
    const pageError = new Error('browser context closed');
    const page = makePage({ overlay: true, overlayVisible: true, overlayError: pageError });

    await assert.rejects(
      dismissMigrationOverlayIfPresent(page, { label: 'migration-error-check', timeoutMs: 1_000 }),
      (error) => {
        assert.equal(
          error.message,
          '[migration-error-check] browser check failed during migration cleanup: browser context closed',
        );
        assert.equal(error.cause, pageError);
        return true;
      },
    );
  });
});