#!/usr/bin/env node

// Rewrites internal Replit "package-firewall.replit.local" download URLs in
// package-lock.json to the canonical npm registry tarball form:
//   https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz
// (<name> keeps any @scope/ prefix; <basename> drops it).
//
// The name/version are derived from each lockfile entry — never a host-only
// string replacement, which produces malformed URLs that 404 on the real
// registry (see scripts/check-lockfile-urls.js class 2).
//
// After rewriting it:
//   1. re-runs scripts/check-lockfile-urls.js
//   2. verifies each rewritten URL actually fetches (HTTP HEAD/GET probe)
//
// Usage: node scripts/fix-lockfile-urls.mjs [--no-verify]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const LOCKFILE = path.resolve(ROOT, 'package-lock.json');
const CHECK_SCRIPT = path.resolve(ROOT, 'scripts', 'check-lockfile-urls.js');
const FORBIDDEN = 'package-firewall.replit.local';
const REGISTRY = 'https://registry.npmjs.org';
const VERIFY = !process.argv.includes('--no-verify');

function fail(message) {
  console.error(`[fix-lockfile-urls] FAIL: ${message}`);
  process.exit(1);
}

function packageNameFromKey(key) {
  // packages keys look like "node_modules/foo" or
  // "node_modules/@scope/pkg/node_modules/bar" — the name is everything after
  // the LAST "node_modules/".
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx === -1) return null;
  const name = key.slice(idx + marker.length);
  return name.length > 0 ? name : null;
}

function canonicalTarballUrl(name, version) {
  const basename = name.startsWith('@') ? name.split('/')[1] : name;
  return `${REGISTRY}/${name}/-/${basename}-${version}.tgz`;
}

async function verifyUrl(url) {
  // Some registries reject HEAD; fall back to a ranged GET.
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        headers: method === 'GET' ? { Range: 'bytes=0-0' } : {},
      });
      if (res.ok || res.status === 206) {
        if (method === 'GET') {
          try { await res.body?.cancel(); } catch { /* ignore */ }
        }
        return true;
      }
      if (res.status === 405 && method === 'HEAD') continue; // try GET
      return false;
    } catch {
      if (method === 'GET') return false;
    }
  }
  return false;
}

async function main() {
  if (!fs.existsSync(LOCKFILE)) fail(`package-lock.json not found at ${LOCKFILE}`);

  const contents = fs.readFileSync(LOCKFILE, 'utf8');
  let lock;
  try {
    lock = JSON.parse(contents);
  } catch (error) {
    fail(`package-lock.json is not valid JSON: ${error.message}`);
  }

  const rewritten = [];
  const problems = [];

  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const resolved = entry && entry.resolved;
    if (typeof resolved !== 'string' || !resolved.includes(FORBIDDEN)) continue;

    const name = packageNameFromKey(key);
    const version = entry.version;
    if (!name) {
      problems.push(`${key || '(root)'}: cannot derive package name from lockfile key`);
      continue;
    }
    if (typeof version !== 'string' || version.length === 0) {
      problems.push(`${key}: entry has no version; cannot build canonical URL`);
      continue;
    }
    const url = canonicalTarballUrl(name, version);
    entry.resolved = url;
    rewritten.push({ key, name, version, url });
  }

  // Also catch firewall URLs anywhere outside packages[*].resolved (should not
  // happen, but never leave one behind silently).
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ${p}`);
    fail('some firewall URLs could not be rewritten (see above); fix these entries manually');
  }

  if (rewritten.length === 0) {
    console.log('[fix-lockfile-urls] No firewall URLs found in package-lock.json; nothing to do.');
  } else {
    const output = JSON.stringify(lock, null, 2) + '\n';
    if (output.includes(FORBIDDEN)) {
      fail(`rewritten lockfile still contains "${FORBIDDEN}" outside packages[*].resolved; inspect manually`);
    }
    fs.writeFileSync(LOCKFILE, output);
    console.log(`[fix-lockfile-urls] Rewrote ${rewritten.length} firewall URL(s):`);
    for (const r of rewritten) console.log(`  ${r.key} -> ${r.url}`);
  }

  // Re-run the checker on the (possibly) rewritten lockfile.
  const check = spawnSync(process.execPath, [CHECK_SCRIPT], { stdio: 'inherit' });
  if (check.status !== 0) {
    fail('scripts/check-lockfile-urls.js still fails after rewriting; inspect its output above');
  }

  // Verify the rewritten URLs actually fetch from the real registry.
  if (VERIFY && rewritten.length > 0) {
    console.log(`[fix-lockfile-urls] Verifying ${rewritten.length} rewritten URL(s) fetch from the registry...`);
    const CONCURRENCY = 8;
    const failures = [];
    const queue = [...rewritten];
    async function worker() {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!(await verifyUrl(item.url))) failures.push(item);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (failures.length > 0) {
      for (const f of failures) console.error(`  UNREACHABLE: ${f.key} -> ${f.url}`);
      fail(
        `${failures.length} rewritten URL(s) did not fetch from the registry. ` +
          'The lockfile HAS been rewritten, but do not commit until these resolve ' +
          '(check the package name/version, or network access to registry.npmjs.org).'
      );
    }
    console.log('[fix-lockfile-urls] All rewritten URLs fetch successfully.');
  } else if (!VERIFY && rewritten.length > 0) {
    console.log('[fix-lockfile-urls] Skipping URL verification (--no-verify).');
  }

  console.log('[fix-lockfile-urls] OK: package-lock.json is clean.');
}

main().catch((error) => fail(error.stack || String(error)));
