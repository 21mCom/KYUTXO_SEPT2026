/**
 * Browser-environment regression guard for Proof-of-Funds signature verification.
 *
 * Why this exists
 * ---------------
 * The P2SH-P2WSH (legacy "3…" wrapped multisig) BIP-322 proof path was confirmed
 * working in a real browser by hand, but unit tests run in Node, where the
 * `Buffer` global always exists. A reintroduced `Buffer.from`/`Buffer.alloc`/
 * `Buffer.concat` (or any Web Crypto seam change) anywhere in the verify path
 * therefore passes CI yet crashes real users in the browser with
 * "Buffer is not defined". The static `scripts/check-no-buffer-global.js` guard
 * scans source text, but cannot prove the live, bundled verify path actually
 * runs without the Buffer global.
 *
 * This module exposes a single self-checking function that exercises the REAL
 * `verifyBitcoinSignature` -> `verifyBip322P2SH` path against a pre-generated
 * P2SH-P2WSH witness. It is designed to be run in two places:
 *
 *   1. A Node vitest (`proofVerificationBrowserCheck.test.ts`) — deterministic
 *      CI coverage that the valid witness verifies and a tampered one fails.
 *   2. A REAL browser, via the testing skill, by evaluating in the page:
 *
 *        await (await import('/src/lib/proofVerificationBrowserCheck.ts'))
 *          .runProofVerificationBrowserCheck()
 *
 *      In the browser the `Buffer` global is absent and dependencies use their
 *      browser builds, so any code that reaches for the Buffer global throws and
 *      this check fails — catching the regression before it ships.
 *
 * The helper itself is written to be browser-safe (Uint8Array + atob/btoa only,
 * never the Buffer global), so the guard does not introduce the very bug it
 * guards against.
 */

import { verifyBip322P2SH, verifyBitcoinSignature } from './signatureVerify';

/**
 * Deterministic 2-of-2 P2SH-P2WSH (wrapped multisig) BIP-322 Full witness,
 * shared with signatureVerify.test.ts. Valid for the message below.
 */
const P2SH_P2WSH_2OF2_ADDR = '3GKSstjZTsY2XfdxbzDtWTJJEw4B4918PY';
const P2SH_P2WSH_2OF2_SIG =
  'BABIMEUCIQCadTCxF4nxWc3SUPxswQANiHXbElgvkdWBCwUxGf3xfgIgBA9b/XFCIH2+rqWUXv53UolAR2rxfAHc0IdUHma8meoBSDBFAiEA8GtfmPQfcFLZRRHzPHISGVvrzeCGtM2yHpoAcl7TlHMCIBId6VTsTZ+cElN8SdhCiNa+iIX8diqxLMEEeX6Ih/KeAUdSIQNPNVvct8wK9yjvPM65YV2QaEu1sspfhZqw8LcEB1hxqiECRm1/yuVj5csJoNGHC7WANEgEYXh5oUlJzyIoXxuuPydSrg==';
const MESSAGE = 'Hello World';

/**
 * Decode a base64 witness, flip one byte deep inside it, and re-encode it.
 * The result is still structurally a witness (so it travels the full verify
 * path) but is cryptographically invalid, exercising the "clear failure"
 * outcome. Uses only browser-safe primitives — never the Buffer global.
 */
function tamperWitness(base64: string): string {
  const binary = atob(base64.trim());
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const idx = Math.floor(bytes.length / 2);
  bytes[idx] = bytes[idx] ^ 0xff;
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

export interface BrowserCheckStep {
  name: string;
  passed: boolean;
  detail: string;
}

export interface BrowserCheckReport {
  ok: boolean;
  /** True when the Node `Buffer` global is present (i.e. running under Node, not a real browser). */
  bufferGlobalPresent: boolean;
  steps: BrowserCheckStep[];
}

/**
 * Run the Proof-of-Funds browser-environment regression check.
 *
 * Returns a structured report and, by default, throws if any step fails so the
 * caller (vitest or a runTest snippet) surfaces a hard failure. Pass
 * `{ throwOnFailure: false }` to inspect the report without throwing.
 */
export async function runProofVerificationBrowserCheck(
  opts: { throwOnFailure?: boolean } = {},
): Promise<BrowserCheckReport> {
  const { throwOnFailure = true } = opts;
  const steps: BrowserCheckStep[] = [];
  const bufferGlobalPresent =
    typeof (globalThis as { Buffer?: unknown }).Buffer !== 'undefined';

  // Step 1: a valid P2SH-P2WSH witness verifies via the dedicated verifier.
  try {
    const r = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, MESSAGE, P2SH_P2WSH_2OF2_SIG);
    const passed = r.verified === true && r.format === 'bip322';
    steps.push({
      name: 'verifyBip322P2SH verifies a valid P2SH-P2WSH witness',
      passed,
      detail: passed
        ? "verified=true, format='bip322'"
        : `expected verified=true/format='bip322', got verified=${r.verified}, format=${String(r.format)}, error=${String(r.error)}`,
    });
  } catch (e) {
    steps.push({
      name: 'verifyBip322P2SH verifies a valid P2SH-P2WSH witness',
      passed: false,
      detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Step 2: the same proof verifies through the public routing entry point.
  try {
    const r = await verifyBitcoinSignature(P2SH_P2WSH_2OF2_ADDR, MESSAGE, P2SH_P2WSH_2OF2_SIG);
    const passed = r.verified === true && r.format === 'bip322';
    steps.push({
      name: 'verifyBitcoinSignature routes the P2SH-P2WSH proof and verifies it',
      passed,
      detail: passed
        ? "verified=true, format='bip322'"
        : `expected verified=true/format='bip322', got verified=${r.verified}, format=${String(r.format)}, error=${String(r.error)}`,
    });
  } catch (e) {
    steps.push({
      name: 'verifyBitcoinSignature routes the P2SH-P2WSH proof and verifies it',
      passed: false,
      detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Step 3: a tampered witness reports a clear failure (not a silent pass, not a crash).
  try {
    const tampered = tamperWitness(P2SH_P2WSH_2OF2_SIG);
    const r = await verifyBitcoinSignature(P2SH_P2WSH_2OF2_ADDR, MESSAGE, tampered);
    const passed = r.verified === false && typeof r.error === 'string' && r.error.length > 0;
    steps.push({
      name: 'a tampered witness reports a clear failure',
      passed,
      detail: passed
        ? `verified=false with error: ${r.error}`
        : `expected verified=false with an error, got verified=${r.verified}, error=${String(r.error)}`,
    });
  } catch (e) {
    steps.push({
      name: 'a tampered witness reports a clear failure',
      passed: false,
      detail: `threw instead of returning a failure result: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Step 4: a wrong message reports a clear failure (not a silent pass, not a crash).
  try {
    const r = await verifyBitcoinSignature(
      P2SH_P2WSH_2OF2_ADDR,
      'Goodbye World',
      P2SH_P2WSH_2OF2_SIG,
    );
    const passed = r.verified === false && typeof r.error === 'string' && r.error.length > 0;
    steps.push({
      name: 'a proof against the wrong message reports a clear failure',
      passed,
      detail: passed
        ? `verified=false with error: ${r.error}`
        : `expected verified=false with an error, got verified=${r.verified}, error=${String(r.error)}`,
    });
  } catch (e) {
    steps.push({
      name: 'a proof against the wrong message reports a clear failure',
      passed: false,
      detail: `threw instead of returning a failure result: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const ok = steps.every((s) => s.passed);
  const report: BrowserCheckReport = { ok, bufferGlobalPresent, steps };

  if (!ok && throwOnFailure) {
    const failures = steps
      .filter((s) => !s.passed)
      .map((s) => `  - ${s.name}: ${s.detail}`)
      .join('\n');
    throw new Error(
      `Proof verification browser check FAILED (bufferGlobalPresent=${bufferGlobalPresent}):\n${failures}`,
    );
  }

  return report;
}
