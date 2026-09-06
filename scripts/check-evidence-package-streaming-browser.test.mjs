import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(ROOT, 'scripts/check-evidence-package-streaming-browser.mjs');

test('renderer errors fail both evidence streaming contexts', { timeout: 60_000 }, (t) => {
  const chromium = spawnSync('which', ['chromium'], { encoding: 'utf8' }).stdout.trim();
  if (!chromium) {
    t.skip('chromium is not installed');
    return;
  }

  const result = spawnSync(process.execPath, [CHECK], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      CHROMIUM_BIN: chromium,
      KYUTXO_TEST_EVIDENCE_STREAM_PAGE_ERRORS: '1',
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /\[evidence-stream\]\[page-error\] Injected renderer crash \(browser streaming path\)/);
  assert.match(output, /\[evidence-stream\]\[page-error\] Injected renderer crash \(desktop streaming path\)/);
  assert.match(output, /browser streaming path has no unexpected page errors: Injected renderer crash/);
  assert.match(output, /desktop streaming path has no unexpected page errors: Injected renderer crash/);
  assert.match(output, /\[evidence-stream\] ok=false/);
});