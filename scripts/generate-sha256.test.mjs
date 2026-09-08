import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findExecutables,
  sha256File,
  verifyChecksums,
  writeChecksums,
} from './generate-sha256.mjs';

const checksumScript = fileURLToPath(new URL('./generate-sha256.mjs', import.meta.url));

function runChecksumCli(args) {
  return spawnSync(process.execPath, [checksumScript, ...args], {
    encoding: 'utf8',
  });
}

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

test('CLI generation creates a sidecar for a direct executable and reports it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-checksum-cli-file-'));
  try {
    const executable = path.join(dir, 'KYUTXO-Portable.exe');
    fs.writeFileSync(executable, 'portable bytes');

    const result = runChecksumCli([executable]);
    const digest = sha256File(executable);
    const checksumPath = `${executable}.sha256`;

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(fs.readFileSync(checksumPath, 'utf8'), `${digest}  KYUTXO-Portable.exe\n`);
    assert.match(
      result.stdout,
      new RegExp(`\\[release-checksums\\] .*KYUTXO-Portable\\.exe\\.sha256 -> ${digest}`),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI generation creates and reports every sidecar in a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-checksum-cli-dir-'));
  try {
    const executables = [
      path.join(dir, 'KYUTXO-Installer.exe'),
      path.join(dir, 'KYUTXO-Portable.EXE'),
    ];
    fs.writeFileSync(executables[0], 'installer bytes');
    fs.writeFileSync(executables[1], 'portable bytes');
    fs.writeFileSync(path.join(dir, 'release-notes.txt'), 'not an executable');

    const result = runChecksumCli([dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    for (const executable of executables) {
      const digest = sha256File(executable);
      const checksumPath = `${executable}.sha256`;
      assert.equal(
        fs.readFileSync(checksumPath, 'utf8'),
        `${digest}  ${path.basename(executable)}\n`,
      );
      assert.match(
        result.stdout,
        new RegExp(
          `\\[release-checksums\\] .*${path.basename(checksumPath).replaceAll('.', '\\.')} -> ${digest}`,
        ),
      );
    }
    assert.equal(fs.existsSync(path.join(dir, 'release-notes.txt.sha256')), false);
    assert.equal(result.stdout.trim().split('\n').length, executables.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI generation rejects empty directories and unsupported files with actionable stderr', () => {
  const cases = [
    {
      name: 'empty-directory',
      prepare(dir) {
        fs.writeFileSync(path.join(dir, 'release-notes.txt'), 'not an executable');
        return dir;
      },
      error: /FAIL: .*no \.exe release assets found/,
    },
    {
      name: 'unsupported-file',
      prepare(dir) {
        const input = path.join(dir, 'release-notes.txt');
        fs.writeFileSync(input, 'not an executable');
        return input;
      },
      error: /FAIL: .*expected an \.exe file or directory: .*release-notes\.txt/,
    },
  ];

  for (const testCase of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kyutxo-checksum-cli-${testCase.name}-`));
    try {
      const result = runChecksumCli([testCase.prepare(dir)]);

      assert.notEqual(result.status, 0, `${testCase.name} unexpectedly succeeded`);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, testCase.error);
      assert.deepEqual(
        fs.readdirSync(dir).filter((name) => name.endsWith('.sha256')),
        [],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

test('CLI --verify exits successfully for valid checksum pairs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-checksum-cli-valid-'));
  try {
    fs.writeFileSync(path.join(dir, 'KYUTXO.exe'), 'portable bytes');
    writeChecksums([dir]);

    const result = runChecksumCli(['--verify', dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /\[release-checksums\] verified .*KYUTXO\.exe\.sha256 -> [a-f0-9]{64}/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --verify rejects an existing empty release directory without success output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-checksum-cli-empty-'));
  try {
    const result = runChecksumCli(['--verify', dir]);

    assert.notEqual(result.status, 0, 'empty release directory unexpectedly succeeded');
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /FAIL: .*no \.exe release assets found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --verify exits non-zero with actionable stderr for invalid sidecars', () => {
  const cases = [
    {
      name: 'missing',
      mutate(dir) { fs.rmSync(path.join(dir, 'KYUTXO.exe.sha256')); },
      error: /FAIL: .*missing SHA-256 sidecar for KYUTXO\.exe/,
    },
    {
      name: 'malformed',
      mutate(dir) { fs.writeFileSync(path.join(dir, 'KYUTXO.exe.sha256'), 'not-a-checksum\n'); },
      error: /FAIL: .*malformed SHA-256 sidecar: .*KYUTXO\.exe\.sha256/,
    },
    {
      name: 'mismatched',
      mutate(dir) { fs.writeFileSync(path.join(dir, 'KYUTXO.exe'), 'altered'); },
      error: /FAIL: .*SHA-256 mismatch for KYUTXO\.exe: expected [a-f0-9]{64}, got [a-f0-9]{64}/,
    },
    {
      name: 'duplicate',
      mutate(dir) {
        fs.copyFileSync(
          path.join(dir, 'KYUTXO.exe.sha256'),
          path.join(dir, 'copy.exe.sha256'),
        );
      },
      error: /FAIL: .*duplicate or unmatched SHA-256 sidecar: .*copy\.exe\.sha256/,
    },
  ];

  for (const testCase of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kyutxo-checksum-cli-${testCase.name}-`));
    try {
      fs.writeFileSync(path.join(dir, 'KYUTXO.exe'), 'portable bytes');
      writeChecksums([dir]);
      testCase.mutate(dir);

      const result = runChecksumCli(['--verify', dir]);

      assert.notEqual(result.status, 0, `${testCase.name} unexpectedly succeeded`);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, testCase.error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('CLI --verify usage errors exit non-zero and print usage to stderr', () => {
  const result = runChecksumCli(['--verify']);

  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(
    result.stderr,
    /FAIL: Usage: node scripts\/generate-sha256\.mjs \[--verify\] <exe-or-directory> \[\.\.\.\]/,
  );
});

test('CLI --verify rejects missing and non-executable input paths clearly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-checksum-cli-input-'));
  try {
    const missingPath = path.join(dir, 'missing.exe');
    const nonExecutablePath = path.join(dir, 'release-notes.txt');
    fs.writeFileSync(nonExecutablePath, 'not a release executable');

    const cases = [
      {
        name: 'missing path',
        input: missingPath,
        error: new RegExp(`FAIL: .*input does not exist: ${missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      },
      {
        name: 'non-executable file',
        input: nonExecutablePath,
        error: new RegExp(`FAIL: .*expected an \\.exe file or directory: ${nonExecutablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      },
    ];

    for (const testCase of cases) {
      const result = runChecksumCli(['--verify', testCase.input]);

      assert.notEqual(result.status, 0, `${testCase.name} unexpectedly succeeded`);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, testCase.error);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
