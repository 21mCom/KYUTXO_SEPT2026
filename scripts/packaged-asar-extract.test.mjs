import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as asar from '@electron/asar';
import { extractAvailableAsarTree } from './packaged-asar-extract.mjs';

test('extracts available files while tolerating absent unpacked metadata entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-asar-extract-'));
  try {
    const source = path.join(root, 'source');
    const archive = path.join(root, 'app.asar');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(path.join(source, 'native'), { recursive: true });
    fs.writeFileSync(path.join(source, 'worker.cjs'), 'module.exports = 42;\n');
    fs.writeFileSync(path.join(source, 'native', 'addon.node'), 'native bytes');
    fs.writeFileSync(path.join(source, 'native', 'optional-metadata.yml'), 'optional metadata');

    await asar.createPackageWithOptions(source, archive, {
      unpack: '**/native/**',
    });
    fs.rmSync(path.join(`${archive}.unpacked`, 'native', 'optional-metadata.yml'));

    const missing = [];
    const guardedAsar = {
      ...asar,
      extractFile: (...args) => {
        assert.notEqual(args[1], 'native', 'directories must not be passed to asar.statFile');
        return asar.extractFile(...args);
      },
    };
    extractAvailableAsarTree({
      asar: guardedAsar,
      archivePath: archive,
      destination,
      onMissingEntry: (entry) => missing.push(entry),
    });

    assert.equal(fs.readFileSync(path.join(destination, 'worker.cjs'), 'utf8'), 'module.exports = 42;\n');
    assert.equal(fs.readFileSync(path.join(destination, 'native', 'addon.node'), 'utf8'), 'native bytes');
    assert.deepEqual(missing, ['native/optional-metadata.yml']);
    assert.equal(fs.existsSync(path.join(destination, 'native', 'optional-metadata.yml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});