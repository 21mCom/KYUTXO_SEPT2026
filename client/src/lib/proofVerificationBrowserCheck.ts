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

import {
  verifyBip322Full,
  verifyBip322P2SH,
  verifyBip322P2WPKH,
  verifyBip322Simple,
  verifyBitcoinSignature,
} from './signatureVerify';

/**
 * Deterministic 2-of-2 P2SH-P2WSH (wrapped multisig) BIP-322 Full witness,
 * shared with signatureVerify.test.ts. Valid for the message below.
 */
const P2SH_P2WSH_2OF2_ADDR = '3GKSstjZTsY2XfdxbzDtWTJJEw4B4918PY';
const P2SH_P2WSH_2OF2_SIG =
  'BABIMEUCIQCadTCxF4nxWc3SUPxswQANiHXbElgvkdWBCwUxGf3xfgIgBA9b/XFCIH2+rqWUXv53UolAR2rxfAHc0IdUHma8meoBSDBFAiEA8GtfmPQfcFLZRRHzPHISGVvrzeCGtM2yHpoAcl7TlHMCIBId6VTsTZ+cElN8SdhCiNa+iIX8diqxLMEEeX6Ih/KeAUdSIQNPNVvct8wK9yjvPM65YV2QaEu1sspfhZqw8LcEB1hxqiECRm1/yuVj5csJoNGHC7WANEgEYXh5oUlJzyIoXxuuPydSrg==';
const MESSAGE = 'Hello World';

/**
 * Vectors for the remaining verify paths, shared verbatim with
 * signatureVerify.test.ts.
 */

// Legacy Bitcoin Signed Message (BIP-137): one compressed key, all three
// address forms (P2PKH "1…", P2SH-P2WPKH "3…", native P2WPKH "bc1q…").
const LEGACY_MSG = 'I certify that I control the following Bitcoin address.';
const LEGACY_SIG =
  'H72VK8HyRDe4nk1xkYqVSYYCsHnIW0vWAHwepHY9NbX8XDuRBu+d01+7LiWh5DAvvo0rm8Mt7mcby6BDsnYvAAw=';
const LEGACY_P2PKH_ADDR = '1EgNtna8ohPPfDu3AJKCg6tMuP9rqTnQnL';
const LEGACY_P2WPKH_ADDR = 'bc1qjcxzyzqj2u3mgrt0m8wzgcee0n4u3592ehm4gt';
const LEGACY_P2SH_P2WPKH_ADDR = '3Bn49vExQ5BGF7dMQ7A3PewhxzGAQEwzqy';

// BIP-322 Simple, Taproot key-path (Bitcoin Core's authoritative vector).
const P2TR_ADDR = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3';
const P2TR_SIG =
  'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==';

// BIP-322 Simple, native SegWit P2WPKH (canonical bip322-js reference key).
const P2WPKH_ADDR = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
const P2WPKH_SIG =
  'AkgwRQIhAOzyynlqt93lOKJr+wmmxIens//zPzl9tqIOua93wO6MAiBi5n5EyAcPScOjf1lAqIUIQtr3zKNeavYabHyR8eGhowEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy';

// BIP-322 Full, native P2WSH 2-of-2 multisig.
const P2WSH_2OF2_ADDR = 'bc1qfpchwlajc9pau0d07x70wrpnpaztq76kfax9nkd4wxa9dkp68dwsufky9g';
const P2WSH_2OF2_SIG =
  'BABHMEQCIBFFh2jDYGfAgcuZzo3HhHiRGn87fjZSI/z+W2uGEGEcAiBJpv32zgDb+7vZyxf6vnp8o7CkbRN2Jy4WpB1cu878xgFIMEUCIQDXRoPFQ7SzbYIVGWq7hANoceKbtdiiQZtmcRVWR4vqHQIgJH5LKbiKOVROPFv7t3sxxBiC3L5b0HzPxwk/81b7SXgBR1IhAtgntbsL3xs/6UNoiJwxgdLC6j0rnr1e7JlIeU5aHRb5IQJIHVIzTIoCDYEi8uGdY4IIsHtYX/Nf898lcYpzDga7y1Ku';

// BIP-322 Full, Taproot single-leaf script-path (<xA> OP_CHECKSIG).
const P2TR_LEAF_ADDR = 'bc1pcnljf6kcnlqvltg0fu08egg8s6hkesl4d33pss4vuydslpkam6kqxnvn7f';
const P2TR_LEAF_SIG =
  'A0A1mEkAVwneZScZ471WeokN/HeyoOHZL+bs3n+U3O2ZaqC/0N7VXErZb5+2auYT68rftiDKRYT4tSK1KtZqv2HdIiDsXbY6q+HSqka826luZyqGIC0F1tHPrZ1ga6Oyt9mDUKwhwWtnUePNDU0/a+5R0EusRiuVc/O12Sss8leylEVxdx+h';

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

  type VerifyResult = { verified: boolean; format?: string; error?: string };

  /** A valid vector must return verified=true with the expected format. */
  async function expectVerified(
    name: string,
    expectedFormat: string,
    fn: () => Promise<VerifyResult>,
  ): Promise<void> {
    try {
      const r = await fn();
      const passed = r.verified === true && r.format === expectedFormat;
      steps.push({
        name,
        passed,
        detail: passed
          ? `verified=true, format='${expectedFormat}'`
          : `expected verified=true/format='${expectedFormat}', got verified=${r.verified}, format=${String(r.format)}, error=${String(r.error)}`,
      });
    } catch (e) {
      steps.push({
        name,
        passed: false,
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  /** A bad vector must fail CLEARLY: verified=false with an error, no crash. */
  async function expectClearFailure(
    name: string,
    fn: () => Promise<VerifyResult>,
  ): Promise<void> {
    try {
      const r = await fn();
      const passed = r.verified === false && typeof r.error === 'string' && r.error.length > 0;
      steps.push({
        name,
        passed,
        detail: passed
          ? `verified=false with error: ${r.error}`
          : `expected verified=false with an error, got verified=${r.verified}, error=${String(r.error)}`,
      });
    } catch (e) {
      steps.push({
        name,
        passed: false,
        detail: `threw instead of returning a failure result: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Legacy Bitcoin Signed Message (BIP-137): P2PKH, P2SH-P2WPKH, P2WPKH.
  // ---------------------------------------------------------------------
  await expectVerified(
    'legacy BSM verifies a P2PKH (1…) address',
    'legacy',
    () => verifyBitcoinSignature(LEGACY_P2PKH_ADDR, LEGACY_MSG, LEGACY_SIG),
  );
  await expectVerified(
    'legacy BSM verifies a P2SH-P2WPKH (3…) address',
    'legacy',
    () => verifyBitcoinSignature(LEGACY_P2SH_P2WPKH_ADDR, LEGACY_MSG, LEGACY_SIG),
  );
  await expectVerified(
    'legacy BSM verifies a native P2WPKH (bc1q…) address',
    'legacy',
    () => verifyBitcoinSignature(LEGACY_P2WPKH_ADDR, LEGACY_MSG, LEGACY_SIG),
  );
  await expectClearFailure(
    'a tampered legacy BSM signature reports a clear failure',
    () => verifyBitcoinSignature(LEGACY_P2PKH_ADDR, LEGACY_MSG, tamperWitness(LEGACY_SIG)),
  );
  await expectClearFailure(
    'a legacy BSM proof against the wrong message reports a clear failure',
    () => verifyBitcoinSignature(LEGACY_P2PKH_ADDR, `${LEGACY_MSG} (edited)`, LEGACY_SIG),
  );

  // ---------------------------------------------------------------------
  // BIP-322 Simple: P2WPKH and Taproot key-path.
  // ---------------------------------------------------------------------
  await expectVerified(
    'verifyBip322P2WPKH verifies a valid bc1q BIP-322 witness',
    'bip322',
    () => verifyBip322P2WPKH(P2WPKH_ADDR, MESSAGE, P2WPKH_SIG),
  );
  await expectVerified(
    'verifyBitcoinSignature routes the P2WPKH BIP-322 proof and verifies it',
    'bip322',
    () => verifyBitcoinSignature(P2WPKH_ADDR, MESSAGE, P2WPKH_SIG),
  );
  await expectClearFailure(
    'a tampered P2WPKH BIP-322 witness reports a clear failure',
    () => verifyBitcoinSignature(P2WPKH_ADDR, MESSAGE, tamperWitness(P2WPKH_SIG)),
  );
  await expectClearFailure(
    'a P2WPKH BIP-322 proof against the wrong message reports a clear failure',
    () => verifyBitcoinSignature(P2WPKH_ADDR, 'Goodbye World', P2WPKH_SIG),
  );

  await expectVerified(
    'verifyBip322Simple verifies the Taproot key-path Bitcoin Core vector',
    'bip322',
    () => verifyBip322Simple(P2TR_ADDR, MESSAGE, P2TR_SIG),
  );
  await expectVerified(
    'verifyBitcoinSignature routes the Taproot key-path proof and verifies it',
    'bip322',
    () => verifyBitcoinSignature(P2TR_ADDR, MESSAGE, P2TR_SIG),
  );
  await expectClearFailure(
    'a tampered Taproot key-path witness reports a clear failure',
    () => verifyBitcoinSignature(P2TR_ADDR, MESSAGE, tamperWitness(P2TR_SIG)),
  );
  await expectClearFailure(
    'a Taproot key-path proof against the wrong message reports a clear failure',
    () => verifyBitcoinSignature(P2TR_ADDR, 'Goodbye World', P2TR_SIG),
  );

  // ---------------------------------------------------------------------
  // BIP-322 Full: native P2WSH multisig and Taproot script-path.
  // ---------------------------------------------------------------------
  await expectVerified(
    'verifyBip322Full verifies a 2-of-2 P2WSH multisig witness',
    'bip322',
    () => verifyBip322Full(P2WSH_2OF2_ADDR, MESSAGE, P2WSH_2OF2_SIG),
  );
  await expectVerified(
    'verifyBitcoinSignature routes the P2WSH multisig proof and verifies it',
    'bip322',
    () => verifyBitcoinSignature(P2WSH_2OF2_ADDR, MESSAGE, P2WSH_2OF2_SIG),
  );
  await expectClearFailure(
    'a tampered P2WSH multisig witness reports a clear failure',
    () => verifyBitcoinSignature(P2WSH_2OF2_ADDR, MESSAGE, tamperWitness(P2WSH_2OF2_SIG)),
  );
  await expectClearFailure(
    'a P2WSH multisig proof against the wrong message reports a clear failure',
    () => verifyBitcoinSignature(P2WSH_2OF2_ADDR, 'Goodbye World', P2WSH_2OF2_SIG),
  );

  await expectVerified(
    'verifyBip322Full verifies a Taproot single-leaf script-path witness',
    'bip322',
    () => verifyBip322Full(P2TR_LEAF_ADDR, MESSAGE, P2TR_LEAF_SIG),
  );
  await expectVerified(
    'verifyBitcoinSignature routes the Taproot script-path proof and verifies it',
    'bip322',
    () => verifyBitcoinSignature(P2TR_LEAF_ADDR, MESSAGE, P2TR_LEAF_SIG),
  );
  await expectClearFailure(
    'a tampered Taproot script-path witness reports a clear failure',
    () => verifyBitcoinSignature(P2TR_LEAF_ADDR, MESSAGE, tamperWitness(P2TR_LEAF_SIG)),
  );
  await expectClearFailure(
    'a Taproot script-path proof against the wrong message reports a clear failure',
    () => verifyBitcoinSignature(P2TR_LEAF_ADDR, 'Goodbye World', P2TR_LEAF_SIG),
  );

  // ---------------------------------------------------------------------
  // P2SH-P2WSH (wrapped multisig) — the original guard, kept verbatim.
  // ---------------------------------------------------------------------
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
