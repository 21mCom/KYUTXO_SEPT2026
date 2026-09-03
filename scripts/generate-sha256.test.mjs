import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findExecutables, sha256File, writeChecksums } from './generate-sha256.mjs';

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