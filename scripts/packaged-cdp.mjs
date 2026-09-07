import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function packagedCdpLaunchArgs(userDataDir) {
  if (!path.isAbsolute(userDataDir)) {
    throw new Error(`packaged CDP user-data directory must be absolute: ${userDataDir}`);
  }
  return [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
  ];
}

export function readDevToolsActivePort(userDataDir) {
  const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
  const [portText, browserPath, ...extra] = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
  const port = Number(portText);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !browserPath?.startsWith('/devtools/browser/') ||
    extra.length > 0
  ) {
    throw new Error(`invalid packaged CDP ownership file: ${activePortFile}`);
  }
  return { port, browserPath, activePortFile };
}

export function clearPackagedCdpOwnership(userDataDir) {
  fs.rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true });
}

export async function waitForOwnedPackagedCdp({
  userDataDir,
  timeoutMs,
  fetchImpl = fetch,
  pollMs = 250,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const ownership = readDevToolsActivePort(userDataDir);
      const response = await fetchImpl(`http://127.0.0.1:${ownership.port}/json/version`);
      if (!response.ok) throw new Error(`CDP version endpoint returned HTTP ${response.status}`);
      const version = await response.json();
      const debuggerUrl = new URL(version.webSocketDebuggerUrl);
      if (
        debuggerUrl.hostname !== '127.0.0.1' ||
        Number(debuggerUrl.port) !== ownership.port ||
        debuggerUrl.pathname !== ownership.browserPath
      ) {
        throw new Error(
          `CDP ownership mismatch: profile recorded ${ownership.browserPath}, ` +
            `endpoint reported ${debuggerUrl.pathname}`,
        );
      }
      return ownership;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `could not establish ownership of packaged CDP endpoint from ` +
      `${path.join(userDataDir, 'DevToolsActivePort')}: ${lastError?.message || 'timed out'}`,
  );
}

export async function waitForPackagedCdpDown(port, timeoutMs, fetchImpl = fetch) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchImpl(`http://127.0.0.1:${port}/json/version`);
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
}