// Shared guard for packaged-app verification scripts (task 1925).
//
// Problem: `npm run build` has been observed to "succeed" without actually
// refreshing dist/public, so electron-builder packaged a MONTHS-stale renderer
// bundle and the packaged checks reported phantom bugs (or false passes)
// against pre-fix JS. See .agents/memory/stale-dev-bundle-e2e.md.
//
// assertPackagedBundleFresh({ tag }) fails fast when the built renderer
// bundle (dist/public/assets/index-*.js) is OLDER than the newest renderer
// source file (client/src, client/index.html, shared/, vite.config.ts).
// Call it after the build step (and in KYUTXO_PACKAGED_SKIP_BUILD reuse
// paths) in every packaged check script — do not copy-paste the logic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Derives the repo root from this module's URL. MUST use fileURLToPath:
 * `new URL(import.meta.url).pathname` yields `/D:/a/.../scripts/x.mjs` on
 * Windows, which path.win32.resolve mangles into `\\D:\a\repo` — readdirSync
 * then throws (silently caught below) and the guard reports a missing bundle
 * even though the build emitted one (windows-2022 CI break, task 2017).
 *
 * Exported so the node --test suite can pin the win32-style input behaviour.
 */
export function repoRootFromModuleUrl(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
}

// Exported for the landmark regression test (a platform-naive derivation must
// fail the suite on any OS instead of only surfacing on a Windows runner).
export const ROOT = repoRootFromModuleUrl(import.meta.url);

// Directories that never contain renderer source.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release']);

function newestMtimeInTree(dir) {
  let newest = { mtimeMs: 0, file: null };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeInTree(full);
      if (sub.mtimeMs > newest.mtimeMs) newest = sub;
    } else if (entry.isFile()) {
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs > newest.mtimeMs) newest = { mtimeMs: st.mtimeMs, file: full };
    }
  }
  return newest;
}

/**
 * Throws with a clear message when dist/public predates the current renderer
 * source. Returns the compared timestamps on success (useful for logging).
 *
 * @param {{ tag?: string, root?: string }} [opts]
 */
export function assertPackagedBundleFresh(opts = {}) {
  const tag = opts.tag || '[bundle-freshness]';
  const root = opts.root || ROOT;

  const assetsDir = path.join(root, 'dist', 'public', 'assets');
  let bundleFiles = [];
  try {
    bundleFiles = fs
      .readdirSync(assetsDir)
      .filter((n) => /^index-.*\.js$/.test(n))
      .map((n) => path.join(assetsDir, n));
  } catch {
    /* handled below */
  }
  if (bundleFiles.length === 0) {
    throw new Error(
      `${tag} no dist/public/assets/index-*.js bundle found — run \`npx vite build\` (or \`npm run build\`) before the packaged check.`,
    );
  }
  let bundle = { mtimeMs: 0, file: null };
  for (const f of bundleFiles) {
    const st = fs.statSync(f);
    if (st.mtimeMs > bundle.mtimeMs) bundle = { mtimeMs: st.mtimeMs, file: f };
  }

  const sourceRoots = [
    path.join(root, 'client', 'src'),
    path.join(root, 'shared'),
  ];
  let source = { mtimeMs: 0, file: null };
  for (const dir of sourceRoots) {
    const sub = newestMtimeInTree(dir);
    if (sub.mtimeMs > source.mtimeMs) source = sub;
  }
  for (const f of [path.join(root, 'client', 'index.html'), path.join(root, 'vite.config.ts')]) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs > source.mtimeMs) source = { mtimeMs: st.mtimeMs, file: f };
    } catch {
      /* optional */
    }
  }
  if (!source.file) {
    throw new Error(`${tag} could not find any renderer source files under client/src or shared/.`);
  }

  if (bundle.mtimeMs < source.mtimeMs) {
    const fmt = (ms) => new Date(ms).toISOString();
    throw new Error(
      `${tag} STALE BUNDLE: ${path.relative(root, bundle.file)} (built ${fmt(bundle.mtimeMs)}) ` +
        `predates source ${path.relative(root, source.file)} (modified ${fmt(source.mtimeMs)}). ` +
        `The packaged app would test months-old code. Rebuild the renderer first: ` +
        `\`rm -rf dist/public && npx vite build\` (then re-run electron-builder / this check ` +
        `without KYUTXO_PACKAGED_SKIP_BUILD).`,
    );
  }

  console.log(
    `${tag} bundle freshness OK: ${path.relative(root, bundle.file)} ` +
      `(built ${new Date(bundle.mtimeMs).toISOString()}) is newer than the latest source change ` +
      `(${path.relative(root, source.file)}).`,
  );
  return { bundle, source };
}

/**
 * Sibling guard for reused asars (task 1959): a KYUTXO_PACKAGED_SKIP_BUILD=1
 * run can also carry a stale MAIN PROCESS. electron-builder packages
 * `electron/**` and `dist/**` into app.asar, so edits to electron/*.cjs (CSP
 * meta tag, protocol.handle asset remap, IPC handlers) after the asar was
 * built would go untested. Fails fast when the reused asar predates the
 * newest electron/ source file OR the newest file in dist/public.
 *
 * Call it in every KYUTXO_PACKAGED_SKIP_BUILD reuse path, right after (or
 * alongside) assertPackagedBundleFresh.
 *
 * @param {{ tag?: string, root?: string, asarPath: string }} opts
 */
export function assertPackagedAsarFresh(opts) {
  const tag = (opts && opts.tag) || '[asar-freshness]';
  const root = (opts && opts.root) || ROOT;
  const asarPath = opts && opts.asarPath;
  if (!asarPath) {
    throw new Error(`${tag} assertPackagedAsarFresh requires an asarPath.`);
  }

  let asarStat;
  try {
    asarStat = fs.statSync(asarPath);
  } catch {
    throw new Error(
      `${tag} asar not found at ${path.relative(root, asarPath)} — run electron-builder before the packaged check.`,
    );
  }

  // Newest input the asar was packaged from: electron/ main-process source
  // (electron-builder packages electron/**/*) and the built renderer output
  // in dist/public.
  let newestInput = { mtimeMs: 0, file: null };
  for (const dir of [path.join(root, 'electron'), path.join(root, 'dist', 'public')]) {
    const sub = newestMtimeInTree(dir);
    if (sub.mtimeMs > newestInput.mtimeMs) newestInput = sub;
  }
  if (!newestInput.file) {
    throw new Error(`${tag} could not find any files under electron/ or dist/public to compare against.`);
  }

  if (asarStat.mtimeMs < newestInput.mtimeMs) {
    const fmt = (ms) => new Date(ms).toISOString();
    throw new Error(
      `${tag} STALE ASAR: ${path.relative(root, asarPath)} (packaged ${fmt(asarStat.mtimeMs)}) ` +
        `predates ${path.relative(root, newestInput.file)} (modified ${fmt(newestInput.mtimeMs)}). ` +
        `The reused asar would test a stale desktop-app shell (main process / renderer bundle). ` +
        `Rebuild the package first: re-run this check WITHOUT KYUTXO_PACKAGED_SKIP_BUILD ` +
        `(or run electron-builder --dir again after \`npx vite build\`).`,
    );
  }

  console.log(
    `${tag} asar freshness OK: ${path.relative(root, asarPath)} ` +
      `(packaged ${new Date(asarStat.mtimeMs).toISOString()}) is newer than the latest ` +
      `electron/ + dist/public change (${path.relative(root, newestInput.file)}).`,
  );
  return { asar: { mtimeMs: asarStat.mtimeMs, file: asarPath }, source: newestInput };
}
