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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

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
