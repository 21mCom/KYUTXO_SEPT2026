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
// This check builds the real electron-builder asar, launches it under the nix
// Electron runtime with Xvfb + CDP (recipe: .agents/memory/packaged-electron-verify.md),
// and asserts in the live packaged renderer:
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
//     Reuses an existing release/linux-unpacked/resources/app.asar (fails if absent).
//
// Requirements (all present in this Replit environment):
//   - a nix Electron 29.x store path (upstream Electron >=~39 binaries crash
//     with "Floating point exception" here) — override via KYUTXO_ELECTRON_BIN
//   - a nix xorg-server store path providing Xvfb — override via KYUTXO_XVFB_BIN.
//     (The nix `xvfb-run` wrapper bundles an ancient xorg-server 1.20 whose
//     Xvfb segfaults in this environment — launch a modern Xvfb directly.)
//   - playwright-core (driving via CDP connectOverCDP)

import { chromium } from 'playwright-core';
import { execSync, spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  assertPackagedBundleFresh,
  assertPackagedAsarFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';

await acquireBrowserCheckLock();

// Windows-safe (fileURLToPath): `new URL(...).pathname` is `/D:/...` on win32
// and path.resolve mangles it — see repoRootFromModuleUrl.
const ROOT = repoRootFromModuleUrl(import.meta.url);
const ASAR = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');
const CDP_PORT = Number(process.env.KYUTXO_PACKAGED_CDP_PORT || 9223);
const TAG = '[packaged-electron]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findNixBinary({ envVar, storeGlobs, binName, requirement }) {
  if (process.env[envVar]) return process.env[envVar];
  for (const glob of storeGlobs) {
    let entries = [];
    try {
      entries = fs
        .readdirSync('/nix/store')
        .filter((n) => glob.test(n))
        .sort()
        .reverse(); // prefer the newest-looking version
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join('/nix/store', entry, 'bin', binName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  throw new Error(
    `${TAG} could not find ${binName} (${requirement}). Set ${envVar} to override.`,
  );
}

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
    '--linux',
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

  const electronBin = findNixBinary({
    envVar: 'KYUTXO_ELECTRON_BIN',
    // Upstream electron >=~39 crashes with a floating point exception in this
    // environment; the nix electron 29.x runs the asar fine.
    storeGlobs: [/-electron-29\./],
    binName: 'electron',
    requirement: 'nix electron 29.x — upstream Electron binaries FPE-crash here',
  });
  const xvfbBin = findNixBinary({
    envVar: 'KYUTXO_XVFB_BIN',
    // Modern xorg-server Xvfb works; the one bundled inside nix xvfb-run
    // (xorg-server 1.20) segfaults the whole session in this environment.
    storeGlobs: [/-xorg-server-21\./, /-xorg-server-2\d\./],
    binName: 'Xvfb',
    requirement: 'nix xorg-server Xvfb (xvfb-run\u2019s bundled 1.20 Xvfb segfaults here)',
  });
  console.log(`${TAG} electron: ${electronBin}`);
  console.log(`${TAG} Xvfb: ${xvfbBin}`);

  // Fresh, isolated profile: Replit points XDG_CONFIG_HOME etc. at the
  // workspace, which would persist vault state across "fresh" runs.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-check-'));
  const env = {
    ...process.env,
    HOME: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
    XDG_CACHE_HOME: path.join(tmpHome, '.cache'),
    XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(tmpHome, '.local', 'state'),
    NODE_ENV: 'production',
  };

  const DISPLAY = process.env.KYUTXO_PACKAGED_DISPLAY || ':99';
  console.log(`${TAG} starting Xvfb on ${DISPLAY}...`);
  const xvfb = spawn(xvfbBin, [DISPLAY, '-screen', '0', '1280x800x24'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  xvfb.stderr.on('data', (d) => process.stdout.write(`${TAG}[xvfb] ${d}`));
  await sleep(2000);

  console.log(`${TAG} launching packaged app on ${DISPLAY} (CDP port ${CDP_PORT})...`);
  const child = spawn(
    electronBin,
    [ASAR, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: tmpHome,
      env: { ...env, DISPLAY },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  child.stdout.on('data', (d) => process.stdout.write(`${TAG}[app] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`${TAG}[app-err] ${d}`));
  let appExited = false;
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
          (appExited ? ' (the app process already exited — launch crash?)' : ''),
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

    // ── 1. Renderer renders (proves the /assets file-protocol remap works) ──
    // A fresh profile shows the Create Vault form; the app JS only executes if
    // Vite's absolute /assets URLs were remapped into dist/public.
    let rendered = false;
    let renderDetail = '';
    try {
      await page.getByTestId('input-password').waitFor({ state: 'visible', timeout: 60_000 });
      rendered = true;
      renderDetail = 'vault-setup password input visible';
    } catch (err) {
      const bodyText = await page
        .evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : '<no body>'))
        .catch(() => '<evaluate failed>');
      renderDetail = `input-password never appeared; body text: ${JSON.stringify(bodyText)}`;
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
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await sleep(2000);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      process.kill(-xvfb.pid, 'SIGTERM');
    } catch {
      try {
        xvfb.kill('SIGTERM');
      } catch {
        /* already gone */
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
