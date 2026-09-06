#!/usr/bin/env node
// Packaged-desktop-app regression guard: the electron-builder asar must not
// ship with a blank window or broad local-file privileges again.
//
// The renderer is served from kyutxo-app://bundle through a custom protocol
// confined to dist/public inside app.asar. Any file:// fallback or broad path
// remap would restore arbitrary readable-file access to compromised renderer
// code, so this check probes that boundary in the live packaged application.
//
// This check builds the real electron-builder output, launches it under the
// nix Electron runtime with Xvfb + CDP on Linux (recipe:
// .agents/memory/packaged-electron-verify.md), or launches the generated
// Windows portable release wrapper from a disposable directory, and asserts
// in the live packaged renderer:
//   1. The renderer actually renders from kyutxo-app://bundle.
//   2. The CSP <meta> tag is present in the served document and carries the
//      security-critical directives (require-trusted-types-for, trusted-types
//      allowlist, wasm-unsafe-eval, no unsafe-inline in script-src).
//   3. Inline <script> injection is actually blocked in-page.
//   4. Trusted Types enforcement is active (raw innerHTML assignment throws).
//   5. WebAssembly compiles (the Argon2id KDF needs 'wasm-unsafe-eval').
//   6. Arbitrary file paths are unreadable.
//   7. A configured provider is reachable only through validated main IPC.
//   8. Camera permission is denied outside the QR route.
//   9. Production reload shortcuts are disabled.
//  10. The idle lifecycle signal locks through AuthContext without reloading.
//
// Usage:
//   node scripts/check-packaged-electron-browser.mjs
//     Builds everything (npm run build + native engine + electron-builder --dir),
//     then launches and asserts. Takes several minutes.
//   KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-electron-browser.mjs
//     Reuses an existing release/<platform>-unpacked output (fails if absent).
//
// Linux requirements (all present in this Replit environment):
//   - a nix Electron 29.x store path (upstream Electron >=~39 binaries crash
//     with "Floating point exception" here) — override via KYUTXO_ELECTRON_BIN
//   - a nix xorg-server store path providing Xvfb — override via KYUTXO_XVFB_BIN.
//     (The nix `xvfb-run` wrapper bundles an ancient xorg-server 1.20 whose
//     Xvfb segfaults in this environment — launch a modern Xvfb directly.)
//   - playwright-core (driving via CDP connectOverCDP)

import { chromium } from 'playwright-core';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  waitForExistingVaultLoginScreen,
  waitForLoginScreenVisible,
  unlockIfNeeded,
} from './browser-check-utils.mjs';
import {
  assertPackagedBundleFresh,
  assertPackagedAsarFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';
import {
  findWindowsPortableArtifact,
  prepareWindowsPortableLaunch,
} from './packaged-windows-portable.mjs';

await acquireBrowserCheckLock();

// Windows-safe (fileURLToPath): `new URL(...).pathname` is `/D:/...` on win32
// and path.resolve mangles it — see repoRootFromModuleUrl.
const ROOT = repoRootFromModuleUrl(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const UNPACKED_DIR = path.join(ROOT, 'release', IS_WINDOWS ? 'win-unpacked' : 'linux-unpacked');
const ASAR = path.join(UNPACKED_DIR, 'resources', 'app.asar');
const PACKAGED_EXECUTABLE = path.join(UNPACKED_DIR, IS_WINDOWS ? 'KYUTXO.exe' : 'kyutxo');
const CDP_PORT = Number(process.env.KYUTXO_PACKAGED_CDP_PORT || 9223);
const TAG = '[packaged-electron]';
const PORTABLE_CHECK_PASSWORD = 'portable-check-password';
const BUILD_COMMAND_TIMEOUT_MS = 15 * 60_000;
const TASKKILL_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  console.log(`${TAG} $ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    timeout: BUILD_COMMAND_TIMEOUT_MS,
  });
  if (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM') {
    throw new Error(`${TAG} timed out during package build command ${cmd} after ${BUILD_COMMAND_TIMEOUT_MS}ms`);
  }
  if (res.status !== 0) {
    throw new Error(`${TAG} command failed (exit ${res.status}): ${cmd} ${args.join(' ')}`);
  }
}

function buildAsar() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) {
      throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} does not exist.`);
    }
    console.log(`${TAG} reusing existing asar: ${ASAR}`);
    // Reused asars are the highest-risk stale path: fail fast if dist/public
    // (which the asar was packaged from) predates the current source, or if
    // the asar itself predates electron/ main-process source or dist/public
    // (task 1959: a stale shell would test months-old CSP/remap/IPC code).
    assertPackagedBundleFresh({ tag: TAG });
    assertPackagedAsarFresh({ tag: TAG, asarPath: ASAR });
    return;
  }
  // Mirrors scripts/electron-build.sh steps 1-3, but packages an unpacked dir
  // (fast; no installers) and skips npmRebuild: rebuilding better-sqlite3
  // against Electron 39 headers needs network and would mismatch the nix
  // Electron 29 ABI we launch with anyway. The renderer/CSP surface under test
  // does not involve the native module — that packaging surface is covered by
  // the companion gate scripts/check-packaged-native-engine.mjs.
  run('npm', ['run', 'build']);
  // `npm run build` has been seen to "succeed" without refreshing dist/public
  // (task 1925) — verify the bundle is actually newer than the source.
  assertPackagedBundleFresh({ tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', [
    'electron-builder',
    '--config',
    'electron-builder.json',
    '--dir',
    IS_WINDOWS ? '--win' : '--linux',
    '-c.npmRebuild=false',
  ]);
  if (!fs.existsSync(ASAR)) {
    throw new Error(`${TAG} electron-builder finished but ${ASAR} was not produced.`);
  }
}

async function waitForCdp(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

async function waitForCdpDown(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) {
        await sleep(250);
        continue;
      }
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForRendererPage(browser, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().startsWith('kyutxo-app://bundle/')) return p;
      }
    }
    await sleep(1000);
  }
  throw new Error(`${TAG} no kyutxo-app://bundle renderer page appeared within ${timeoutMs}ms.`);
}

function attachPageDiagnostics(page) {
  console.log(`${TAG} renderer page: ${page.url()}`);
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`${TAG}[renderer-console-${msg.type()}] ${msg.text().slice(0, 500)}`);
    }
  });
  page.on('pageerror', (err) => {
    console.log(`${TAG}[renderer-pageerror] ${String(err?.stack || err).slice(0, 500)}`);
  });
  page.on('requestfailed', (request) => {
    console.log(
      `${TAG}[renderer-request-failed] ${request.method()} ${request.url().slice(0, 300)} ` +
        `— ${request.failure()?.errorText || 'unknown error'}`,
    );
  });
  page.on('crash', () => console.log(`${TAG}[renderer-crashed] renderer process crashed`));
}

async function collectRendererDiagnostics(page) {
  return page
    .evaluate(() => ({
      readyState: document.readyState,
      rootChildCount: document.getElementById('root')?.childElementCount ?? -1,
      bodyText: document.body?.innerText.slice(0, 300) ?? '<no body>',
      scripts: Array.from(document.scripts).map((script) => ({
        src: script.src ? new URL(script.src).pathname.split('/').pop() : '<inline>',
        type: script.type || '<classic>',
      })),
      resources: performance.getEntriesByType('resource').map((entry) => {
        const resource = /** @type {PerformanceResourceTiming} */ (entry);
        return {
          name: new URL(resource.name).pathname.split('/').pop(),
          initiatorType: resource.initiatorType,
          duration: Math.round(resource.duration),
          transferSize: resource.transferSize,
        };
      }),
    }))
    .catch((err) => ({ evaluationError: String(err?.message || err) }));
}

function countRegularFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return 0;
  let count = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  };
  visit(rootDir);
  return count;
}

function isPathWithin(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function killWindowsProcessTree(child, { force }) {
  if (!child?.pid) return;
  // The portable wrapper launches a second Electron process while extracting.
  // Killing only the wrapper can leave that child holding the temporary
  // profile/files open, so use taskkill's tree mode on Windows.
  const args = ['/PID', String(child.pid), '/T'];
  if (force) args.push('/F');
  const result = spawnSync('taskkill', args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    timeout: TASKKILL_TIMEOUT_MS,
  });
  console.log(
    `${TAG} taskkill portable process tree (${force ? 'forced' : 'graceful'}) exit=${result.status}`,
  );
}

async function stopPackagedProcess(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    // Address the whole tree before the ExecWait wrapper can be orphaned.
    // First request normal termination, then force any extraction/app process
    // that still holds files open.
    killWindowsProcessTree(child, { force: false });
    await sleep(2000);
    killWindowsProcessTree(child, { force: true });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  await sleep(2000);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  buildAsar();

  let electronBin = null;
  let xvfbBin = null;
  let portableArtifact = null;
  if (IS_WINDOWS) {
    if (!fs.existsSync(PACKAGED_EXECUTABLE)) {
      throw new Error(
        `${TAG} packaged Windows executable is missing: ${PACKAGED_EXECUTABLE}`,
      );
    }
    portableArtifact = findWindowsPortableArtifact({
      root: ROOT, asarPath: ASAR, tag: TAG,
    });
    console.log(`${TAG} unpacked executable (native-engine companion): ${PACKAGED_EXECUTABLE}`);
    console.log(`${TAG} generated portable artifact: ${portableArtifact}`);
  } else {
    ({ electronBin, xvfbBin } = findPackagedBinaries({ tag: TAG }));
    console.log(`${TAG} electron: ${electronBin}`);
    console.log(`${TAG} Xvfb: ${xvfbBin}`);
  }

  // Fresh, isolated profile: Replit points XDG_CONFIG_HOME etc. at the
  // workspace, which would persist vault state across "fresh" runs.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-check-'));
  let portableSetup = null;
  const outsideSentinel = path.join(tmpHome, 'outside-bundle-secret.txt');
  const outsideSentinelText = `outside-bundle-${process.pid}`;
  fs.writeFileSync(outsideSentinel, outsideSentinelText, 'utf8');

  const providerFixture = createServer((req, res) => {
    if (req.url === '/api/blocks/tip/height') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('840000');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve, reject) => {
    providerFixture.once('error', reject);
    providerFixture.listen(0, '127.0.0.1', resolve);
  });
  const fixtureAddress = providerFixture.address();
  const providerBaseUrl = `http://127.0.0.1:${fixtureAddress.port}/api`;
  // A portable executable can inherit this variable from a runner. Do not
  // allow an inherited portable directory to defeat the isolated profile.
  if (IS_WINDOWS) {
    portableSetup = prepareWindowsPortableLaunch({
      root: ROOT, asarPath: ASAR, home: tmpHome, tag: TAG,
    });
    portableArtifact = portableSetup.artifactPath;
  }
  const env = {
    ...(portableSetup?.env || process.env),
    HOME: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
    XDG_CACHE_HOME: path.join(tmpHome, '.cache'),
    XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(tmpHome, '.local', 'state'),
    NODE_ENV: 'production',
    // Exercise the main→preload→AuthContext lock signal in this live gate.
    KYUTXO_IDLE_LOCK_SECONDS: '2',
  };
  if (IS_WINDOWS) {
    // The portable wrapper sets PORTABLE_EXECUTABLE_DIR to the directory
    // containing the launched copy below. Keep every Windows fallback and the
    // wrapper's extraction temp files inside the same disposable directory.
  }

  let xvfb = null;
  const DISPLAY = process.env.KYUTXO_PACKAGED_DISPLAY || ':99';
  if (!IS_WINDOWS) {
    console.log(`${TAG} starting Xvfb on ${DISPLAY}...`);
    xvfb = spawn(xvfbBin, [DISPLAY, '-screen', '0', '1280x800x24'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    xvfb.stderr.on('data', (d) => process.stdout.write(`${TAG}[xvfb] ${d}`));
    await sleep(2000);
  }

  console.log(
    `${TAG} launching packaged app${IS_WINDOWS ? '' : ` on ${DISPLAY}`} ` +
      `(CDP port ${CDP_PORT})...`,
  );
  const launchArgs = IS_WINDOWS
    ? [
        '--disable-gpu',
        `--remote-debugging-port=${CDP_PORT}`,
      ]
    : [ASAR, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`];
  let child = null;
  let appExited = false;
  let appLaunchError = null;
  const steps = [];
  let browser = null;
  try {
    let launchExecutable = PACKAGED_EXECUTABLE;
    if (IS_WINDOWS) {
      // Do not launch win-unpacked here: the downloadable release is the
      // self-extracting portable wrapper. Copying the exact generated artifact
      // into the disposable folder makes the wrapper select that folder for
      // PORTABLE_EXECUTABLE_DIR and prevents test data from reaching release/.
      launchExecutable = portableSetup.executable;
      console.log(`${TAG} portable launch copy: ${launchExecutable}`);
    }
    const launchPackagedProcess = () => {
      appExited = false;
      appLaunchError = null;
      child = spawn(
        IS_WINDOWS ? launchExecutable : electronBin,
        launchArgs,
        {
          cwd: IS_WINDOWS ? portableSetup.launchDir : tmpHome,
          env: IS_WINDOWS ? env : { ...env, DISPLAY },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !IS_WINDOWS,
        },
      );
      child.stdout.on('data', (d) => process.stdout.write(`${TAG}[app] ${d}`));
      child.stderr.on('data', (d) => process.stdout.write(`${TAG}[app-err] ${d}`));
      child.on('error', (err) => {
        appLaunchError = String(err?.stack || err);
        console.log(`${TAG}[startup-error] ${appLaunchError}`);
      });
      child.on('exit', (code, sig) => {
        appExited = true;
        console.log(`${TAG} app process exited (code=${code} sig=${sig})`);
      });
    };

    launchPackagedProcess();

    if (!(await waitForCdp(90_000))) {
      throw new Error(
        `${TAG} CDP endpoint never came up on port ${CDP_PORT}` +
          (appExited ? ' (the app process already exited — launch crash?)' : '') +
          (appLaunchError ? `: ${appLaunchError}` : ''),
      );
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

    let page = await waitForRendererPage(browser);
    attachPageDiagnostics(page);

    // ── 1. Renderer renders from the secure bundle scheme ───────────────────
    let rendered = false;
    let renderDetail = '';
    try {
      await waitForLoginScreenVisible(page, { timeoutMs: 60_000 });
      rendered = true;
        renderDetail = 'vault-setup password field visible';
    } catch (err) {
      const diagnostics = await collectRendererDiagnostics(page);
      renderDetail =
        `vault-setup password field never appeared; diagnostics: ` +
        JSON.stringify(diagnostics);
    }
    steps.push({
      name: 'packaged renderer renders from kyutxo-app://bundle',
      passed: rendered,
      detail: renderDetail,
    });
    if (!rendered) throw new Error(`${TAG} renderer is blank — aborting remaining checks.`);

    // ── 2. CSP arrives as a <meta> tag with the critical directives ─────────
    // Keep meta delivery as the cross-version enforcement source.
    const csp = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return meta ? meta.getAttribute('content') || '' : null;
    });
    const cspChecks =
      csp !== null &&
      csp.includes("require-trusted-types-for 'script'") &&
      csp.includes('trusted-types kyutxo-app default') &&
      csp.includes("'wasm-unsafe-eval'") &&
      /script-src [^;]*'self'/.test(csp) &&
      !/script-src [^;]*'unsafe-inline'/.test(csp) &&
      !/script-src [^;]*'unsafe-eval'(?!')/.test(csp.replace(/'wasm-unsafe-eval'/g, ''));
    steps.push({
      name: 'CSP <meta> tag present with critical directives (TT, allowlist, wasm-unsafe-eval, no inline/eval script)',
      passed: cspChecks,
      detail: csp === null ? 'meta CSP tag MISSING' : `meta CSP = ${JSON.stringify(csp)}`,
    });

    // ── 3. Inline <script> injection is blocked in-page ─────────────────────
    // NOTE: CDP Runtime.evaluate itself bypasses CSP eval restrictions, but an
    // appended <script> element executes as PAGE script, so CSP applies to it.
    // Trusted Types may also block the .textContent assignment itself — that
    // is enforcement too.
    const inlineProbe = await page.evaluate(async () => {
      window.__inline_probe__ = undefined;
      let violation = null;
      const onViolation = (e) => {
        violation = `${e.violatedDirective}: ${String(e.blockedURI || e.sample || '').slice(0, 80)}`;
      };
      document.addEventListener('securitypolicyviolation', onViolation);
      let assignBlocked = null;
      try {
        const s = document.createElement('script');
        try {
          s.textContent = 'window.__inline_probe__ = "ran";';
        } catch (err) {
          assignBlocked = String((err && err.message) || err);
        }
        if (assignBlocked === null) document.body.appendChild(s);
      } catch (err) {
        assignBlocked = assignBlocked || String((err && err.message) || err);
      }
      await new Promise((r) => setTimeout(r, 300));
      document.removeEventListener('securitypolicyviolation', onViolation);
      return { executed: window.__inline_probe__ === 'ran', violation, assignBlocked };
    });
    steps.push({
      name: 'inline <script> injection is blocked in the packaged renderer',
      passed: !inlineProbe.executed && (inlineProbe.violation !== null || inlineProbe.assignBlocked !== null),
      detail: `executed=${inlineProbe.executed}, violation=${JSON.stringify(inlineProbe.violation)}, assignBlocked=${JSON.stringify(inlineProbe.assignBlocked)}`,
    });

    // ── 4. Trusted Types enforcement is active ──────────────────────────────
    const tt = await page.evaluate(() => {
      if (!('trustedTypes' in window)) return { state: 'api-missing' };
      const probe = document.createElement('div');
      try {
        probe.innerHTML = '<span>raw</span>';
        return probe.querySelector('span') ? { state: 'raw-allowed' } : { state: 'blocked-silently' };
      } catch (err) {
        return { state: 'blocked', message: String((err && err.message) || err) };
      }
    });
    steps.push({
      name: 'Trusted Types enforcement active (raw innerHTML assignment rejected)',
      passed: tt.state === 'blocked' || tt.state === 'blocked-silently',
      detail: `probe = ${tt.state}${tt.message ? ` (${tt.message})` : ''}`,
    });

    // ── 5. WebAssembly compiles (Argon2id KDF requires 'wasm-unsafe-eval') ──
    const wasm = await page.evaluate(async () => {
      try {
        const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        await WebAssembly.compile(bytes.buffer);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: String((err && err.message) || err) };
      }
    });
    steps.push({
      name: "WebAssembly compiles in the packaged renderer ('wasm-unsafe-eval')",
      passed: wasm.ok,
      detail: wasm.ok ? 'trivial module compiled' : `compile failed: ${wasm.message}`,
    });

    // ── 6. Bundle scheme refuses arbitrary local filesystem reads ──────────
    const boundaryProbe = await page.evaluate(
      async ({ appUrl, fileUrl, secret }) => {
        const read = async (url) => {
          try {
            const response = await fetch(url);
            return { ok: response.ok, status: response.status, text: await response.text() };
          } catch (error) {
            return { ok: false, status: 0, text: String(error?.message || error) };
          }
        };
        return {
          appPath: await read(appUrl),
          filePath: await read(fileUrl),
          secret,
        };
      },
      {
        appUrl: `kyutxo-app://bundle/${encodeURIComponent(outsideSentinel)}`,
        fileUrl: pathToFileURL(outsideSentinel).href,
        secret: outsideSentinelText,
      },
    );
    const filesystemRefused =
      !boundaryProbe.appPath.text.includes(boundaryProbe.secret) &&
      !boundaryProbe.filePath.text.includes(boundaryProbe.secret) &&
      !boundaryProbe.filePath.ok;
    steps.push({
      name: 'packaged renderer cannot read arbitrary filesystem paths',
      passed: filesystemRefused,
      detail:
        `custom-scheme status=${boundaryProbe.appPath.status}; ` +
        `file fetch status=${boundaryProbe.filePath.status}`,
    });

    // ── 7. Validated main-process proxy reaches a configured local provider ─
    const directProviderFetch = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url);
        return { reached: true, status: response.status };
      } catch (error) {
        return { reached: false, error: String(error?.message || error) };
      }
    }, `${providerBaseUrl}/blocks/tip/height`);
    steps.push({
      name: 'packaged CSP blocks direct renderer provider requests',
      passed: directProviderFetch.reached === false,
      detail: directProviderFetch.reached
        ? `direct fetch unexpectedly returned ${directProviderFetch.status}`
        : directProviderFetch.error,
    });

    const providerProbe = await page.evaluate(async (baseUrl) => {
      const settings = await window.electronAPI.torUpdateSettings({
        customProviderUrl: baseUrl,
        trustedLocalHosts: ['127.0.0.1'],
      });
      const response = await window.electronAPI.torRequest({
        url: `${baseUrl}/blocks/tip/height`,
        method: 'GET',
        timeout: 5000,
      });
      return { settings, response };
    }, providerBaseUrl);
    steps.push({
      name: 'custom provider connectivity uses the validated main-process proxy',
      passed:
        providerProbe.settings.success === true &&
        providerProbe.response.success === true &&
        String(providerProbe.response.data) === '840000',
      detail:
        `settings=${providerProbe.settings.success}; request=${providerProbe.response.success}; ` +
        `height=${String(providerProbe.response.data)}`,
    });

    // ── 8. Production permissions allow video only on the QR route ──────────
    const mediaPermissions = await page.evaluate(async () => {
      const attempt = async (constraints) => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          stream.getTracks().forEach((track) => track.stop());
          return 'granted';
        } catch (error) {
          return String(error?.name || error?.message || error);
        }
      };
      const outsideCamera = await attempt({ video: true });
      window.location.hash = '#/scanner';
      await new Promise((resolve) => setTimeout(resolve, 250));
      const qrCamera = await attempt({ video: true });
      const qrMicrophone = await attempt({ audio: true });
      const qrMixed = await attempt({ audio: true, video: true });
      window.location.hash = '#/';
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { outsideCamera, qrCamera, qrMicrophone, qrMixed };
    });
    steps.push({
      name: 'production media permissions allow camera only in the QR workflow',
      passed:
        mediaPermissions.outsideCamera === 'NotAllowedError' &&
        mediaPermissions.qrCamera !== 'NotAllowedError' &&
        mediaPermissions.qrMicrophone === 'NotAllowedError' &&
        mediaPermissions.qrMixed === 'NotAllowedError',
      detail: JSON.stringify(mediaPermissions),
    });

    // ── 9. Production reload shortcut is disabled ──────────────────────────
    await page.evaluate(() => {
      window.__packaged_reload_guard__ = 'still-here';
    });
    await page.keyboard.press(IS_WINDOWS ? 'Control+R' : 'Control+R');
    await sleep(750);
    const reloadGuard = await page.evaluate(() => window.__packaged_reload_guard__).catch(() => null);
    steps.push({
      name: 'production reload shortcut is unavailable',
      passed: reloadGuard === 'still-here',
      detail: `renderer marker=${String(reloadGuard)}`,
    });

    await page.evaluate(() => {
      const source = document.createElement('textarea');
      const target = document.createElement('textarea');
      source.value = 'copy-paste-still-works';
      document.body.append(source, target);
      source.focus();
      source.select();
    });
    await page.keyboard.press('Control+C');
    await page.evaluate(() => {
      const textareas = document.querySelectorAll('textarea');
      textareas[textareas.length - 1]?.focus();
    });
    await page.keyboard.press('Control+V');
    const pastedText = await page.evaluate(() => {
      const textareas = document.querySelectorAll('textarea');
      const value = textareas[textareas.length - 1]?.value || '';
      textareas.forEach((node) => node.remove());
      return value;
    });
    steps.push({
      name: 'normal copy and paste shortcuts remain available',
      passed: pastedText === 'copy-paste-still-works',
      detail: `pasted=${JSON.stringify(pastedText)}`,
    });

    // ── 10. Idle lifecycle signal locks through AuthContext without reload ──
    let idleNavigations = 0;
    const countIdleNavigation = () => {
      idleNavigations += 1;
    };
    page.on('framenavigated', countIdleNavigation);
    await page.evaluate(() => {
      window.__idle_document_guard__ = 'same-document';
    });
    const unlockedForIdleCheck = await unlockIfNeeded(page, PORTABLE_CHECK_PASSWORD, {
      appearTimeoutMs: 60_000,
      submitTimeoutMs: 60_000,
      label: 'idle-lock',
    });
    let idleLocked = false;
    let idleLockDetail = '';
    try {
      await waitForExistingVaultLoginScreen(page, { timeoutMs: 20_000 });
      const documentGuard = await page.evaluate(() => window.__idle_document_guard__).catch(() => null);
      idleLocked = documentGuard === 'same-document' && idleNavigations === 0;
      idleLockDetail =
        `login returned; marker=${String(documentGuard)}; navigations=${idleNavigations}`;
    } catch (error) {
      idleLockDetail = String(error?.message || error);
    }
    page.off('framenavigated', countIdleNavigation);
    steps.push({
      name: 'idle lifecycle event locks the vault without reloading the document',
      passed: unlockedForIdleCheck && idleLocked,
      detail: idleLockDetail,
    });

    if (IS_WINDOWS) {
      // Unlocking the vault before shutdown makes this a real persistence check.
      const created = await unlockIfNeeded(page, PORTABLE_CHECK_PASSWORD, {
        appearTimeoutMs: 60_000,
        submitTimeoutMs: 60_000,
        label: 'portable-restart',
      });
      steps.push({
        name: 'portable wrapper creates a small vault',
        passed: created,
        detail: created ? 'vault setup completed' : 'vault setup form was not available',
      });
      if (!created) {
        throw new Error(`${TAG} portable vault setup did not run on the fresh launch.`);
      }

      await browser.close().catch(() => {});
      browser = null;
      await stopPackagedProcess(child);
      child = null;
      if (!(await waitForCdpDown(30_000))) {
        throw new Error(`${TAG} first portable app process still owns CDP port ${CDP_PORT}.`);
      }

      const portableDataDir = path.join(portableSetup.launchDir, 'KYUTXO_Data');
      const portableDataFiles = countRegularFiles(portableDataDir);
      const portableDataIsIsolated =
        fs.existsSync(portableDataDir) &&
        portableDataFiles > 0 &&
        isPathWithin(portableSetup.launchDir, portableDataDir) &&
        isPathWithin(tmpHome, portableDataDir);
      steps.push({
        name: 'portable vault data is written under the disposable executable directory',
        passed: portableDataIsIsolated,
        detail: `${portableDataDir} contains ${portableDataFiles} regular file(s)`,
      });
      if (!portableDataIsIsolated) {
        throw new Error(
          `${TAG} portable data was not found under the disposable launch directory ` +
            `(${portableDataDir}; files=${portableDataFiles}).`,
        );
      }

      // Launch the exact same copied wrapper again from the same directory.
      // PORTABLE_EXECUTABLE_DIR is derived by the wrapper, so this proves the
      // second process resolves the same beside-the-executable data location.
      console.log(`${TAG} relaunching the same portable wrapper: ${launchExecutable}`);
      launchPackagedProcess();
      if (!(await waitForCdp(90_000))) {
        throw new Error(
          `${TAG} CDP endpoint never came up after portable restart on port ${CDP_PORT}` +
            (appExited ? ' (the app process already exited — launch crash?)' : '') +
            (appLaunchError ? `: ${appLaunchError}` : ''),
        );
      }
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      page = await waitForRendererPage(browser);
      attachPageDiagnostics(page);

      let existingVaultLogin = false;
      let existingVaultDetail = '';
      try {
        await waitForExistingVaultLoginScreen(page, { timeoutMs: 60_000 });
        existingVaultLogin = true;
        existingVaultDetail = 'password field visible; setup confirmation field absent';
      } catch (err) {
        existingVaultDetail = String(err?.message || err);
      }
      steps.push({
        name: 'portable vault survives restart (login shown without create-vault confirmation)',
        passed: existingVaultLogin,
        detail: existingVaultDetail,
      });
      if (!existingVaultLogin) {
        throw new Error(`${TAG} portable restart did not show the existing-vault login screen.`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopPackagedProcess(child);
    await new Promise((resolve) => providerFixture.close(resolve));
    if (xvfb) {
      try {
        process.kill(-xvfb.pid, 'SIGTERM');
      } catch {
        try {
          xvfb.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    try {
      fs.rmSync(tmpHome, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250,
      });
      if (fs.existsSync(tmpHome)) {
        throw new Error(`${TAG} disposable directory still exists after cleanup: ${tmpHome}`);
      }
      console.log(`${TAG} removed disposable portable/profile directory`);
    } catch (err) {
      console.error(`${TAG}[cleanup-error] could not remove disposable directory: ${err.stack || err}`);
      throw err;
    }
  }

  console.log(`\n${TAG} Results:`);
  for (const s of steps) {
    console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
  }
  const failed = steps.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\n${TAG} ${failed.length}/${steps.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n${TAG} all ${steps.length} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
