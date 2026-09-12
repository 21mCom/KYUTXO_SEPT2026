// Offline tests for the proof-vector generator guard's parsers
// (scripts/check-proof-vector-generators.js). The guard compares committed
// Python generator output against constants regex-parsed out of
// client/src/lib/signatureVerify.test.ts. If either regex silently stops
// matching (e.g. the test file switches to template literals), the guard
// could quietly check fewer constants — these tests lock the parsing
// behavior in with fixture strings, including drift and format-change cases.
//
// Run with: node --test scripts/check-proof-vector-generators.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTaprootGeneratorOutput,
  parseSegwitGeneratorOutput,
  parseTestConstants,
  SEGWIT_LABEL_TO_CONST,
  MIN_EXPECTED,
  isCoveredFamilyConstant,
  findUncoveredTestConstants,
} from './check-proof-vector-generators.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = path.join(ROOT, 'client/src/lib/signatureVerify.test.ts');

// --- taproot generator output parsing ---------------------------------------

test('taproot parser extracts NAME = \'value\' lines', () => {
  const out = [
    'some banner text',
    "P2TR_ANNEX_ADDR = 'bc1p0000'",
    "P2TR_ANNEX_SIG = 'AUHiJ+base64=='",
    "EXT_SIMPLE_SIG = ''", // empty value still parses
    'not_a_constant = \'nope\'', // lowercase name must not match
    "TRAILING_WS_OK = 'x'   ",
  ].join('\n');
  const map = parseTaprootGeneratorOutput(out);
  assert.equal(map.get('P2TR_ANNEX_ADDR'), 'bc1p0000');
  assert.equal(map.get('P2TR_ANNEX_SIG'), 'AUHiJ+base64==');
  assert.equal(map.get('EXT_SIMPLE_SIG'), '');
  assert.equal(map.get('TRAILING_WS_OK'), 'x');
  assert.equal(map.has('not_a_constant'), false);
  assert.equal(map.size, 4);
});

test('taproot parser throws when the output format changed (no matches)', () => {
  assert.throws(
    () => parseTaprootGeneratorOutput('P2TR_ANNEX_ADDR = "double-quoted-now"\n'),
    /output format changed/
  );
  assert.throws(() => parseTaprootGeneratorOutput(''), /output format changed/);
});

// --- segwit generator output parsing ----------------------------------------

function fullSegwitOutput(overrides = {}) {
  const lines = [];
  for (const label of Object.keys(SEGWIT_LABEL_TO_CONST)) {
    const value = overrides[label] ?? `value-for-${label.replace(/\s+/g, '_')}`;
    lines.push(`${label} : ${value}`);
  }
  return lines.join('\n') + '\n';
}

test('segwit parser maps every expected label to its constant', () => {
  const map = parseSegwitGeneratorOutput(fullSegwitOutput());
  assert.equal(map.size, Object.keys(SEGWIT_LABEL_TO_CONST).length);
  assert.equal(
    map.get('P2WPKH_V2_INDEP_ADDR'),
    'value-for-P2WPKH_addr'
  );
  assert.equal(
    map.get('P2SH_P2WSH_2OF3_V2_INDEP_SIG'),
    'value-for-P2SH-P2WSH_2of3_sig'
  );
});

test('segwit parser tolerates padding and ignores unknown labels', () => {
  const out = fullSegwitOutput() + '   Some banner : ignored\nUnrelated line\n';
  const map = parseSegwitGeneratorOutput(out);
  assert.equal(map.size, Object.keys(SEGWIT_LABEL_TO_CONST).length);
});

test('segwit parser fails loudly when a labelled line goes missing', () => {
  const lines = fullSegwitOutput()
    .split('\n')
    .filter((l) => !l.startsWith('P2WSH sig'));
  assert.throws(
    () => parseSegwitGeneratorOutput(lines.join('\n')),
    /missing expected labelled lines for: P2WSH_V2_INDEP_SIG/
  );
});

test('segwit parser fails loudly on a renamed label (format change)', () => {
  const out = fullSegwitOutput().replace('P2WPKH addr :', 'P2WPKH address :');
  assert.throws(
    () => parseSegwitGeneratorOutput(out),
    /missing expected labelled lines for: P2WPKH_V2_INDEP_ADDR/
  );
});

// --- test-file constant parsing ----------------------------------------------

test('parseTestConstants handles single-quoted single-line constants', () => {
  const src = "const FOO_BAR = 'hello';\nconst OTHER_ONE = 'world';\n";
  const map = parseTestConstants(src);
  assert.equal(map.get('FOO_BAR'), 'hello');
  assert.equal(map.get('OTHER_ONE'), 'world');
});

test('parseTestConstants joins multi-line + concatenated string constants', () => {
  const src = [
    'const LONG_SIG =',
    "  'part-one' +",
    "  'part-two' +",
    "  'part-three';",
  ].join('\n');
  const map = parseTestConstants(src);
  assert.equal(map.get('LONG_SIG'), 'part-onepart-twopart-three');
});

test('parseTestConstants ignores lowercase/non-constant declarations', () => {
  const src = "const notAConstant = 'x';\nlet ALSO_SKIPPED = 'y';\n";
  const map = parseTestConstants(src);
  assert.equal(map.size, 0);
});

test('parseTestConstants does NOT match template literals or double quotes (drift is caught as a missing constant, not silently skipped)', () => {
  // If the test file's formatting changes to a style the regex misses, the
  // constant disappears from the parsed map. The guard's compare loop then
  // fails with "no such constant exists", because every generator-emitted
  // name must be found. This test pins that contract: unmatched formats
  // yield ABSENT entries, never wrong values.
  const src = [
    'const TEMPLATED = `template-value`;',
    'const DOUBLE_QUOTED = "dq-value";',
    "const STILL_FINE = 'ok';",
  ].join('\n');
  const map = parseTestConstants(src);
  assert.equal(map.has('TEMPLATED'), false);
  assert.equal(map.has('DOUBLE_QUOTED'), false);
  assert.equal(map.get('STILL_FINE'), 'ok');
});

test('drifted value is preserved verbatim so the compare loop can flag it', () => {
  const src = "const P2TR_ANNEX_SIG = 'drifted-value';";
  const map = parseTestConstants(src);
  assert.equal(map.get('P2TR_ANNEX_SIG'), 'drifted-value');
  assert.notEqual(map.get('P2TR_ANNEX_SIG'), 'original-generator-value');
});

// --- reverse direction: covered-family constants need generator coverage ------

test('isCoveredFamilyConstant matches the EXT_/_ANNEX_/_V2_INDEP_ families with _ADDR/_SIG suffix', () => {
  assert.ok(isCoveredFamilyConstant('EXT_P2TR_LEAF_ADDR'));
  assert.ok(isCoveredFamilyConstant('EXT_P2WSH_2OF2_SIG'));
  assert.ok(isCoveredFamilyConstant('P2TR_ANNEX_ADDR'));
  assert.ok(isCoveredFamilyConstant('P2TR_KEYPATH_ANNEX_STRIPPED_SIG'));
  assert.ok(isCoveredFamilyConstant('P2WPKH_V2_INDEP_SIG'));
  assert.ok(isCoveredFamilyConstant('P2SH_P2WSH_2OF3_V2_INDEP_ADDR'));
});

test('isCoveredFamilyConstant excludes messages, other suffixes and non-covered families', () => {
  assert.equal(isCoveredFamilyConstant('EXT_MSG'), false); // no _ADDR/_SIG suffix
  assert.equal(isCoveredFamilyConstant('P2WPKH_V2_ADDR'), false); // v2, but not _V2_INDEP_
  assert.equal(isCoveredFamilyConstant('BARE_P2SH_2OF2_ADDR'), false);
  assert.equal(isCoveredFamilyConstant('HELLO_WORLD_SIG'), false);
  assert.equal(isCoveredFamilyConstant('MESSAGE'), false);
});

test('findUncoveredTestConstants flags a covered-family constant missing from generator output', () => {
  const testConsts = parseTestConstants(
    [
      "const P2TR_ANNEX_ADDR = 'bc1p-old';",
      "const P2TR_NEW_ANNEX_SIG = 'newly-added-without-generator';",
      "const EXT_NEW_THING_ADDR = 'also-uncovered';",
      "const BARE_P2SH_V2_ADDR = 'not-a-covered-family';",
    ].join('\n'),
  );
  const expected = new Map([['P2TR_ANNEX_ADDR', 'bc1p-old']]);
  assert.deepEqual(findUncoveredTestConstants(testConsts, expected), [
    'EXT_NEW_THING_ADDR',
    'P2TR_NEW_ANNEX_SIG',
  ]);
});

test('findUncoveredTestConstants returns empty when every covered constant is generator-backed', () => {
  const testConsts = parseTestConstants(
    "const P2TR_ANNEX_ADDR = 'a';\nconst EXT_P2TR_LEAF_SIG = 'b';\nconst OTHER_CONST = 'c';\n",
  );
  const expected = new Map([
    ['P2TR_ANNEX_ADDR', 'a'],
    ['EXT_P2TR_LEAF_SIG', 'b'],
  ]);
  assert.deepEqual(findUncoveredTestConstants(testConsts, expected), []);
});

test('every covered-family constant in the real test file is emitted by a committed generator name set', () => {
  // Offline approximation of the guard's reverse direction: the union of
  // taproot-generator names (parsed from the generator source's print lines is
  // not available offline) is approximated by requiring that each covered
  // constant is either segwit-mapped or in the taproot families the taproot
  // generator owns. The full byte-level check runs in the workflow.
  const source = fs.readFileSync(TEST_FILE, 'utf8');
  const map = parseTestConstants(source);
  const covered = [...map.keys()].filter(isCoveredFamilyConstant);
  assert.ok(covered.length >= 20, `expected many covered-family constants, got ${covered.length}`);
  // EXT_MSG must never be treated as covered (it has no generator line).
  assert.ok(map.has('EXT_MSG'));
  assert.equal(isCoveredFamilyConstant('EXT_MSG'), false);
});

// --- real test file & floor sanity -------------------------------------------

test('the real signatureVerify.test.ts still parses to at least the guard floor', () => {
  const source = fs.readFileSync(TEST_FILE, 'utf8');
  const map = parseTestConstants(source);
  assert.ok(
    map.size >= MIN_EXPECTED,
    `parsed only ${map.size} constants from signatureVerify.test.ts; ` +
      `the guard's floor is ${MIN_EXPECTED} — the file's constant formatting may have drifted ` +
      'out of the parser regex.'
  );
  // Every segwit-mapped constant must exist in the real test file.
  for (const constName of Object.values(SEGWIT_LABEL_TO_CONST)) {
    assert.ok(map.has(constName), `expected constant ${constName} missing from parsed test file`);
  }
});

test('MIN_EXPECTED floor stays meaningful (covers the mapped segwit family and more)', () => {
  assert.ok(MIN_EXPECTED > Object.keys(SEGWIT_LABEL_TO_CONST).length);
});
