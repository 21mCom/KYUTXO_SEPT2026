#!/usr/bin/env node

// Guard: the Trusted Types default policy in client/src/lib/trusted-types.ts
// exact-match allowlists the static raw-string HTML sink inputs injected by
// third-party components we bundle. A dependency upgrade that changes those
// injected strings — or a NEW bundled dependency that starts injecting raw
// HTML sinks (dangerouslySetInnerHTML / innerHTML) — would only surface as a
// broken packaged build. This static guard:
//
//   1. Computes the set of packages actually reachable from client code
//      (bare imports in client/src intersected with package.json production
//      dependencies, plus their full transitive dependency closure), so a new
//      or upgraded dependency is covered automatically.
//   2. Scans every JS file those packages ship for HTML sink writes:
//      `dangerouslySetInnerHTML: { __html: ... }` and `.innerHTML = ...`.
//   3. Fails when a sink appears that is neither covered by
//      THIRD_PARTY_STATIC_SINK_ALLOWLIST nor recorded in the audited
//      KNOWN_SINKS baseline below — catching the drift at dependency-bump
//      time, before anything runs.
//
// Static dsih strings from the allowlisted Radix packages must exactly match
// the allowlist (both directions — missing AND stale entries fail).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const TRUSTED_TYPES_SOURCE = path.resolve(
  ROOT,
  'client/src/lib/trusted-types.ts',
);
const CLIENT_SRC = path.resolve(ROOT, 'client/src');
const PKG_JSON = path.resolve(ROOT, 'package.json');

// ---------------------------------------------------------------------------
// Audited baseline of third-party HTML sinks we know about and have reviewed.
//
// Keys are package names. For each package:
//   allowlistedDsih  — static dangerouslySetInnerHTML strings must exactly
//                      match THIRD_PARTY_STATIC_SINK_ALLOWLIST (the default
//                      policy admits them at runtime).
//   knownStaticInnerHTML — exact static `.innerHTML = "<literal>"` strings we
//                      audited. react-dom uses these for one-time feature
//                      detection / SVG innerHTML polyfill paths; they are NOT
//                      in the runtime allowlist — if one of those paths ever
//                      fired under enforcement the trusted-types browser
//                      check would catch it. Listed here so an upgrade that
//                      ADDS or CHANGES static sink strings fails this guard.
//   dynamicSinks     — true when the package contains non-static sink writes
//                      (template/expression values). Audited as either
//                      dead-in-our-usage or covered by the runtime browser
//                      check. A package NOT flagged here that grows a dynamic
//                      sink fails this guard.
//
// To update after a legitimate dependency bump: re-audit the new sink (does
// the code path run in our app? would the default policy reject it and break
// the UI?), then extend this baseline and/or the runtime allowlist in
// client/src/lib/trusted-types.ts, and re-run the trusted-types browser
// check.
// ---------------------------------------------------------------------------
const KNOWN_SINKS = {
  '@radix-ui/react-scroll-area': { allowlistedDsih: true },
  '@radix-ui/react-select': { allowlistedDsih: true },
  // react-dom: one-time feature detection ('<script></script>' Safari nonce
  // probe) and the SVG innerHTML polyfill container. Dynamic innerHTML writes
  // are the setInnerHTML fallback paths in the same modules.
  'react-dom': {
    knownStaticInnerHTML: [
      // Safari nonce feature probe; the SVG polyfill / setInnerHTML fallback
      // paths are string CONCATENATIONS and therefore counted as dynamic.
      '<script></script>',
    ],
    dynamicSinks: true,
  },
  // react-resizable-panels: injects a `*{cursor: ...}` <style> while
  // dragging (template literal — dynamic).
  'react-resizable-panels': { dynamicSinks: true },
  // jspdf / jspdf-autotable: html-to-pdf helper paths we never invoke
  // (we build PDFs programmatically).
  jspdf: { dynamicSinks: true },
  'jspdf-autotable': { dynamicSinks: true },
  // pdfjs-dist: only the pdf_viewer.mjs web-viewer component (not imported;
  // we use the core API + worker).
  'pdfjs-dist': { dynamicSinks: true },
  // @testing-library/react: test-only dependency, never in the app bundle.
  '@testing-library/react': { dynamicSinks: true },
};

const failures = [];

// --- 1. Parse the allowlist out of trusted-types.ts -----------------------

function parseAllowlist(sourceText) {
  const marker = 'THIRD_PARTY_STATIC_SINK_ALLOWLIST';
  const start = sourceText.indexOf(marker);
  if (start === -1) {
    failures.push(
      `${TRUSTED_TYPES_SOURCE}: could not find ${marker} — has it been renamed or moved?`,
    );
    return null;
  }
  const setOpen = sourceText.indexOf('new Set([', start);
  const setClose = sourceText.indexOf('])', setOpen);
  if (setOpen === -1 || setClose === -1) {
    failures.push(
      `${TRUSTED_TYPES_SOURCE}: ${marker} is no longer a \`new Set([...])\` literal — update this guard to match.`,
    );
    return null;
  }
  const body = sourceText.slice(setOpen + 'new Set(['.length, setClose);
  const entries = [];
  const literalRe = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = literalRe.exec(body)) !== null) {
    entries.push(JSON.parse(`"${m[1]}"`));
  }
  if (entries.length === 0) {
    failures.push(
      `${TRUSTED_TYPES_SOURCE}: parsed zero entries from ${marker} — update this guard's parser.`,
    );
    return null;
  }
  return entries;
}

// --- 2. Compute the bundled-dependency closure -----------------------------

function collectClientImportSpecifiers() {
  const specs = new Set();
  const importRe =
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        const text = fs.readFileSync(p, 'utf8');
        let m;
        while ((m = importRe.exec(text)) !== null) specs.add(m[1]);
      }
    }
  })(CLIENT_SRC);
  return specs;
}

function packageNameOf(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('@/') ||
    specifier.startsWith('node:')
  ) {
    return null;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function computeBundledClosure() {
  const prodDeps = new Set(
    Object.keys(JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')).dependencies ?? {}),
  );
  const direct = new Set();
  for (const spec of collectClientImportSpecifiers()) {
    const pkg = packageNameOf(spec);
    if (pkg && prodDeps.has(pkg)) direct.add(pkg);
  }
  // Always include every production @radix-ui package even if an import is
  // added outside client/src later.
  for (const dep of prodDeps) {
    if (dep.startsWith('@radix-ui/')) direct.add(dep);
  }
  if (direct.size === 0) {
    failures.push(
      'computed ZERO client-reachable production dependencies — the import scanner is broken; update this guard.',
    );
    return [];
  }
  // Transitive closure via installed package.json dependency fields.
  const seen = new Set();
  const queue = [...direct];
  while (queue.length > 0) {
    const pkg = queue.pop();
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    const pj = path.resolve(ROOT, 'node_modules', pkg, 'package.json');
    if (!fs.existsSync(pj)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(pj, 'utf8'));
      for (const dep of Object.keys(parsed.dependencies ?? {})) queue.push(dep);
    } catch {
      /* unreadable manifest — nothing to descend into */
    }
  }
  return [...seen].sort();
}

// --- 3. Extract sink writes from each package's shipped JS -----------------

// `dangerouslySetInnerHTML: { __html: <value> }`
const DSIH_ANY_RE = /dangerouslySetInnerHTML\s*:\s*\{\s*__html\s*:/g;
const DSIH_STATIC_RE =
  /dangerouslySetInnerHTML\s*:\s*\{\s*__html\s*:\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
// `.innerHTML = <value>` / `.innerHTML += <value>`
const INNER_ANY_RE = /\.innerHTML\s*\+?=(?!=)/g;
const INNER_STATIC_RE =
  /\.innerHTML\s*\+?=\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*[;,)\]}\n]/g;

// Directories that never reach a bundle.
const SKIP_DIR_RE =
  /(^|[\\/])(test|tests|__tests__|example|examples|coverage|docs|fixtures?)([\\/]|$)/;

function unquote(literal) {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === '`') {
    if (body.includes('${')) return null; // dynamic template — not static
    return body.replace(/\\(.)/g, '$1');
  }
  try {
    // JSON has no \xNN or \0 escapes — normalize the JS forms first.
    const jsonish = body
      .replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')
      .replace(/\\0(?![0-9])/g, '\\u0000')
      .replace(/\\'/g, "'")
      .replace(/"/g, '\\"');
    return JSON.parse(`"${jsonish}"`);
  } catch {
    return null;
  }
}

/** @returns {{staticDsih:Map<string,string[]>, staticInner:Map<string,string[]>, dynamicFiles:string[]}} */
function scanPackage(pkg) {
  const root = path.resolve(ROOT, 'node_modules', pkg);
  const result = {
    staticDsih: new Map(), // string -> files
    staticInner: new Map(),
    dynamicFiles: [],
  };
  if (!fs.existsSync(root)) return result;
  const files = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(p);
      } else if (/\.(js|mjs|cjs)$/.test(entry.name) && !SKIP_DIR_RE.test(p)) {
        files.push(p);
      }
    }
  })(root);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    let staticDsihCount = 0;
    let staticInnerCount = 0;
    let m;
    DSIH_STATIC_RE.lastIndex = 0;
    while ((m = DSIH_STATIC_RE.exec(text)) !== null) {
      const value = unquote(m[1]);
      if (value === null) continue; // dynamic template — counted below
      staticDsihCount += 1;
      if (!result.staticDsih.has(value)) result.staticDsih.set(value, []);
      result.staticDsih.get(value).push(rel);
    }
    INNER_STATIC_RE.lastIndex = 0;
    while ((m = INNER_STATIC_RE.exec(text)) !== null) {
      const value = unquote(m[1]);
      if (value === null) continue;
      staticInnerCount += 1;
      if (!result.staticInner.has(value)) result.staticInner.set(value, []);
      result.staticInner.get(value).push(rel);
    }
    const dsihAny = (text.match(DSIH_ANY_RE) ?? []).length;
    const innerAny = (text.match(INNER_ANY_RE) ?? []).length;
    if (dsihAny > staticDsihCount || innerAny > staticInnerCount) {
      result.dynamicFiles.push(rel);
    }
  }
  return result;
}

// --- 4. Compare against the runtime allowlist and the audited baseline -----

const sourceText = fs.readFileSync(TRUSTED_TYPES_SOURCE, 'utf8');
const allowlist = parseAllowlist(sourceText);

let scannedPackages = 0;
let sinkPackages = 0;

if (allowlist) {
  const allowSet = new Set(allowlist);
  const allAllowlistedDsih = new Set();
  const packages = computeBundledClosure();
  scannedPackages = packages.length;

  for (const pkg of packages) {
    const { staticDsih, staticInner, dynamicFiles } = scanPackage(pkg);
    const hasSinks =
      staticDsih.size > 0 || staticInner.size > 0 || dynamicFiles.length > 0;
    if (!hasSinks) continue;
    sinkPackages += 1;
    const baseline = KNOWN_SINKS[pkg];

    for (const [value, files] of staticDsih) {
      if (allowSet.has(value)) {
        allAllowlistedDsih.add(value);
        continue;
      }
      failures.push(
        `${pkg} (${files[0]}): injects a static dangerouslySetInnerHTML string MISSING from THIRD_PARTY_STATIC_SINK_ALLOWLIST (the default policy would reject it and break the packaged app):\n    ${JSON.stringify(value)}`,
      );
    }
    const knownStatic = new Set(baseline?.knownStaticInnerHTML ?? []);
    for (const [value, files] of staticInner) {
      if (allowSet.has(value) || knownStatic.has(value)) continue;
      failures.push(
        `${pkg} (${files[0]}): assigns an UNAUDITED static innerHTML string (not in the runtime allowlist or this guard's KNOWN_SINKS baseline):\n    ${JSON.stringify(value)}`,
      );
    }
    if (dynamicFiles.length > 0 && !baseline?.dynamicSinks) {
      failures.push(
        `${pkg}: contains NON-STATIC HTML sink writes not in this guard's KNOWN_SINKS baseline (files: ${dynamicFiles.slice(0, 5).join(', ')}${dynamicFiles.length > 5 ? ', …' : ''}). Audit whether the code path runs in our app under Trusted Types enforcement, then extend KNOWN_SINKS.`,
      );
    }
  }

  // Every runtime allowlist entry must still be injected by an installed
  // dependency — otherwise it is stale.
  for (const value of allowSet) {
    if (!allAllowlistedDsih.has(value)) {
      failures.push(
        `Allowlist entry no longer matches anything the installed dependencies inject (stale entry — dependency upgrade changed the markup?):\n    ${JSON.stringify(value)}`,
      );
    }
  }

  // The known allowlisted-dsih packages must still inject something —
  // catches a package changing HOW it injects styles entirely.
  for (const [pkg, info] of Object.entries(KNOWN_SINKS)) {
    if (!info.allowlistedDsih) continue;
    const { staticDsih } = scanPackage(pkg);
    if (staticDsih.size === 0) {
      failures.push(
        `${pkg}: no static dangerouslySetInnerHTML sink found in its shipped JS — the package changed how it injects styles; re-audit the Trusted Types allowlist.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('check-trusted-types-allowlist: FAILED\n');
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(
    "  The Trusted Types default policy exact-matches allowlisted strings at runtime.\n" +
      '  If a dependency upgrade legitimately changed or added injected markup:\n' +
      '   - runtime-injected strings → update THIRD_PARTY_STATIC_SINK_ALLOWLIST in\n' +
      '     client/src/lib/trusted-types.ts (and re-run the trusted-types browser check);\n' +
      '   - audited-but-inert sinks → extend KNOWN_SINKS in this script with a comment\n' +
      '     explaining why the path cannot break the packaged app.',
  );
  process.exit(1);
}

console.log(
  `check-trusted-types-allowlist: OK — scanned ${scannedPackages} bundled package(s); ${sinkPackages} contain HTML sinks, all covered by the ${allowlist.length}-entry runtime allowlist or the audited baseline.`,
);
