#!/usr/bin/env node
// Packaged native read-engine release gate (Task: confirm the packaged desktop
// app's native database engine actually loads after packaging).
//
// Why this exists: the packaged-renderer gate (check-packaged-electron-browser.mjs)
// deliberately does NOT exercise the native better-sqlite3 read-engine worker —
// it launches under the nix Electron 29 runtime and skips npmRebuild, so a
// packaging regression (asarUnpack pattern change, worker bundle path change,
// bundle dropped from the asar `files` globs) could ship a desktop app whose
// fast read engine silently fails to load while every other gate stays green.
//
// What this check proves, against the REAL electron-builder output layout:
//   1. The asar contains electron/engine/engine-worker.bundle.cjs (the exact
//      path electron/engine-handlers.cjs spawns via workerScriptPath()).
//   2. The better-sqlite3 native addon was asarUnpack'd: the .node binary is
//      present on disk under app.asar.unpacked (Electron cannot dlopen from
//      inside an asar; if the asarUnpack globs regress, this file vanishes).
//   3. The shipped bytes are actually LOADABLE: the asar (+ its .unpacked
//      sibling, which @electron/asar transparently re-inlines on extract) is
//      extracted to a scratch dir, and the extracted worker bundle is spawned
//      as a real worker_thread with a scratch dbPath. It must answer init /
//      status / integrityCheck over the correlation-id protocol and create the
//      SQLite file — i.e. require('better-sqlite3') resolved to the unpacked
//      addon and the addon opened a database.
//
// Runtime/ABI note: the worker is spawned under the packaged app's own binary
// with ELECTRON_RUN_AS_NODE=1 when that binary can run here, which matches the
// shipping ABI exactly (electron-builder's npmRebuild targets it). In this
// Replit environment upstream Electron binaries crash at startup (see
// .agents/memory/packaged-electron-verify.md), so the check falls back to the
// system Node — which is ABI-correct here precisely because the gate build
// packages with -c.npmRebuild=false (the .node stays the dev Node build).
// A real release build (scripts/electron-build.sh, npmRebuild on) runs the
// worker under the shipped Electron binary, so the ABI is exercised for real.
//
// CI mode (GitHub Actions, .github/workflows/build.yml): the full runner CAN
// start Electron and packages with npmRebuild on (Electron-ABI addon), so the
// system-Node fallback would be an ABI LIE there. Set
// KYUTXO_NATIVE_ENGINE_REQUIRE_ELECTRON=1 to demand the packaged-binary
// (ELECTRON_RUN_AS_NODE) runtime path: the check fails if the packaged binary
// is missing or crashes instead of falling back, proving the Electron-ABI
// addon genuinely loads under the shipping runtime.
//
// Usage:
//   node scripts/check-packaged-native-engine.mjs
//     Builds dist (only if missing), the worker bundle, and a --dir asar, then
//     asserts. Set KYUTXO_PACKAGED_SKIP_BUILD=1 to reuse an existing
//     release/<platform>-unpacked output (fails if absent) — e.g. right after
//     check-packaged-electron-browser.mjs (Linux) or the CI electron-builder
//     step (Windows) has already built it.

import { execFileSync, spawn } from 'node:child_process';
import {
  assertPackagedBundleFresh,
  assertPackagedAsarFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import {
  electronBuilderTargetArgs,
  expectedUnpackedDirectory,
  packagedTargetHelp,
  parsePackagedTargetArgs,
} from './packaged-targets.mjs';
import { extractAvailableAsarTree } from './packaged-asar-extract.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Windows-safe (fileURLToPath): `new URL(...).pathname` is `/D:/...` on win32
// and path.resolve mangles it — see repoRootFromModuleUrl.
const ROOT = repoRootFromModuleUrl(import.meta.url);
const HOST_PLATFORM = process.platform === 'win32' ? 'win' : process.platform;
if (process.argv.slice(2).includes('--help')) {
  console.log(packagedTargetHelp());
  process.exit(0);
}
const targetArgs = parsePackagedTargetArgs(process.argv.slice(2));
if (targetArgs.help) {
  console.log(packagedTargetHelp());
  process.exit(0);
}
const TARGET_PLATFORM = targetArgs.localDiagnostic ? HOST_PLATFORM : targetArgs.platform;
const TARGET_ARCH = targetArgs.localDiagnostic ? process.arch : targetArgs.arch;
// electron-builder's --dir/unpacked layout differs for macOS app bundles and
// arm64 outputs. An explicit override is accepted for CI extraction jobs.
const UNPACKED_DIR = targetArgs.unpackedDir
  ? path.resolve(targetArgs.unpackedDir)
  : expectedUnpackedDirectory(ROOT, TARGET_PLATFORM, TARGET_ARCH);
const REQUIRE_ELECTRON_RUNTIME =
  !targetArgs.localDiagnostic ||
  targetArgs.requireElectron ||
  process.env.KYUTXO_NATIVE_ENGINE_REQUIRE_ELECTRON === '1';
const RESOURCES = TARGET_PLATFORM === 'darwin'
  ? path.join(UNPACKED_DIR, 'KYUTXO.app', 'Contents', 'Resources')
  : path.join(UNPACKED_DIR, 'resources');
const ASAR = path.join(RESOURCES, 'app.asar');
const ASAR_UNPACKED = path.join(RESOURCES, 'app.asar.unpacked');
const WORKER_REL = path.join('electron', 'engine', 'engine-worker.bundle.cjs');
const NATIVE_REL = path.join(
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
const TAG = '[packaged-native-engine]';
const BUILD_COMMAND_TIMEOUT_MS = 15 * 60_000;

function run(cmd, args) {
  console.log(`${TAG} $ ${cmd} ${args.join(' ')}`);
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', timeout: BUILD_COMMAND_TIMEOUT_MS });
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || error?.killed === true) {
      throw new Error(`${TAG} timed out during package build command ${cmd} after ${BUILD_COMMAND_TIMEOUT_MS}ms`, {
        cause: error,
      });
    }
    throw error;
  }
}

function buildAsar() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) {
      throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} does not exist.`);
    }
    console.log(`${TAG} reusing existing asar: ${ASAR}`);
    // The reused asar was packaged from dist/public — fail fast if that
    // bundle predates the current source (task 1925 stale-bundle trap), or
    // if the asar itself predates electron/ main-process source or
    // dist/public (task 1959: stale shell = months-old CSP/remap/IPC code).
    assertPackagedBundleFresh({ tag: TAG });
    assertPackagedAsarFresh({ tag: TAG, asarPath: ASAR });
    return;
  }
  // dist is only rebuilt when missing: this gate cares about the electron/ +
  // node_modules packaging surface, not the renderer bundle contents (the
  // renderer gate covers those). The worker bundle is ALWAYS rebuilt so the
  // asar never carries a stale one.
  if (!fs.existsSync(path.join(ROOT, 'dist', 'public'))) {
    run('npm', ['run', 'build']);
  }
  // Even though this gate targets the electron/node_modules surface, the asar
  // still packages dist/public — refuse to package a stale renderer bundle
  // (task 1925: `npm run build` can "succeed" without refreshing dist/public).
  assertPackagedBundleFresh({ tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', [
    'electron-builder',
    '--config',
    'electron-builder.json',
    '--dir',
    ...electronBuilderTargetArgs(TARGET_PLATFORM, TARGET_ARCH),
    '-c.npmRebuild=false',
  ]);
  if (!fs.existsSync(ASAR)) {
    throw new Error(`${TAG} electron-builder finished but ${ASAR} was not produced.`);
  }
}

/** Locate the packaged app executable (extraMetadata.name = "kyutxo",
 *  productName = "KYUTXO"; Windows uses productName + .exe). */
function findPackagedBinary() {
  if (TARGET_PLATFORM === 'darwin') {
    const candidate = path.join(UNPACKED_DIR, 'KYUTXO.app', 'Contents', 'MacOS', 'KYUTXO');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }
  const names = TARGET_PLATFORM === 'win'
    ? ['KYUTXO.exe', 'kyutxo.exe']
    : ['kyutxo', 'KYUTXO'];
  for (const name of names) {
    const candidate = path.join(UNPACKED_DIR, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const DRIVER_SOURCE = `
// Spawns the extracted packaged worker bundle as a real worker_thread and
// drives the correlation-id protocol: init -> status -> integrityCheck.
// argv: [bundlePath, dbPath, expectedPlatform, expectedArch]
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');

const [bundlePath, dbPath, expectedPlatform, expectedArch] = process.argv.slice(2);
if (process.platform !== expectedPlatform || process.arch !== expectedArch) {
  console.error(
    'DRIVER-FAIL runtime target mismatch: expected=' + expectedPlatform + '/' + expectedArch +
    ' actual=' + process.platform + '/' + process.arch
  );
  process.exit(1);
}
const worker = new Worker(bundlePath, { workerData: { dbPath } });

const timer = setTimeout(() => {
  console.error('DRIVER-FAIL timeout waiting for worker responses');
  process.exit(1);
}, 60000);

let nextId = 1;
let done = false; // worker.terminate() exits the worker with code 1 — expected once done
const pending = new Map();
function call(type) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type });
  });
}

worker.on('message', (res) => {
  if (!res || typeof res.id !== 'number') return; // push events (finalizeProgress)
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  if (res.ok) p.resolve(res.result);
  else p.reject(new Error(res.error || 'worker returned ok:false'));
});
worker.on('error', (err) => {
  console.error('DRIVER-FAIL worker error: ' + (err && err.stack || err));
  process.exit(1);
});
worker.on('exit', (code) => {
  if (code !== 0 && !done) {
    console.error('DRIVER-FAIL worker exited early (code ' + code + ')');
    process.exit(1);
  }
});

(async () => {
  const init = await call('init');
  if (!init || typeof init.state !== 'string') {
    throw new Error('init returned no state snapshot: ' + JSON.stringify(init));
  }
  const status = await call('status');
  const integrity = await call('integrityCheck');
  if (!fs.existsSync(dbPath)) {
    throw new Error('worker answered but never created the SQLite file at ' + dbPath);
  }
  console.log(
    'DRIVER-OK init.state=' + init.state +
    ' status.state=' + (status && status.state) +
    ' integrity=' + JSON.stringify(integrity).slice(0, 200) +
    ' abi=' + process.versions.modules +
    ' runtime=' + (process.versions.electron ? 'electron ' + process.versions.electron : 'node ' + process.versions.node)
  );
  clearTimeout(timer);
  done = true;
  await worker.terminate();
  process.exit(0);
})().catch((err) => {
  console.error('DRIVER-FAIL ' + (err && err.stack || err));
  process.exit(1);
});
`;

function spawnDriver(runtime, driverPath, bundlePath, dbPath) {
  return new Promise((resolve) => {
    const expectedNodePlatform = TARGET_PLATFORM === 'win' ? 'win32' : TARGET_PLATFORM;
    const child = spawn(
      runtime.bin,
      [driverPath, bundlePath, dbPath, expectedNodePlatform, TARGET_ARCH],
      {
      cwd: ROOT,
      env: { ...process.env, ...runtime.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(`${TAG}[driver] ${d}`);
    });
    child.stderr.on('data', (d) => {
      out += d;
      process.stdout.write(`${TAG}[driver-err] ${d}`);
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('exit', (code, sig) => {
      clearTimeout(killTimer);
      resolve({ code, sig, out });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ code: -1, sig: null, out: String(err) });
    });
  });
}

async function main() {
  buildAsar();

  const asar = require('@electron/asar');
  const steps = [];
  steps.push({
    name: 'packaged target is explicit and supported',
    passed: true,
    detail: `${TARGET_PLATFORM}/${TARGET_ARCH}; unpacked=${path.relative(ROOT, UNPACKED_DIR)}`,
  });

  // ── 1. Worker bundle is inside the asar at the exact spawn path ──────────
  let bundleInAsar = false;
  let bundleDetail = '';
  try {
    const stat = asar.statFile(ASAR, WORKER_REL);
    bundleInAsar = !!stat && Number(stat.size) > 10_000; // a real bundle, not a stub
    bundleDetail = `size=${stat && stat.size}`;
  } catch (err) {
    bundleDetail = `statFile failed: ${err && err.message}`;
  }
  steps.push({
    name: `asar contains ${WORKER_REL} (path spawned by engine-handlers.cjs)`,
    passed: bundleInAsar,
    detail: bundleDetail,
  });

  // ── 2. Native addon is asarUnpack'd onto real disk ───────────────────────
  const nativeOnDisk = path.join(ASAR_UNPACKED, NATIVE_REL);
  const nativeExists = fs.existsSync(nativeOnDisk);
  steps.push({
    name: 'better_sqlite3.node present under app.asar.unpacked (asarUnpack globs intact)',
    passed: nativeExists,
    detail: nativeExists
      ? `size=${fs.statSync(nativeOnDisk).size}`
      : `MISSING: ${nativeOnDisk}`,
  });

  if (!bundleInAsar || !nativeExists) {
    report(steps);
    return;
  }

  // ── 3. Extract the shipped layout and actually run the worker ────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-native-engine-check-'));
  try {
    console.log(`${TAG} extracting asar (+ .unpacked) to ${tmp}/app ...`);
    // Electron Builder can leave optional package metadata in the asar header
    // while omitting its unpacked companion file. Extract every available entry
    // and report those absent optional files instead of letting extractAll abort
    // before the shipped worker and native addon can be exercised.
    extractAvailableAsarTree({
      asar,
      archivePath: ASAR,
      destination: path.join(tmp, 'app'),
      onMissingEntry: (entry) => {
        console.warn(`${TAG} skipping unavailable ASAR metadata entry: ${entry}`);
      },
    });
    const bundlePath = path.join(tmp, 'app', WORKER_REL);
    const extractedNative = path.join(tmp, 'app', NATIVE_REL);
    if (!fs.existsSync(bundlePath)) throw new Error(`extracted bundle missing: ${bundlePath}`);
    if (!fs.existsSync(extractedNative) || fs.statSync(extractedNative).size < 1000) {
      throw new Error(`extracted native addon missing/empty: ${extractedNative}`);
    }

    const driverPath = path.join(tmp, 'driver.cjs');
    fs.writeFileSync(driverPath, DRIVER_SOURCE);

    // Prefer the packaged app's own binary as the Node runtime (matches the
    // shipping ABI); fall back to system Node where that binary cannot run
    // (nix sandbox — upstream Electron crashes at startup here, and the gate
    // build's npmRebuild=false keeps the addon on the Node ABI anyway).
    const runtimes = [];
    const packagedBin = findPackagedBinary();
    if (packagedBin && process.env.KYUTXO_NATIVE_ENGINE_SKIP_ELECTRON !== '1') {
      runtimes.push({
        label: `packaged binary (ELECTRON_RUN_AS_NODE) ${packagedBin}`,
        bin: packagedBin,
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });
    }
    if (REQUIRE_ELECTRON_RUNTIME) {
      // CI / real-release mode: the addon was rebuilt for the Electron ABI
      // (npmRebuild on), so a system-Node fallback would either fail on ABI or
      // — worse — mask a broken packaged binary. Demand the real runtime.
      if (runtimes.length === 0) {
        throw new Error(
          `${TAG} KYUTXO_NATIVE_ENGINE_REQUIRE_ELECTRON=1 but no packaged binary was found in ${UNPACKED_DIR}`,
        );
      }
      console.log(`${TAG} REQUIRE_ELECTRON mode: system-Node fallback disabled.`);
    } else {
      runtimes.push({ label: `system node ${process.execPath}`, bin: process.execPath, env: {} });
    }

    let loaded = false;
    let loadDetail = '';
    for (const runtime of runtimes) {
      const dbPath = path.join(
        fs.mkdtempSync(path.join(tmp, 'scratch-')),
        'engine.sqlite',
      );
      console.log(`${TAG} spawning worker driver under: ${runtime.label}`);
      const res = await spawnDriver(runtime, driverPath, bundlePath, dbPath);
      if (res.code === 0 && res.out.includes('DRIVER-OK')) {
        loaded = true;
        loadDetail = `under ${runtime.label}: ${res.out.match(/DRIVER-OK[^\n]*/)?.[0] ?? 'ok'}`;
        break;
      }
      // An ABI mismatch surfaces as a load failure here — that is a REAL
      // failure when it happens under the matching runtime, so only fall
      // through when the runtime itself could not start (crash before the
      // worker reported anything driver-side).
      const runtimeCrashed = !res.out.includes('DRIVER-FAIL');
      loadDetail = `under ${runtime.label}: exit=${res.code} sig=${res.sig}; ${res.out
        .trim()
        .slice(-400)}`;
      if (!runtimeCrashed) break; // genuine worker/addon failure — do not mask with a fallback
      if (runtimes.indexOf(runtime) < runtimes.length - 1) {
        console.log(`${TAG} runtime crashed before the driver ran — trying next runtime.`);
      }
    }
    steps.push({
      name: REQUIRE_ELECTRON_RUNTIME
        ? 'extracted packaged worker bundle loads better-sqlite3 UNDER THE PACKAGED ELECTRON BINARY (ELECTRON_RUN_AS_NODE) and answers init/status/integrityCheck'
        : 'extracted packaged worker bundle loads better-sqlite3 and answers init/status/integrityCheck',
      passed: loaded,
      detail: loadDetail,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  report(steps);
}

function report(steps) {
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
