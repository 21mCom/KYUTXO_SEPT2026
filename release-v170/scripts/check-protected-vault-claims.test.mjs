import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProtectedVaultClaims } from './check-protected-vault-claims.mjs';

const base = {
  design: 'Status and decision: This is not an implementation. The current application still uses plaintext IndexedDB.',
  project: 'The current primary data and attachments are stored as plaintext.',
  threatModel: 'Stored as plaintext. The design is not implemented.',
  uiSources: 'The password locks access to the app; it does not encrypt vault data stored on disk.',
};

test('passes only while the plaintext warning and unimplemented status remain', () => {
  assert.ok(checkProtectedVaultClaims(base).every(({ passed }) => passed));
});

test('fails if documentation removes the warning without a protected implementation gate', () => {
  const results = checkProtectedVaultClaims({
    ...base,
    project: 'The vault is protected at rest.',
    uiSources: 'Your vault data is encrypted on disk.',
  });
  assert.ok(results.some(({ passed }) => !passed));
});

test('passes against the actual repository claim-bearing sources', () => {
  assert.ok(checkProtectedVaultClaims().every(({ passed }) => passed));
});

test('rejects alternate user-facing protection claims outside the login screen', () => {
  for (const claim of [
    'Your vault data is encrypted on disk.',
    'Built-in at-rest protection is enabled.',
    'This password encrypts the vault.',
  ]) {
    const results = checkProtectedVaultClaims({ ...base, uiSources: claim });
    assert.ok(
      results.some(({ name, passed }) =>
        name.includes('user-facing') && !passed,
      ),
      claim,
    );
  }
});

test('fails if the design no longer states that protection is unimplemented', () => {
  const results = checkProtectedVaultClaims({
    ...base,
    design: 'Status and decision: built-in protected storage is enabled.',
  });
  assert.ok(results.some(({ passed }) => !passed));
});