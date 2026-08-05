#!/usr/bin/env node
/**
 * Guard: the committed BIP-322 independent-vector generators must still
 * reproduce the constants in client/src/lib/signatureVerify.test.ts
 * byte-for-byte. If either a generator or a test constant is edited, the
 * "re-derivable" guarantee decays silently — this check fails loudly on
 * any drift.
 *
 * Generators (pure stdlib Python, deterministic):
 *   - scripts/generate-bip322-independent-vectors.py
 *       emits `NAME = '<value>'` lines whose NAMEs match the test constants
 *       (P2TR_ANNEX_*, P2TR_KEYPATH_ANNEX_*, P2TR_*_V2_INDEP_*, EXT_*).
 *   - scripts/proof-vectors/generate_segwit_v2_independent.py
 *       emits labelled `<label> addr/sig : <value>` lines that map to the
 *       P2WPKH/P2WSH/P2SH_* _V2_INDEP_* test constants.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = path.join(ROOT, 'client/src/lib/signatureVerify.test.ts');
const GEN_TAPROOT = path.join(ROOT, 'scripts/generate-bip322-independent-vectors.py');
const GEN_SEGWIT = path.join(ROOT, 'scripts/proof-vectors/generate_segwit_v2_independent.py');

let failures = 0;
function fail(msg) {
  failures += 1;
  console.error(`FAIL: ${msg}`);
}

function runGenerator(script) {
  const res = spawnSync('python3', [script], { encoding: 'utf8', timeout: 120000 });
  if (res.error) {
    throw new Error(`could not run python3 ${script}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `generator exited with code ${res.status}: ${script}\n${res.stderr || res.stdout}`,
    );
  }
  return res.stdout;
}

// --- expected values from the generators ------------------------------------

export function parseTaprootGeneratorOutput(out) {
  // Lines of the form:  NAME = 'value'
  const map = new Map();
  const re = /^([A-Z][A-Z0-9_]*) = '([^']*)'\s*$/gm;
  let m;
  while ((m = re.exec(out)) !== null) map.set(m[1], m[2]);
  if (map.size === 0) {
    throw new Error('taproot generator emitted no NAME = \'...\' lines (output format changed?)');
  }
  return map;
}

// Maps the segwit generator's human labels to the test-file constant names.
export const SEGWIT_LABEL_TO_CONST = {
  'P2WPKH addr': 'P2WPKH_V2_INDEP_ADDR',
  'P2WPKH sig': 'P2WPKH_V2_INDEP_SIG',
  'P2WSH addr': 'P2WSH_V2_INDEP_ADDR',
  'P2WSH sig': 'P2WSH_V2_INDEP_SIG',
  'P2SH-P2WPKH addr': 'P2SH_P2WPKH_V2_INDEP_ADDR',
  'P2SH-P2WPKH sig': 'P2SH_P2WPKH_V2_INDEP_SIG',
  'P2SH-P2WSH addr': 'P2SH_P2WSH_V2_INDEP_ADDR',
  'P2SH-P2WSH sig': 'P2SH_P2WSH_V2_INDEP_SIG',
  'P2SH-P2WSH 2of2 addr': 'P2SH_P2WSH_2OF2_V2_INDEP_ADDR',
  'P2SH-P2WSH 2of2 sig': 'P2SH_P2WSH_2OF2_V2_INDEP_SIG',
  'P2SH-P2WSH 2of3 addr': 'P2SH_P2WSH_2OF3_V2_INDEP_ADDR',
  'P2SH-P2WSH 2of3 sig': 'P2SH_P2WSH_2OF3_V2_INDEP_SIG',
};

export function parseSegwitGeneratorOutput(out) {
  const map = new Map();
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    const m = /^(.*?)\s*:\s*(\S+)$/.exec(line);
    if (!m) continue;
    const constName = SEGWIT_LABEL_TO_CONST[m[1].trim()];
    if (constName) map.set(constName, m[2]);
  }
  const missing = Object.values(SEGWIT_LABEL_TO_CONST).filter((c) => !map.has(c));
  if (missing.length > 0) {
    throw new Error(
      `segwit-v2 generator output is missing expected labelled lines for: ${missing.join(', ')} ` +
        '(output format changed?)',
    );
  }
  return map;
}

// --- actual constants from the test file ------------------------------------

export function parseTestConstants(source) {
  // Matches: const NAME =\n?  'value' [+ 'value']*;
  const map = new Map();
  const re = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*((?:'[^']*'\s*(?:\+\s*)?)+);/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const parts = m[2].match(/'([^']*)'/g) || [];
    map.set(m[1], parts.map((p) => p.slice(1, -1)).join(''));
  }
  return map;
}

// Sanity floor for the number of generator constants that must parse.
export const MIN_EXPECTED = 25;

// --- reverse direction: covered-family test constants need a generator -------

// Naming families whose test constants are guaranteed to be independently
// re-derivable. Any _ADDR/_SIG constant in these families that appears in
// signatureVerify.test.ts MUST be emitted by a committed generator; a new
// vector added test-side only silently erodes the guarantee.
export function isCoveredFamilyConstant(name) {
  if (!/_(?:ADDR|SIG)$/.test(name)) return false;
  return (
    name.startsWith('EXT_') ||
    name.includes('_ANNEX_') ||
    name.includes('_V2_INDEP_')
  );
}

export function findUncoveredTestConstants(testConsts, expected) {
  const uncovered = [];
  for (const name of testConsts.keys()) {
    if (isCoveredFamilyConstant(name) && !expected.has(name)) uncovered.push(name);
  }
  return uncovered.sort();
}

// --- compare -----------------------------------------------------------------

function main() {
  const testSource = fs.readFileSync(TEST_FILE, 'utf8');
  const testConsts = parseTestConstants(testSource);

  const expected = new Map([
    ...parseTaprootGeneratorOutput(runGenerator(GEN_TAPROOT)),
    ...parseSegwitGeneratorOutput(runGenerator(GEN_SEGWIT)),
  ]);

  let checked = 0;
  for (const [name, expectedValue] of expected) {
    if (!testConsts.has(name)) {
      fail(
        `generator emits ${name} but no such constant exists in signatureVerify.test.ts ` +
          '(renamed or removed without updating the generator?)',
      );
      continue;
    }
    const actual = testConsts.get(name);
    if (actual !== expectedValue) {
      fail(
        `${name} has drifted from its committed generator.\n` +
          `  generator: ${expectedValue}\n` +
          `  test file: ${actual}`,
      );
    }
    checked += 1;
  }

  // Reverse direction: any covered-family constant in the test file must be
  // backed by generator output, or the "independently re-derivable"
  // guarantee has silently eroded.
  for (const name of findUncoveredTestConstants(testConsts, expected)) {
    fail(
      `${name} exists in signatureVerify.test.ts (covered naming family EXT_*/` +
        '*_ANNEX_*/*_V2_INDEP_*) but is not emitted by any committed generator. ' +
        'Add generator coverage for the new vector, or rename it out of the covered families ' +
        'only if it is genuinely not meant to be independently re-derivable.',
    );
  }

  // Sanity floor: the generators cover the annex, v2-indep, segwit-v2 and
  // EXT_* families. If parsing ever silently collapses, refuse to pass.
  if (expected.size < MIN_EXPECTED) {
    fail(
      `only ${expected.size} generator constants were parsed (expected at least ` +
        `${MIN_EXPECTED}); generator output or parser drifted.`,
    );
  }

  if (failures > 0) {
    console.error(`\nproof-vector generator check FAILED (${failures} problem(s)).`);
    console.error(
      'The committed generators no longer reproduce the test constants byte-for-byte. ' +
        'Either revert the edit, or update BOTH the generator and the test constants together.',
    );
    process.exit(1);
  }
  console.log(
    `proof-vector generator check passed: ${checked} constants match their committed generators ` +
      `(${expected.size} generator outputs verified).`,
  );
}

// Only run the full generator-vs-test-file comparison when executed directly
// (node scripts/check-proof-vector-generators.js), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
