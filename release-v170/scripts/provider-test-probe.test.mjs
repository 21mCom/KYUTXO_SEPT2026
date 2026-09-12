import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron/preload.cjs'), 'utf8');
const PROVIDER_SOURCES = [
  fs.readFileSync(path.join(ROOT, 'electron/main.cjs'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'electron/electrum-client.cjs'), 'utf8'),
];

function loadPreload(providerProbeValue) {
  const invocations = [];
  let exposed;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, 'electronAPI');
        exposed = api;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invocations.push([channel, ...args]);
        return Promise.resolve({ channel });
      },
      on() {},
      removeListener() {},
    },
  };
  const env = providerProbeValue === undefined
    ? {}
    : { KYUTXO_PROVIDER_TEST_PROBE: providerProbeValue };
  const processStub = {
    env,
    platform: 'linux',
    versions: { electron: 'test' },
  };

  vm.runInNewContext(PRELOAD, {
    require(moduleName) {
      assert.equal(moduleName, 'electron');
      return electron;
    },
    process: processStub,
    console,
  }, { filename: 'electron/preload.cjs' });

  assert.ok(exposed, 'preload did not expose electronAPI');
  return { api: exposed, invocations };
}

function providerTestChannels() {
  const channels = new Set();
  for (const source of PROVIDER_SOURCES) {
    for (const match of source.matchAll(/\bipcMain\.handle\(\s*['"]((?:tor|electrum)-[^'"]+)['"]/g)) {
      const channel = match[1];
      if (channel === 'tor-request' || channel.includes('-test')) channels.add(channel);
    }
  }
  assert.ok(channels.size > 0, 'no desktop provider-test IPC handlers were found');
  return [...channels].sort();
}

test('provider-test probe is absent from ordinary desktop preload sessions', () => {
  for (const value of [undefined, '', '0', 'true']) {
    const { api } = loadPreload(value);
    assert.equal(
      Object.prototype.hasOwnProperty.call(api, 'providerTestProbe'),
      false,
      `probe was exposed for KYUTXO_PROVIDER_TEST_PROBE=${String(value)}`,
    );
  }
});

test('enabling the probe only adds diagnostics and records every provider-test IPC method', async () => {
  const ordinary = loadPreload(undefined);
  const enabled = loadPreload('1');

  assert.deepEqual(
    Object.keys(enabled.api).filter((key) => key !== 'providerTestProbe').sort(),
    Object.keys(ordinary.api).sort(),
    'enabling the probe changed the ordinary preload API',
  );
  assert.equal(enabled.api.providerTestProbe.count(), 0);
  assert.deepEqual([...enabled.api.providerTestProbe.calls()], []);

  const methods = [
    ['torTest', [], 'tor-test'],
    ['torRequest', [{ url: 'https://example.invalid' }], 'tor-request'],
    ['electrumTest', [{ host: 'example.invalid' }], 'electrum-test'],
  ];
  assert.deepEqual(
    methods.map(([, , channel]) => channel).sort(),
    providerTestChannels(),
    'desktop provider-test IPC inventory changed; add its preload method to the probe contract',
  );

  for (const [method, args, channel] of methods) {
    assert.equal(typeof enabled.api[method], 'function', `${method} is missing from the preload API`);
    await enabled.api[method](...args);
    assert.equal(enabled.invocations.at(-1)?.[0], channel, `${method} invoked the wrong IPC channel`);
  }
  assert.equal(enabled.api.providerTestProbe.count(), methods.length);
  assert.deepEqual(
    [...enabled.api.providerTestProbe.calls()],
    methods.map(([, , channel]) => channel),
  );

  await ordinary.api.torTest();
  await ordinary.api.torRequest({});
  await ordinary.api.electrumTest({});
  assert.deepEqual(
    ordinary.invocations.map(([channel]) => channel),
    methods.map(([, , channel]) => channel),
    'ordinary provider-test preload behavior changed',
  );
});