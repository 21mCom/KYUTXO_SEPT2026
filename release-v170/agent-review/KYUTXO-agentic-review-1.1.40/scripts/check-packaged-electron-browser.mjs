#!/usr/bin/env node
// Packaged-desktop-app regression guard: the electron-builder asar must not
// ship with a blank window again.
//
// Task 1781 background: Vite emits absolute `/assets/...` URLs which 404 under
// `file://`, so the packaged renderer never loaded (blank window). The fix is a
// `protocol.handle('file')` fallback in electron/main.cjs that remaps missing
// absolute paths into dist/public, plus CSP injected as a <meta> tag (Chromium
// IGNORES CSP response headers on file:// documents). Any of the following can
// silently regress: a Vite output-layout change, a handler edit, a CSP edit.
//
// This check builds the real electron-builder output, launches it under the
// nix Electron runtime with Xvfb + CDP on Linux (recipe:
// .agents/memory/packaged-electron-verify.md), or launches the unpacked
// shipping executable with CDP on Windows, and asserts in the live packaged
// renderer:
//   1. The renderer actually renders (vault-setup form visible) — proves the
//      /assets remap works, since the app JS/CSS only load through it.
//   2. The CSP <meta> tag is present in the served document and carries the
//      security-critical directives (require-trusted-types-for, trusted-types
//      allowlist, wasm-unsafe-eval, no unsafe-inline in script-src).
//   3. Inline <script> injection is actually blocked in-page.
//   4. Trusted Types enforcement is active (raw innerHTML assignment throws).
//   5. WebAssembly compiles (the Argon2id KDF needs 'wasm-unsafe-eval').
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
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { waitForLoginScreenVisible } from './browser-check-utils.mjs';
import {
  assertPackagedBundleFresh,
  assertPackagedAsarFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  console.log(`${TAG} $ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
  });
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

async function main() {
  buildAsar();

  let electronBin = null;
  let xvfbBin = null;
  if (IS_WINDOWS) {
    if (!fs.existsSync(PACKAGED_EXECUTABLE)) {
      throw new Error(
        `${TAG} packaged Windows executable is missing: ${PACKAGED_EXECUTABLE}`,
      );
    }
    console.log(`${TAG} shipping executable: ${PACKAGED_EXECUTABLE}`);
  } else {
    ({ electronBin, xvfbBin } = findPackagedBinaries({ tag: TAG }));
    console.log(`${TAG} electron: ${electronBin}`);
    console.log(`${TAG} Xvfb: ${xvfbBin}`);
  }

  // Fresh, isolated profile: Replit points XDG_CONFIG_HOME etc. at the
  // workspace, which would persist vault state across "fresh" runs.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-check-'));
  const userDataDir = path.join(tmpHome, 'user-data');
  fs.mkdirSync(userDataDir, { recursive: true });
  // A portable executable can inherit this variable from a runner. Do not
  // allow an inherited portable directory to defeat the isolated profile.
  const { PORTABLE_EXECUTABLE_DIR: _portableExecutableDir, ...inheritedEnv } = process.env;
  const env = {
    ...inheritedEnv,
    HOME: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
    XDG_CACHE_HOME: path.join(tmpHome, '.cache'),
    XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(tmpHome, '.local', 'state'),
    NODE_ENV: 'production',
  };
  if (IS_WINDOWS) {
    // Electron's --user-data-dir is authoritative, while these keep any
    // Windows profile fallbacks inside the same disposable directory.
    env.USERPROFILE = tmpHome;
    env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(tmpHome, 'AppData', 'Local');
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
        `--user-data-dir=${userDataDir}`,
        '--disable-gpu',
        `--remote-debugging-port=${CDP_PORT}`,
      ]
    : [ASAR, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`];
  const child = spawn(
    IS_WINDOWS ? PACKAGED_EXECUTABLE : electronBin,
    launchArgs,
    {
      cwd: tmpHome,
      env: IS_WINDOWS ? env : { ...env, DISPLAY },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WINDOWS,
    },
  );
  child.stdout.on('data', (d) => process.stdout.write(`${TAG}[app] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`${TAG}[app-err] ${d}`));
  let appExited = false;
  let appLaunchError = null;
  child.on('error', (err) => {
    appLaunchError = String(err?.stack || err);
    console.log(`${TAG}[startup-error] ${appLaunchError}`);
  });
  child.on('exit', (code, sig) => {
    appExited = true;
    console.log(`${TAG} app process exited (code=${code} sig=${sig})`);
  });

  const steps = [];
  let browser = null;
  try {
    if (!(await waitForCdp(90_000))) {
      throw new Error(
        `${TAG} CDP endpoint never came up on port ${CDP_PORT}` +
          (appExited ? ' (the app process already exited — launch crash?)' : '') +
          (appLaunchError ? `: ${appLaunchError}` : ''),
      );
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

    // Find the file:// renderer page (retry: window may still be creating).
    let page = null;
    const deadline = Date.now() + 60_000;
    while (!page && Date.now() < deadline) {
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          if (p.url().startsWith('file://')) page = p;
        }
      }
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error(`${TAG} no file:// renderer page appeared within 60s.`);
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

    // ── 1. Renderer renders (proves the /assets file-protocol remap works) ──
    // A fresh profile shows the Create Vault form; the app JS only executes if
    // Vite's absolute /assets URLs were remapped into dist/public.
    let rendered = false;
    let renderDetail = '';
    try {
      await waitForLoginScreenVisible(page, { timeoutMs: 60_000 });
      rendered = true;
        renderDetail = 'vault-setup password field visible';
    } catch (err) {
      const bodyText = await page
        .evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : '<no body>'))
        .catch(() => '<evaluate failed>');
      renderDetail = `vault-setup password field never appeared; body text: ${JSON.stringify(bodyText)}`;
    }
    steps.push({
      name: 'packaged renderer renders (no blank window; /assets remap works)',
      passed: rendered,
      detail: renderDetail,
    });
    if (!rendered) throw new Error(`${TAG} renderer is blank — aborting remaining checks.`);

    // ── 2. CSP arrives as a <meta> tag with the critical directives ─────────
    // Chromium ignores CSP response HEADERS on file:// documents, so the meta
    // tag is the only delivery that counts.
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
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (IS_WINDOWS) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    await sleep(2000);
    if (IS_WINDOWS) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
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
    fs.rmSync(tmpHome, { recursive: true, force: true });
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
