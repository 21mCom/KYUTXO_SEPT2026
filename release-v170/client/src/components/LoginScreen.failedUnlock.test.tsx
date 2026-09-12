// @vitest-environment jsdom
//
// Task #1820 — wrong-password unlock must visibly show "Incorrect password".
//
// Regression: AuthContext.login() toggles the global isLoading flag while the
// password hash is verified. AppContent used to swap LoginScreen for the
// "Loading vault..." spinner whenever isLoading was true, unmounting
// LoginScreen mid-attempt and wiping its local error state — so a rejected
// password remounted a fresh LoginScreen with no feedback at all (seen in the
// packaged app, reproducible in dev). These tests render the REAL App
// component with a controllable auth store whose login() flips isLoading
// (with a real async gap, forcing React to commit in between) before
// resolving false, and assert the error text still renders.

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

type AuthPatch = Partial<{
  isInitialized: boolean | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}>;

const authStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    isInitialized: true as boolean | null,
    isAuthenticated: false,
    isLoading: false,
    isMigrating: false,
    dbUpgrade: null as unknown,
    migrationPhase: null as string | null,
    legacyMigrationProgress: null as unknown,
    legacyMigrationResult: null as unknown,
    fileDecryptProgress: null as unknown,
  };
  let version = 0;
  return {
    state,
    // login behavior is swapped per test
    loginImpl: (async (_password: string) => false) as (p: string) => Promise<boolean>,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getVersion() {
      return version;
    },
    set(patch: AuthPatch) {
      Object.assign(state, patch);
      version += 1;
      listeners.forEach((l) => l());
    },
    reset() {
      Object.assign(state, {
        isInitialized: true,
        isAuthenticated: false,
        isLoading: false,
        isMigrating: false,
        dbUpgrade: null,
        migrationPhase: null,
        legacyMigrationProgress: null,
        legacyMigrationResult: null,
        fileDecryptProgress: null,
      });
      version += 1;
      listeners.forEach((l) => l());
    },
  };
});

vi.mock('@/contexts/AuthContext', async () => {
  const React = await import('react');
  const useAuth = () => {
    React.useSyncExternalStore(authStore.subscribe, authStore.getVersion, authStore.getVersion);
    return {
      ...authStore.state,
      setupPassword: async () => {},
      login: (password: string) => authStore.loginImpl(password),
      logout: () => {},
    };
  };
  const AuthProvider = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return { AuthProvider, useAuth };
});

import App from '@/App';

// Wrong-password login mirroring the real AuthContext contract: isLoading goes
// true, an async verification gap lets React commit, then isLoading returns to
// false and login resolves false.
function installFailingLogin() {
  authStore.loginImpl = async () => {
    authStore.set({ isLoading: true });
    await new Promise((r) => setTimeout(r, 25));
    authStore.set({ isLoading: false });
    return false;
  };
}

describe('failed unlock shows the Incorrect password error (Task #1820)', () => {
  beforeEach(() => {
    authStore.reset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders "Incorrect password" after login() resolves false, despite the isLoading toggle', async () => {
    installFailingLogin();
    render(<App />);

    const input = await screen.findByTestId('input-password');
    fireEvent.change(input, { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByTestId('button-submit'));

    // Mid-attempt: the login form must STAY MOUNTED (it shows its own
    // "Please wait..." state) — unmounting is exactly what wiped the error.
    await waitFor(() => {
      expect(authStore.state.isLoading).toBe(true);
    });
    expect(screen.getByTestId('input-password')).toBeTruthy();

    const error = await screen.findByTestId('text-error');
    expect(error.textContent).toBe('Incorrect password');
    // Still on the login screen, vault still locked.
    expect(screen.getByTestId('input-password')).toBeTruthy();
  });

  it('renders the failure message when login() throws', async () => {
    authStore.loginImpl = async () => {
      authStore.set({ isLoading: true });
      await new Promise((r) => setTimeout(r, 10));
      authStore.set({ isLoading: false });
      throw new Error('verification exploded');
    };
    render(<App />);

    const input = await screen.findByTestId('input-password');
    fireEvent.change(input, { target: { value: 'whatever' } });
    fireEvent.click(screen.getByTestId('button-submit'));

    const error = await screen.findByTestId('text-error');
    expect(error.textContent).toBe('Login failed. Please try again.');
  });

  it('states on both setup and unlock screens that the app lock does not encrypt disk data', async () => {
    const unlockView = render(<App />);
    await screen.findByTestId('input-password');
    expect(document.body.textContent).toContain(
      'Your password locks access to the app; it does not encrypt vault data stored on disk.',
    );
    expect(document.body.textContent).toContain(
      'For at-rest protection, keep the vault on an encrypted disk or container.',
    );

    unlockView.unmount();
    authStore.set({ isInitialized: false });
    render(<App />);
    await screen.findByTestId('input-confirm-password');
    expect(document.body.textContent).toContain(
      'Your password locks access to the app; it does not encrypt vault data stored on disk.',
    );
    expect(document.body.textContent).toContain(
      'For at-rest protection, keep the vault on an encrypted disk or container.',
    );
  });
});
