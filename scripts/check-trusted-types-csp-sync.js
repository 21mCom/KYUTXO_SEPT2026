#!/usr/bin/env node

// Guard: the trusted-types browser check (scripts/check-trusted-types-browser.mjs)
// hand-copies the security-relevant CSP directives from the packaged app's CSP
// in electron/main.cjs. If either copy is edited without the other, the browser
// check silently validates a different Trusted Types policy than the one the
// packaged app enforces. This script extracts the trusted-types-relevant
// directives (`require-trusted-types-for` and `trusted-types`) from both files
// and fails on any mismatch.
//
// It ALSO guards the packaged-renderer gate
// (scripts/check-packaged-electron-browser.mjs), which runs only at release
// time. That gate asserts the served CSP via hard-coded `csp.includes(...)`
// string literals; if electron/main.cjs changes the CSP, those assertions can
// silently stop matching the real policy (or keep passing while the policy
// weakens). This script cross-checks:
//   - every `csp.includes("...")` literal in the packaged gate is actually a
//     substring of the PACKAGED_CSP in electron/main.cjs, and
//   - the packaged gate still asserts each security-critical token
//     (require-trusted-types-for, the trusted-types allowlist,
//     'wasm-unsafe-eval'), and
//   - PACKAGED_CSP's script-src keeps 'wasm-unsafe-eval' and never gains
//     'unsafe-inline' or 'unsafe-eval'.
//
// It also lints the `trusted-types` directive for quoted policy names: per the
// CSP spec, policy names are bare tokens (e.g. `default`, not `'default'`).
// Quoting a policy name makes Chromium ignore the ENTIRE directive — a trap
// this project already hit once. Only the spec's quoted keywords
// ('allow-duplicates', 'none') are legitimate quoted tokens.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MAIN_CJS = path.resolve(ROOT, 'electron/main.cjs');
const BROWSER_CHECK = path.resolve(ROOT, 'scripts/check-trusted-types-browser.mjs');

const ALLOWED_QUOTED_KEYWORDS = new Set(["'allow-duplicates'", "'none'"]);

let failures = 0;
function fail(msg) {
  failures += 1;
  console.error(`FAIL: ${msg}`);
}

// Extract the array of double/single-quoted string literals that follows the
// given anchor in the file's source, up to the closing `]` of that array.
function extractCspDirectives(filePath, anchorRe, label) {
  const src = fs.readFileSync(filePath, 'utf8');
  const anchorMatch = src.match(anchorRe);
  if (!anchorMatch) {
    fail(`${label}: could not locate CSP array (anchor ${anchorRe}) in ${path.relative(ROOT, filePath)}. If the CSP moved, update this guard.`);
    return null;
  }
  const start = src.indexOf('[', anchorMatch.index);
  if (start === -1) {
    fail(`${label}: no '[' found after CSP anchor in ${path.relative(ROOT, filePath)}.`);
    return null;
  }
  const end = src.indexOf(']', start);
  if (end === -1) {
    fail(`${label}: unterminated CSP array in ${path.relative(ROOT, filePath)}.`);
    return null;
  }
  const block = src.slice(start + 1, end);
  const directives = [];
  const strRe = /(["'`])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = strRe.exec(block)) !== null) {
    directives.push(m[2]);
  }
  if (directives.length === 0) {
    fail(`${label}: CSP array in ${path.relative(ROOT, filePath)} contained no string literals.`);
    return null;
  }
  return directives;
}

// Return the trusted-types-relevant directives from a directive list, keyed by
// directive name so mismatches report precisely.
function trustedTypesDirectives(directives) {
  const relevant = {};
  for (const d of directives) {
    const name = d.trim().split(/\s+/)[0];
    if (name === 'require-trusted-types-for' || name === 'trusted-types') {
      if (name in relevant) {
        fail(`duplicate '${name}' directive found: "${d}"`);
      }
      relevant[name] = d.trim().replace(/\s+/g, ' ');
    }
  }
  return relevant;
}

function lintTrustedTypesPolicyNames(directive, label) {
  if (!directive) return;
  const tokens = directive.split(/\s+/).slice(1); // drop directive name
  for (const t of tokens) {
    if (/^['"]/.test(t) && !ALLOWED_QUOTED_KEYWORDS.has(t)) {
      fail(
        `${label}: quoted policy name ${t} in "trusted-types" directive. ` +
          `Policy names must be bare tokens (e.g. default, not 'default'); ` +
          `Chromium silently ignores the whole directive otherwise.`,
      );
    }
  }
}

const mainDirectives = extractCspDirectives(
  MAIN_CJS,
  /const\s+PACKAGED_CSP\s*=/,
  'electron/main.cjs',
);
const checkDirectives = extractCspDirectives(
  BROWSER_CHECK,
  /const\s+ENFORCING_CSP\s*=/,
  'check-trusted-types-browser.mjs',
);

if (mainDirectives && checkDirectives) {
  const mainTT = trustedTypesDirectives(mainDirectives);
  const checkTT = trustedTypesDirectives(checkDirectives);

  for (const name of ['require-trusted-types-for', 'trusted-types']) {
    const a = mainTT[name];
    const b = checkTT[name];
    if (!a) fail(`electron/main.cjs CSP is missing the '${name}' directive.`);
    if (!b) fail(`check-trusted-types-browser.mjs ENFORCING_CSP is missing the '${name}' directive.`);
    if (a && b && a !== b) {
      fail(
        `'${name}' directive drift:\n` +
          `  electron/main.cjs:                  "${a}"\n` +
          `  check-trusted-types-browser.mjs:    "${b}"\n` +
          `  The browser check must validate the exact policy the packaged app enforces.`,
      );
    }
  }

  lintTrustedTypesPolicyNames(mainTT['trusted-types'], 'electron/main.cjs');
  lintTrustedTypesPolicyNames(checkTT['trusted-types'], 'check-trusted-types-browser.mjs');
}

// ── Packaged-renderer gate lockstep ─────────────────────────────────────────
// The release-time gate hard-codes csp.includes("...") assertions; keep them
// in lockstep with the real PACKAGED_CSP so a CSP edit can't pass daily
// validation yet fail (or silently weaken) the packaged check.
const PACKAGED_GATE = path.resolve(ROOT, 'scripts/check-packaged-electron-browser.mjs');

if (mainDirectives) {
  const packagedCsp = mainDirectives.join('; ');
  const gateSrc = fs.readFileSync(PACKAGED_GATE, 'utf8');

  // Collect every string literal asserted via csp.includes(...).
  const includeRe = /csp\.includes\(\s*(["'`])((?:\\.|(?!\1).)*)\1\s*\)/g;
  const asserted = [];
  let im;
  while ((im = includeRe.exec(gateSrc)) !== null) {
    asserted.push(im[2].replace(/\\(["'`\\])/g, '$1'));
  }
  if (asserted.length === 0) {
    fail(
      'check-packaged-electron-browser.mjs: no csp.includes(...) assertions found. ' +
        'If the CSP assertions moved or changed form, update this guard.',
    );
  }

  // 1) Every asserted literal must actually appear in PACKAGED_CSP, or the
  //    release gate would fail on a policy that daily validation approved.
  for (const lit of asserted) {
    if (!packagedCsp.includes(lit)) {
      fail(
        `packaged gate asserts csp.includes(${JSON.stringify(lit)}) but PACKAGED_CSP in electron/main.cjs ` +
          `does not contain it. Update one side so dev validation and the release gate agree.\n` +
          `  PACKAGED_CSP: "${packagedCsp}"`,
      );
    }
  }

  // 2) The gate must keep asserting each security-critical token; dropping an
  //    assertion would let the packaged CSP weaken without the gate noticing.
  const CRITICAL_TOKENS = [
    "require-trusted-types-for 'script'",
    'trusted-types kyutxo-app default',
    "'wasm-unsafe-eval'",
  ];
  for (const tok of CRITICAL_TOKENS) {
    if (!asserted.includes(tok)) {
      fail(
        `check-packaged-electron-browser.mjs no longer asserts csp.includes(${JSON.stringify(tok)}). ` +
          `The packaged gate must keep checking this security-critical token.`,
      );
    }
  }

  // 3) The gate must keep its negative script-src assertions (no
  //    unsafe-inline / unsafe-eval in script-src of the packaged CSP).
  if (!/script-src \[\^;\]\*'unsafe-inline'/.test(gateSrc)) {
    fail(
      "check-packaged-electron-browser.mjs no longer rejects 'unsafe-inline' in script-src. " +
        'Restore the negative assertion so a weakened packaged CSP fails the gate.',
    );
  }
  if (!/script-src \[\^;\]\*'unsafe-eval'/.test(gateSrc)) {
    fail(
      "check-packaged-electron-browser.mjs no longer rejects 'unsafe-eval' in script-src. " +
        'Restore the negative assertion so a weakened packaged CSP fails the gate.',
    );
  }

  // 4) PACKAGED_CSP itself must stay strict: script-src keeps
  //    'wasm-unsafe-eval' (Argon2id KDF) and never gains inline/eval script.
  const scriptSrc = mainDirectives.find((d) => d.trim().startsWith('script-src'));
  if (!scriptSrc) {
    fail("electron/main.cjs PACKAGED_CSP is missing a 'script-src' directive.");
  } else {
    if (!scriptSrc.includes("'wasm-unsafe-eval'")) {
      fail(
        "electron/main.cjs PACKAGED_CSP script-src lost 'wasm-unsafe-eval' — the packaged app " +
          'cannot run the Argon2id KDF (hash-wasm) without it.',
      );
    }
    if (scriptSrc.includes("'unsafe-inline'")) {
      fail("electron/main.cjs PACKAGED_CSP script-src must not contain 'unsafe-inline'.");
    }
    if (scriptSrc.replace(/'wasm-unsafe-eval'/g, '').includes("'unsafe-eval'")) {
      fail("electron/main.cjs PACKAGED_CSP script-src must not contain 'unsafe-eval'.");
    }
  }
}

if (failures > 0) {
  console.error(`\ncheck-trusted-types-csp-sync: ${failures} problem(s) found.`);
  process.exit(1);
}
console.log(
  'check-trusted-types-csp-sync: trusted-types CSP directives match between electron/main.cjs and the browser check, ' +
    'the packaged-electron gate assertions are in lockstep with PACKAGED_CSP, and all policy names are bare tokens.',
);
