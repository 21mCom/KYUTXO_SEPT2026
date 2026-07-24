#!/usr/bin/env node
// Real-browser regression guard for jsPDF WinAnsi glyph rendering.
//
// KYUTXO's PDF exports use jsPDF's Standard-14 Helvetica with no embedded
// Unicode font. `sanitizePdfText` remaps the Windows-1252 high-range punctuation
// (em-dash, curly quotes, ellipsis, bullet, …) to its single WinAnsi byte so the
// glyph paints instead of "?". Unit tests pin the byte mapping, but only a real
// PDF viewer can prove byte 0x97 actually renders as an em-dash. This script
// loads the Vite-bundled `pdfGlyphBrowserCheck` module in a real headless
// Chromium, where it generates a PDF and re-opens it with pdf.js (the engine
// Firefox ships as its PDF viewer) to confirm every remapped glyph round-trips.
//
// It passes only when, in the browser:
//   - report.isBrowser === true   (proves we ran in a true browser)
//   - report.ok === true          (every remapped glyph rendered correctly and
//                                   an unsupported char degraded to a clean "?")
//
// Usage: node scripts/check-pdf-glyph-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const MODULE_PATH = '/src/lib/pdfGlyphBrowserCheck.ts';

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.',
    );
  }
}

async function isServerUp(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[pdf-glyph-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[pdf-glyph-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[pdf-glyph-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[pdf-glyph-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  let report;
  try {
    // Block the PWA service worker: it takes control on first load and reloads
    // the page, which destroys the evaluate execution context mid-check.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    // NOTE: do NOT shim `Promise.try` here. `loadPdfjs()` in
    // pdfGlyphBrowserCheck.ts feature-detects native `Promise.try` support:
    // on a modern Chromium (v128+) it loads pdfjs-dist's default build with
    // its real Web Worker (the exact production configuration); on an older
    // engine it falls back to the legacy build. A page-level shim would fool
    // that detection while never reaching the spawned Web Worker, crashing
    // the default build's worker on an old Chromium.
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[pdf-glyph-browser][page-console] ${t}`);
      }
    });
    const evaluateCheck = () =>
      page.evaluate(async (modulePath) => {
        const mod = await import(modulePath);
        return await mod.runPdfGlyphBrowserCheck({ throwOnFailure: false });
      }, MODULE_PATH);

    // Navigate and let the dev bundle settle. pdfjs-dist is pre-bundled in
    // Vite's optimize cache, so importing the module does not trigger a reload.
    // A single retry tolerates the one-off PWA/lock-screen reload some boots do.
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(4000);

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        report = await evaluateCheck();
        break;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const navRace =
          msg.includes('Execution context was destroyed') ||
          msg.includes('navigation') ||
          msg.includes('detached');
        if (navRace && attempt < MAX_ATTEMPTS) {
          console.log(
            `[pdf-glyph-browser] context navigated (attempt ${attempt}); retrying ...`,
          );
          await page.waitForTimeout(3000);
          continue;
        }
        throw err;
      }
    }
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }

  console.log(
    `[pdf-glyph-browser] isBrowser=${report.isBrowser} ok=${report.ok}`,
  );
  console.log(`[pdf-glyph-browser] extracted: ${JSON.stringify(report.extracted)}`);
  for (const step of report.steps) {
    console.log(
      `  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`,
    );
  }

  const failures = [];
  if (report.isBrowser !== true) {
    failures.push(
      'Expected isBrowser=true (a real browser has window + document); ' +
        'the check did not run in a real browser environment.',
    );
  }
  if (report.ok !== true) {
    failures.push(
      'The browser PDF-glyph check failed (a glyph did not render correctly). ' +
        'This likely means a jsPDF upgrade changed how WinAnsi bytes are encoded.',
    );
  }

  if (failures.length > 0) {
    console.error('\n[pdf-glyph-browser] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    '[pdf-glyph-browser] PASSED: real-browser PDF glyph rendering is healthy.',
  );
}

main().catch((err) => {
  console.error('[pdf-glyph-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
