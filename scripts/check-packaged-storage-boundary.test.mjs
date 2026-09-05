import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = path.resolve('scripts/check-packaged-storage-boundary.mjs');

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-boundary-'));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const result = spawnSync(process.execPath, [checker], {
    encoding: 'utf8',
    env: { ...process.env, PACKAGED_STORAGE_SCAN_ROOT: root },
  });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test('rejects renderer repository transactions', () => {
  const result = run({ 'feature.ts': 'repository.transaction(["records"], async () => 1);' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository\.transaction\(\) is forbidden/);
});

test('rejects Dexie construction outside the explicit adapter', () => {
  const result = run({ 'feature.ts': 'const live = new Dexie("plaintext-vault");' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /browser-adapter-only/);
});

test('allows the repository API and the explicit browser adapter', () => {
  const result = run({
    'feature.ts': 'getVaultRepository().put("records", row);',
    'lib/repository/dexie.ts': 'export class BrowserStore extends Dexie {}',
  });
  assert.equal(result.status, 0, result.stderr);
});