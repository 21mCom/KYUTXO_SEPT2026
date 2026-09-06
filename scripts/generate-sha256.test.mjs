import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findExecutables,
  sha256File,
  verifyChecksums,
  writeChecksums,
} from './generate-sha256.mjs';

test('writes the standard SHA-256 sidecar format for every executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-checksum-'));
  try {
    fs.writeFileSync(path.join(dir, 'KYUTXO-1.2.3-Portable.exe'), 'portable bytes');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a release asset');

    const [result] = writeChecksums([dir]);

    assert.equal(result.digest, sha256File(result.executable));
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.equal(
      fs.readFileSync(result.checksumPath, 'utf8'),
      `${result.digest}  KYUTXO-1.2.3-Portable.exe\n`,
    );
    assert.equal(fs.existsSync(path.join(dir, 'notes.txt.sha256')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed when a directory contains no executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-checksum-empty-'));
  try {
    assert.deepEqual(findExecutables([dir]), []);
    assert.throws(() => writeChecksums([dir]), /no \.exe release assets found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifies every executable against its matching sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-checksum-verify-'));
  try {
    fs.writeFileSync(path.join(dir, 'KYUTXO-1.exe'), 'one');
    fs.writeFileSync(path.join(dir, 'KYUTXO-2.exe'), 'two');
    writeChecksums([dir]);

    const results = verifyChecksums([dir]);
    assert.deepEqual(results.map(({ executable }) => path.basename(executable)), [
      'KYUTXO-1.exe',
      'KYUTXO-2.exe',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects missing, malformed, mismatched, and duplicate sidecars', () => {
  const cases = [
    {
      name: 'missing',
      mutate(dir) { fs.rmSync(path.join(dir, 'KYUTXO.exe.sha256')); },
      error: /missing SHA-256 sidecar/,
    },
    {
      name: 'malformed',
      mutate(dir) { fs.writeFileSync(path.join(dir, 'KYUTXO.exe.sha256'), 'not-a-checksum\n'); },
      error: /malformed SHA-256 sidecar/,
    },
    {
      name: 'mismatched',
      mutate(dir) { fs.writeFileSync(path.join(dir, 'KYUTXO.exe'), 'altered'); },
      error: /SHA-256 mismatch/,
    },
    {
      name: 'duplicate',
      mutate(dir) {
        fs.copyFileSync(
          path.join(dir, 'KYUTXO.exe.sha256'),
          path.join(dir, 'copy.exe.sha256'),
        );
      },
      error: /duplicate or unmatched SHA-256 sidecar/,
    },
  ];

  for (const testCase of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kyutxo-checksum-${testCase.name}-`));
    try {
      fs.writeFileSync(path.join(dir, 'KYUTXO.exe'), 'portable bytes');
      writeChecksums([dir]);
      testCase.mutate(dir);
      assert.throws(() => verifyChecksums([dir]), testCase.error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});