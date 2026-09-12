import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-release-fixtures.mjs',
);

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-fixtures-test-'));
  spawnSync('git', ['init', '-q'], { cwd: root, timeout: 30_000 });
  fs.writeFileSync(path.join(root, 'sample.pdf'), 'original pdf');
  fs.writeFileSync(path.join(root, 'nested.docx'), 'original docx');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not a protected document');
  spawnSync('git', ['add', '.'], { cwd: root, timeout: 30_000 });
  return root;
}

function run(root, source) {
  return spawnSync(process.execPath, [SCRIPT, '--', process.execPath, '-e', source], {
    cwd: root,
    env: { ...process.env, CHECK_RELEASE_FIXTURES_ROOT: root },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('passes when a test command leaves tracked documents unchanged', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(root, `require('node:fs').writeFileSync('notes.txt', 'changed')`);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /protecting 2 tracked sample document/);
});

test('labels deleted and rewritten documents together without reverting remaining damage', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unusualFilename = 'damaged\nsample.pdf';
  fs.writeFileSync(path.join(root, unusualFilename), 'unusual original');
  spawnSync('git', ['add', unusualFilename], { cwd: root, timeout: 30_000 });
  fs.writeFileSync(path.join(root, 'sample.pdf'), 'pre-existing user edit');

  const result = run(
    root,
    [
      `const fs = require('node:fs')`,
      `fs.rmSync(${JSON.stringify(unusualFilename)})`,
      `fs.writeFileSync('nested.docx', 'test rewrite')`,
    ].join(';'),
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /deleted: "damaged\\nsample\.pdf"/);
  assert.match(result.stderr, /rewritten: nested\.docx/);
  assert.doesNotMatch(result.stderr, /rewritten: "nested\.docx"/);
  assert.match(result.stderr, /left untouched/);
  assert.equal(fs.existsSync(path.join(root, unusualFilename)), false);
  assert.equal(fs.readFileSync(path.join(root, 'nested.docx'), 'utf8'), 'test rewrite');
});

test(
  'byte-escapes an invalid UTF-8 tracked document name without making diagnostics ambiguous',
  { skip: process.platform === 'win32' ? 'Windows paths cannot contain arbitrary byte sequences' : false },
  (t) => {
    const root = makeRepo();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filenameBytes = Buffer.from('invalid-X.pdf', 'ascii');
    filenameBytes[8] = 0xff;
    const absoluteFilename = Buffer.concat([Buffer.from(`${root}${path.sep}`), filenameBytes]);
    fs.writeFileSync(absoluteFilename, 'invalid utf8 original');
    spawnSync('git', ['add', '--all'], { cwd: root, timeout: 30_000 });

    const result = run(
      root,
      [
        `const fs = require('node:fs')`,
        `const path = require('node:path')`,
        `const name = Buffer.from(${JSON.stringify(filenameBytes.toString('hex'))}, 'hex')`,
        `fs.writeFileSync(Buffer.concat([Buffer.from(process.cwd() + path.sep), name]), 'rewritten')`,
      ].join(';'),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /rewritten: "invalid-\\xff\.pdf"/);
    assert.doesNotMatch(result.stderr, /\ufffd/);
  },
);

test(
  'keeps colliding invalid UTF-8 tracked document names distinct in one failure',
  { skip: process.platform === 'win32' ? 'Windows paths cannot contain arbitrary byte sequences' : false },
  (t) => {
    const root = makeRepo();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filenameBytes = [
      Buffer.from('collision-X.pdf', 'ascii'),
      Buffer.from('collision-X.pdf', 'ascii'),
    ];
    filenameBytes[0][10] = 0xff;
    filenameBytes[1][10] = 0xfe;
    for (const filename of filenameBytes) {
      fs.writeFileSync(
        Buffer.concat([Buffer.from(`${root}${path.sep}`), filename]),
        'invalid utf8 original',
      );
    }
    spawnSync('git', ['add', '--all'], { cwd: root, timeout: 30_000 });

    const result = run(
      root,
      [
        `const fs = require('node:fs')`,
        `const path = require('node:path')`,
        `const names = ${JSON.stringify(filenameBytes.map((name) => name.toString('hex')))}`,
        `for (const hex of names) {`,
        `  const name = Buffer.from(hex, 'hex')`,
        `  fs.writeFileSync(Buffer.concat([Buffer.from(process.cwd() + path.sep), name]), 'rewritten')`,
        `}`,
      ].join(';'),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /rewritten: "collision-\\xff\.pdf"/);
    assert.match(result.stderr, /rewritten: "collision-\\xfe\.pdf"/);
    assert.doesNotMatch(result.stderr, /\ufffd/);
  },
);

test('preserves a failing test command status when fixtures are unchanged', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(root, 'process.exit(7)');

  assert.equal(result.status, 7);
});