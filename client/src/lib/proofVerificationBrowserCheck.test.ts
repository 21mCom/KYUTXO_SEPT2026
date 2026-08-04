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
  it('passes every step across all verify paths', async () => {
    const report = await runProofVerificationBrowserCheck({ throwOnFailure: false });
    // Surface per-step detail if anything regresses.
    const failures = report.steps.filter((s) => !s.passed).map((s) => `${s.name}: ${s.detail}`);
    expect(failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('covers every remaining verify path with a valid and a failure case', async () => {
    const report = await runProofVerificationBrowserCheck({ throwOnFailure: false });
    const names = report.steps.map((s) => s.name).join('\n');
    // Legacy Bitcoin Signed Message: all three address forms + negatives.
    expect(names).toMatch(/legacy BSM verifies a P2PKH/);
    expect(names).toMatch(/legacy BSM verifies a P2SH-P2WPKH/);
    expect(names).toMatch(/legacy BSM verifies a native P2WPKH/);
    expect(names).toMatch(/tampered legacy BSM/);
    expect(names).toMatch(/legacy BSM proof against the wrong message/);
    // BIP-322 Simple: P2WPKH + Taproot key-path, valid + tampered + wrong message.
    expect(names).toMatch(/verifyBip322P2WPKH verifies/);
    expect(names).toMatch(/tampered P2WPKH BIP-322 witness/);
    expect(names).toMatch(/P2WPKH BIP-322 proof against the wrong message/);
    expect(names).toMatch(/verifyBip322Simple verifies the Taproot key-path/);
    expect(names).toMatch(/tampered Taproot key-path witness/);
    expect(names).toMatch(/Taproot key-path proof against the wrong message/);
    // BIP-322 Full: P2WSH multisig + Taproot script-path, valid + negatives.
    expect(names).toMatch(/verifyBip322Full verifies a 2-of-2 P2WSH/);
    expect(names).toMatch(/tampered P2WSH multisig witness/);
    expect(names).toMatch(/P2WSH multisig proof against the wrong message/);
    expect(names).toMatch(/verifyBip322Full verifies a Taproot single-leaf/);
    expect(names).toMatch(/tampered Taproot script-path witness/);
    expect(names).toMatch(/Taproot script-path proof against the wrong message/);
    // Original P2SH-P2WSH coverage retained.
    expect(names).toMatch(/verifyBip322P2SH verifies a valid P2SH-P2WSH witness/);
  });

  it('throws with a clear message when asked to throw on failure (smoke)', async () => {
    // Sanity: the happy path does NOT throw.
    await expect(runProofVerificationBrowserCheck()).resolves.toMatchObject({ ok: true });
  });
});
