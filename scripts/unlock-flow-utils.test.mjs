import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  completeFreshVaultOnboardingIfPresent,
  dismissMigrationOverlayIfPresent,
  unlockIfNeeded,
  waitForExistingVaultLoginScreen,
} from './browser-check-utils.mjs';

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
  const networkChoice = {
    click: async () => calls.push(['networkChoice.click']),
  };
  const saveNetworkChoice = {
    click: async () => calls.push(['saveNetworkChoice.click']),
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
        'choice-network-public-direct': networkChoice,
        'button-save-network-choice': saveNetworkChoice,
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
        'networkChoice.click',
        'saveNetworkChoice.click',
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