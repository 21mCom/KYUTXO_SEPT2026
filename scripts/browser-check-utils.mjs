// Shared unlock-flow helpers for scripts/check-*-browser*.mjs (and any other
// real-Chromium check script that drives KYUTXO's lock screen).
//
// WHY: every check script used to hand-roll its own copy of "fill the
// password field(s), click submit, wait for the login screen to go away."
// The underlying data-testid values (input-password, input-confirm-password,
// button-submit) live in client/src/components/LoginScreen.tsx, and the
// migration-overlay testids (legacy-migration-overlay, button-dismiss-migration)
// live in client/src/components/LegacyMigrationOverlay.tsx. If either
// component ever renames one of them, every inline copy breaks silently — the
// affected check just times out waiting for a selector that no longer
// exists, with no hint that the real cause is a testid rename.
//
// Centralizing the logic here means a rename only needs a fix in ONE place.
// scripts/check-browser-check-unlock-guard.js fails the build if a
// check-*.mjs script hardcodes these testids instead of importing from here.
//
// Usage (top of a check script):
//   import { unlockIfNeeded } from './browser-check-utils.mjs';
//   await unlockIfNeeded(page, SETUP_PASSWORD);

export const DEFAULT_APPEAR_TIMEOUT_MS = 15_000;
export const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;

function isTimeoutError(error) {
  return (
    error?.name === 'TimeoutError' ||
    /timed?\s*out|timeout/i.test(error instanceof Error ? error.message : String(error))
  );
}

function phaseError(label, phase, error) {
  if (!label) return error;

  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`[${label}] browser check failed during ${phase}: ${detail}`, { cause: error });
}

async function runPhase(label, phase, operation) {
  try {
    return await operation();
  } catch (error) {
    throw phaseError(label, phase, error);
  }
}

/**
 * Waits out (and dismisses) the legacy-migration overlay if it appears.
 * Safe to call unconditionally — resolves quickly when the overlay never
 * shows up at all.
 */
export async function dismissMigrationOverlayIfPresent(page, { label, timeoutMs = 60_000 } = {}) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch((error) => {
      // A timeout means the overlay never appeared, which is the normal path.
      // Other errors (closed page, broken locator, etc.) are real check
      // failures and must not be mistaken for an already-clean migration.
      if (isTimeoutError(error)) return false;
      throw phaseError(label, 'migration overlay detection', error);
    });
  if (!appeared) return false;

  if (label) {
    console.log(`[${label}] legacy-migration overlay detected; waiting it out ...`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await runPhase(label, 'migration cleanup', () => overlay.isVisible());
    if (!visible) return true;
    const dismiss = page.getByTestId('button-dismiss-migration');
    const dismissVisible = await runPhase(label, 'migration cleanup', () => dismiss.isVisible());
    if (dismissVisible) {
      await runPhase(label, 'migration cleanup', () => dismiss.click());
    }
    await runPhase(label, 'migration cleanup', () => page.waitForTimeout(500));
  }
  throw phaseError(label, 'migration cleanup', new Error('legacy-migration overlay did not clear within the timeout'));
}

/**
 * Waits for the LoginScreen's password field to become visible, without
 * filling anything in. Use this when a check only needs proof that the app
 * booted to the lock screen (e.g. a page-load retry loop), not an actual
 * unlock.
 */
export async function waitForLoginScreenVisible(page, { timeoutMs = DEFAULT_APPEAR_TIMEOUT_MS } = {}) {
  return page.getByTestId('input-password').waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * Waits for an existing vault's lock screen. Unlike a fresh-vault check, an
 * existing vault must not render the password confirmation field.
 */
export async function waitForExistingVaultLoginScreen(
  page,
  { timeoutMs = DEFAULT_APPEAR_TIMEOUT_MS } = {},
) {
  await waitForLoginScreenVisible(page, { timeoutMs });
  const setupConfirmation = page.getByTestId('input-confirm-password');
  if (await setupConfirmation.isVisible()) {
    throw new Error('existing vault login screen still shows the setup confirmation field');
  }
  return true;
}

/**
 * Instant (non-waiting) check for whether the LoginScreen's password field is
 * currently visible. Use this inside a polling loop that needs to distinguish
 * "already unlocked" from "showing the lock screen right now" on every tick —
 * `waitForLoginScreenVisible` is the wrong tool there because Playwright's
 * `waitFor` needs a real timeout budget to resolve (even a 1ms timeout
 * effectively always fails, even when the element is already visible), so it
 * cannot be used as a zero-wait poll. Never throws.
 */
export async function isLoginScreenVisible(page) {
  return page.getByTestId('input-password').isVisible().catch(() => false);
}

/**
 * Fills and submits the LoginScreen form if it is showing — covers both
 * vault setup (confirm-password field present) and unlock (field absent) —
 * then waits for the form to disappear. Returns `false` without doing
 * anything if the form never appears (vault already unlocked).
 *
 * Options:
 *   - appearTimeoutMs: how long to wait for the password field to show up.
 *   - submitTimeoutMs: how long to wait for the form to detach after submit.
 *   - dismissMigration: whether to also wait out a legacy-migration overlay
 *     that may appear right after unlock (default true).
 *   - label: optional log-line prefix, forwarded to dismissMigrationOverlayIfPresent.
 */
export async function unlockIfNeeded(page, password, options = {}) {
  const {
    appearTimeoutMs = DEFAULT_APPEAR_TIMEOUT_MS,
    submitTimeoutMs = DEFAULT_SUBMIT_TIMEOUT_MS,
    dismissMigration = true,
    label,
  } = options;

  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: appearTimeoutMs })
    .then(() => true)
    .catch((error) => {
      // A missing login form is expected when the vault is already unlocked.
      // Only Playwright's timeout represents that state; preserve all other
      // failures so browser checks identify a broken page instead.
      if (isTimeoutError(error)) return false;
      throw phaseError(label, 'login screen detection', error);
    });

  if (!appeared) {
    if (dismissMigration) await dismissMigrationOverlayIfPresent(page, { label });
    return false;
  }

  const confirmInput = page.getByTestId('input-confirm-password');
  const isSetup = await runPhase(label, 'login form detection', () => confirmInput.isVisible());
  const unlockPhase = isSetup ? 'vault setup' : 'vault unlock';

  await runPhase(label, `${unlockPhase} password entry`, () => pwInput.fill(password));
  if (isSetup) {
    await runPhase(label, 'vault setup confirmation entry', () => confirmInput.fill(password));
  }
  await runPhase(label, `${unlockPhase} submission`, () => page.getByTestId('button-submit').click());
  await runPhase(label, `${unlockPhase} completion`, () =>
    pwInput.waitFor({ state: 'detached', timeout: submitTimeoutMs }),
  );

  if (dismissMigration) await dismissMigrationOverlayIfPresent(page, { label });
  return true;
}
