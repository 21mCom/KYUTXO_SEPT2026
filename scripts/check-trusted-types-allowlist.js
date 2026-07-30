#!/usr/bin/env node

// Guard: the Trusted Types default policy in client/src/lib/trusted-types.ts
// exact-match allowlists the static <style> stylesheets Radix UI's ScrollArea
// and Select viewports inject via dangerouslySetInnerHTML. A dependency
// upgrade that changes those injected strings would only surface as a broken
// packaged build (or a trusted-types browser-check failure). This static
// guard reads the installed Radix dist files, extracts every
// dangerouslySetInnerHTML __html string, and fails if the set differs from
// THIRD_PARTY_STATIC_SINK_ALLOWLIST — catching the drift at dependency-bump
// time, before anything runs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const TRUSTED_TYPES_SOURCE = path.resolve(
  ROOT,
  'client/src/lib/trusted-types.ts',
);

// The dependencies whose injected markup the default policy allowlists.
// Both CJS and ESM dists are scanned — bundlers may pick either.
const RADIX_PACKAGES = [
  '@radix-ui/react-scroll-area',
  '@radix-ui/react-select',
];

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
  // Entries are plain double-quoted string literals without escapes today;
  // support standard JS escapes anyway via JSON.parse.
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

// --- 2. Extract injected __html strings from the installed dists ----------

// Matches `dangerouslySetInnerHTML: { __html: <string literal> }` in the
// compiled dist output. The literal may be backtick-, double-, or
// single-quoted depending on the build tooling.
const SINK_RE =
  /dangerouslySetInnerHTML\s*:\s*\{\s*__html\s*:\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

function unquote(literal) {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === '`') {
    if (body.includes('${')) return null; // dynamic template — not static
    return body.replace(/\\(.)/g, '$1');
  }
  try {
    return JSON.parse(`"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
  } catch {
    return null;
  }
}

function extractInjectedStrings(pkg) {
  const distDir = path.resolve(ROOT, 'node_modules', pkg, 'dist');
  if (!fs.existsSync(distDir)) {
    failures.push(
      `${pkg}: dist directory not found at ${distDir} — is the package installed?`,
    );
    return [];
  }
  const files = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .map((f) => path.join(distDir, f));
  const found = new Set();
  let sawSink = false;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    SINK_RE.lastIndex = 0;
    while ((m = SINK_RE.exec(text)) !== null) {
      sawSink = true;
      const value = unquote(m[1]);
      if (value === null) {
        failures.push(
          `${pkg}: ${path.basename(file)} injects a NON-STATIC dangerouslySetInnerHTML value (${m[1].slice(0, 80)}…) — the exact-string allowlist cannot cover it.`,
        );
      } else {
        found.add(value);
      }
    }
  }
  if (!sawSink) {
    failures.push(
      `${pkg}: no dangerouslySetInnerHTML sink found in dist — the package changed how it injects styles; re-audit the Trusted Types allowlist.`,
    );
  }
  return [...found];
}

// --- 3. Compare -------------------------------------------------------------

const sourceText = fs.readFileSync(TRUSTED_TYPES_SOURCE, 'utf8');
const allowlist = parseAllowlist(sourceText);

if (allowlist) {
  const allowSet = new Set(allowlist);
  const injected = new Set(
    RADIX_PACKAGES.flatMap((pkg) => extractInjectedStrings(pkg)),
  );

  for (const s of injected) {
    if (!allowSet.has(s)) {
      failures.push(
        `Installed dependency injects a string MISSING from THIRD_PARTY_STATIC_SINK_ALLOWLIST (the default policy would reject it and break the packaged app):\n    ${JSON.stringify(s)}`,
      );
    }
  }
  for (const s of allowSet) {
    if (!injected.has(s)) {
      failures.push(
        `Allowlist entry no longer matches anything the installed dependencies inject (stale entry — dependency upgrade changed the markup?):\n    ${JSON.stringify(s)}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('check-trusted-types-allowlist: FAILED\n');
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(
    '  The Trusted Types default policy exact-matches these strings at runtime.\n' +
      '  If a dependency upgrade legitimately changed its injected stylesheet,\n' +
      '  update THIRD_PARTY_STATIC_SINK_ALLOWLIST in client/src/lib/trusted-types.ts\n' +
      '  to the new exact strings (and re-run the trusted-types browser check).',
  );
  process.exit(1);
}

console.log(
  `check-trusted-types-allowlist: OK — ${allowlist.length} allowlisted string(s) exactly match the installed Radix dists.`,
);
