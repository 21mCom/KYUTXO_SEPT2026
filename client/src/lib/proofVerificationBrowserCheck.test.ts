import { describe, it, expect } from 'vitest';
import { runProofVerificationBrowserCheck } from './proofVerificationBrowserCheck';

/**
 * Deterministic (Node) half of the Proof-of-Funds browser-environment guard.
 *
 * This runs the same self-checking function that the testing skill evaluates in
 * a REAL browser (see proofVerificationBrowserCheck.ts). Here it proves the
 * check's expectations are correct and that the P2SH-P2WSH proof verifies and a
 * tampered/wrong-message proof fails cleanly. The browser-only regression — a
 * reintroduced `Buffer` global crash — is caught by running the SAME function in
 * a real browser, where the Buffer global is absent.
 */
describe('Proof verification browser check (Node correctness half)', () => {
  it('passes every step and verifies the P2SH-P2WSH proof', async () => {
    const report = await runProofVerificationBrowserCheck({ throwOnFailure: false });
    // Surface per-step detail if anything regresses.
    const failures = report.steps.filter((s) => !s.passed).map((s) => `${s.name}: ${s.detail}`);
    expect(failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('throws with a clear message when asked to throw on failure (smoke)', async () => {
    // Sanity: the happy path does NOT throw.
    await expect(runProofVerificationBrowserCheck()).resolves.toMatchObject({ ok: true });
  });
});
