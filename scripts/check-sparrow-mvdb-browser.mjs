#!/usr/bin/env node
// Real-browser regression guard for the Descriptor Import page's handling of
// Sparrow's internal wallet file (.mv / .mv.db).
//
// Task background: the page detects Sparrow's binary H2 MVStore wallet file by
// name (isSparrowWalletFile) and shows tailored guidance (use Sparrow's
// File → Export → Output Descriptor / wallet JSON) instead of trying to parse
// the binary. jsdom tests simulate react-dropzone drops, but the REAL browser
// path — the dropzone's MIME `accept` mapping for the file picker, the native
// drag-and-drop DataTransfer path, and the onDropRejected fallback — can only
// be exercised in a real browser.
//
// This script drives the actual page in headless Chromium:
//   1. Creates a fresh vault via the setup form and opens /descriptor-import.
//   2. Selects a REAL binary .mv.db file (H2 MVStore-like magic bytes) via the
//      dropzone's hidden file input (the file-picker path) and asserts:
//        - the destructive "Sparrow wallet file detected" toast appears
//        - the inline Parse Error alert shows the Sparrow export guidance
//   3. Repeats the check via a synthetic drag-and-drop `drop` event carrying a
//      DataTransfer with the binary file (the drag path, which is what
//      onDrop/onDropRejected actually see for drags).
//   4. Selects a valid Sparrow JSON export via the same dropzone and asserts
//      it still parses: "Descriptor Parsed Successfully" alert appears and the
//      Sparrow guidance error is cleared.
//   5. Selects a .txt raw-descriptor file and a .bsms file via the same
//      dropzone and asserts each parses (Descriptor loaded / BSMS file loaded
//      toast + parsed-descriptor alert). The dropzone accept map routes these
//      through 'text/plain' — a regression there (e.g. an accept-map edit for
//      the Sparrow case) only shows up in a real browser.
//
// Everything runs offline — no network requests beyond the local dev server.
//
// Usage: node scripts/check-sparrow-mvdb-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const IMPORT_URL = `${BASE_URL}descriptor-import`;
const SETUP_PASSWORD = 'sparrow-mvdb-check-123';

const SPARROW_TOAST_TITLE = 'Sparrow wallet file detected';
// Distinctive substrings of SPARROW_WALLET_FILE_MESSAGE (descriptor-parser.ts)
const GUIDANCE_SNIPPET = "Sparrow's internal wallet file";
const GUIDANCE_EXPORT_SNIPPET = 'Output Descriptor';

// A realistic binary payload: H2 MVStore files start with a "H:2" file header
// block; the rest is arbitrary non-UTF8 binary so any accidental text-parsing
// path would choke on it.
function buildMvDbBytes() {
  const header = Buffer.from(
    'H:2,block:0,blockSize:1000,chunk:0,created:018well,format:2,version:0\n',
    'latin1',
  );
  const binary = Buffer.alloc(4096);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 37 + 11) % 256;
  return Buffer.concat([header, binary]);
}

// Valid Sparrow wallet JSON export (descriptor field) — fake-but-well-formed
// xpubs are fine: parseDescriptor only pattern-matches keys at this stage.
const SPARROW_JSON = JSON.stringify({
  label: 'MVDB Check Wallet',
  blockheight: 800000,
  descriptor:
    'wsh(sortedmulti(2,[aaaaaaaa/48h/0h/0h/2h]xpub6DUcheckaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/0/*,[bbbbbbbb/48h/0h/0h/2h]xpub6DVcheckbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/0/*))',
});

// Raw multisig descriptor (fake-but-well-formed xpubs — parseDescriptor only
// pattern-matches keys at this stage). Saved as a .txt file for the raw
// descriptor file-import path.
const RAW_DESCRIPTOR =
  'wsh(sortedmulti(2,[aaaaaaaa/48h/0h/0h/2h]xpub6DUcheckaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/0/*,[bbbbbbbb/48h/0h/0h/2h]xpub6DVcheckbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/0/*))';

// Minimal valid BSMS 1.0 file (BSMS spec: version line, descriptor,
// path restrictions). Uses the /**-style dual-chain wildcard Sparrow/Nunchuk
// emit; no first-address line so parsing succeeds without derivation.
const BSMS_CONTENT =
  [
    'BSMS 1.0',
    'wsh(sortedmulti(2,[aaaaaaaa/48h/0h/0h/2h]xpub6DUcheckaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/**,[bbbbbbbb/48h/0h/0h/2h]xpub6DVcheckbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/**))',
    '/0/*,/1/*',
  ].join('\r\n') + '\r\n';

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
  console.log(`[sparrow-mvdb-browser] chromium: ${exe}`);

  // Write the fixture files to a temp dir (kept out of the repo — the .mv.db
  // is deliberately binary garbage).
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-mvdb-check-'));
  const mvDbPath = join(dir, 'MyWallet.mv.db');
  writeFileSync(mvDbPath, buildMvDbBytes());
  const jsonPath = join(dir, 'sparrow-export.json');
  writeFileSync(jsonPath, SPARROW_JSON);
  const txtPath = join(dir, 'raw-descriptor.txt');
  writeFileSync(txtPath, RAW_DESCRIPTOR + '\n');
  const bsmsPath = join(dir, 'coordinator-export.bsms');
  writeFileSync(bsmsPath, BSMS_CONTENT);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[sparrow-mvdb-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[sparrow-mvdb-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[sparrow-mvdb-browser] dev server ready at ${BASE_URL}`);
  }

  // Validation runs many browser checks in parallel; chromium launches can
  // transiently fail with pthread_create EAGAIN under that load. Retry with
  // backoff instead of failing the whole guard on a resource blip.
  let browser = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      const delay = attempt * 15_000;
      console.log(
        `[sparrow-mvdb-browser] chromium launch failed (attempt ${attempt}/5), retrying in ${delay / 1000}s: ${String(err).split('\n')[0]}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[sparrow-mvdb-browser][page-console] ${t}`);
      }
    });

    // Under parallel validation load the dev server can take far longer than
    // usual to serve the first page; retry the initial load a few times
    // rather than failing the guard on a slow environment.
    const pwInput = page.getByTestId('input-password');
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await page.goto(IMPORT_URL, { waitUntil: 'load', timeout: 90_000 });
        await pwInput.waitFor({ state: 'visible', timeout: 45_000 });
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        console.log(
          `[sparrow-mvdb-browser] initial page load attempt ${attempt}/4 failed, retrying: ${String(err).split('\n')[0]}`,
        );
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // Best-effort: dismiss the legacy-migration overlay if it appears after
    // unlock, otherwise it swallows clicks / covers the page.
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    // ── Descriptor Import page rendered ─────────────────────────────────────
    const dropzone = page.getByTestId('dropzone-descriptor');
    await dropzone.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'page: descriptor import dropzone is visible',
      passed: true,
      detail: 'dropzone-descriptor rendered',
    });

    const guidanceAlertVisible = async () => {
      const alert = page.locator('[role="alert"]', { hasText: GUIDANCE_SNIPPET });
      const visible = await alert
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!visible) return { visible: false, text: '' };
      const text = (await alert.first().textContent()) ?? '';
      return { visible: true, text };
    };

    const toastVisible = async () =>
      page
        .getByText(SPARROW_TOAST_TITLE, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

    // ── 1) File-picker path: select the binary .mv.db via the hidden input ──
    {
      await page.getByTestId('input-file-descriptor').setInputFiles(mvDbPath);

      const toastSeen = await toastVisible();
      steps.push({
        name: 'picker: destructive "Sparrow wallet file detected" toast appears',
        passed: toastSeen,
        detail: toastSeen
          ? `toast with title "${SPARROW_TOAST_TITLE}" shown after selecting MyWallet.mv.db`
          : 'Sparrow toast never appeared after selecting the .mv.db file',
      });

      const alert = await guidanceAlertVisible();
      steps.push({
        name: 'picker: inline Parse Error alert shows the Sparrow export guidance',
        passed: alert.visible && alert.text.includes(GUIDANCE_EXPORT_SNIPPET),
        detail: alert.visible
          ? `alert text mentions Sparrow internal file and export path: ${JSON.stringify(alert.text.slice(0, 160))}`
          : 'guidance alert with SPARROW_WALLET_FILE_MESSAGE never appeared',
      });
    }

    // ── 2) Valid Sparrow JSON export parses AND clears the guidance state ───
    // Running the JSON scenario between the two .mv.db scenarios both proves
    // the non-regression requirement (valid exports still load) and resets the
    // page state, so scenario 3's assertions are a genuine state TRANSITION
    // caused by the drop event, not leftovers from scenario 1.
    {
      await page.getByTestId('input-file-descriptor').setInputFiles(jsonPath);

      const successAlert = page.locator('[role="alert"]', {
        hasText: 'Descriptor Parsed Successfully',
      });
      const parsed = await successAlert
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'json: valid Sparrow JSON export parses ("Descriptor Parsed Successfully")',
        passed: parsed,
        detail: parsed
          ? 'success alert visible after selecting sparrow-export.json'
          : 'Descriptor Parsed Successfully alert never appeared for the JSON export',
      });

      // The earlier Sparrow guidance error must be cleared once a valid file
      // loads (setParseError(null) on success).
      const staleGuidance = await page
        .locator('[role="alert"]', { hasText: GUIDANCE_SNIPPET })
        .count();
      steps.push({
        name: 'json: the Sparrow guidance error is cleared after a valid import',
        passed: staleGuidance === 0,
        detail: `found ${staleGuidance} lingering guidance alert(s) (expected 0)`,
      });

      // Label from the JSON export should be surfaced in the parsed summary.
      const labelShown = await page
        .getByText('MVDB Check Wallet', { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      steps.push({
        name: 'json: wallet label from the export is surfaced',
        passed: labelShown === true,
        detail: labelShown
          ? '"MVDB Check Wallet" label visible in the parsed summary'
          : 'wallet label from the JSON export was not shown',
      });

      // Wait for scenario 1's toast to disappear so scenario 3 can assert a
      // FRESH toast appearance caused by the drop (toasts auto-dismiss; also
      // try clicking its close button to speed this up).
      const oldToast = page.getByText(SPARROW_TOAST_TITLE, { exact: false }).first();
      if (await oldToast.isVisible().catch(() => false)) {
        await page
          .locator('[toast-close], [data-radix-toast-announce-exclude] ~ button, button[aria-label="Close"]')
          .first()
          .click({ timeout: 2_000 })
          .catch(() => {});
        await oldToast.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
      }
      const toastGone = !(await oldToast.isVisible().catch(() => false));
      steps.push({
        name: 'json: scenario-1 Sparrow toast is gone before the drag scenario',
        passed: toastGone,
        detail: toastGone
          ? 'no Sparrow toast visible — drag scenario starts from a clean state'
          : 'Sparrow toast from scenario 1 never dismissed; drag assertions would not be isolated',
      });
    }

    // ── 2b) .txt raw descriptor via the same dropzone (text/plain path) ─────
    {
      await page.getByTestId('input-file-descriptor').setInputFiles(txtPath);

      const loadedToast = await page
        .getByText('Descriptor loaded', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'txt: "Descriptor loaded" toast appears after selecting the .txt file',
        passed: loadedToast,
        detail: loadedToast
          ? 'Descriptor loaded toast shown for raw-descriptor.txt'
          : '"Descriptor loaded" toast never appeared for raw-descriptor.txt',
      });

      const parsed = await page
        .locator('[role="alert"]', { hasText: 'Descriptor Parsed Successfully' })
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'txt: raw descriptor from a .txt file parses ("Descriptor Parsed Successfully")',
        passed: parsed,
        detail: parsed
          ? 'success alert visible after selecting raw-descriptor.txt'
          : 'Descriptor Parsed Successfully alert never appeared for the .txt raw descriptor',
      });

      // Let the toast dismiss so the .bsms scenario asserts a fresh one.
      await page
        .getByText('Descriptor loaded', { exact: false })
        .first()
        .waitFor({ state: 'hidden', timeout: 20_000 })
        .catch(() => {});
    }

    // ── 2c) .bsms file via the same dropzone (text/plain path) ──────────────
    {
      await page.getByTestId('input-file-descriptor').setInputFiles(bsmsPath);

      const bsmsToast = await page
        .getByText('BSMS file loaded', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'bsms: "BSMS file loaded" toast appears after selecting the .bsms file',
        passed: bsmsToast,
        detail: bsmsToast
          ? 'BSMS file loaded toast shown for coordinator-export.bsms'
          : '"BSMS file loaded" toast never appeared for coordinator-export.bsms',
      });

      const parsed = await page
        .locator('[role="alert"]', { hasText: 'Descriptor Parsed Successfully' })
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'bsms: BSMS descriptor parses ("Descriptor Parsed Successfully")',
        passed: parsed,
        detail: parsed
          ? 'success alert visible after selecting coordinator-export.bsms'
          : 'Descriptor Parsed Successfully alert never appeared for the .bsms file',
      });
    }

    // ── 3) Drag-and-drop path: synthetic drop event with a DataTransfer ─────
    // Precondition (asserted above): no guidance alert and no Sparrow toast
    // are visible, so anything asserted below is caused by THIS drop.
    {
      // Build the File inside the page from the same binary bytes and fire a
      // real `drop` event on the dropzone root — this is the code path
      // react-dropzone uses for drags (including its accept-mapping and the
      // onDropRejected fallback when the browser maps the MIME differently).
      const bytes = Array.from(buildMvDbBytes());
      await page.evaluate(
        async ({ bytes }) => {
          const dz = document.querySelector('[data-testid="dropzone-descriptor"]');
          if (!dz) throw new Error('dropzone not found');
          const file = new File([new Uint8Array(bytes)], 'DragWallet.mv.db', {
            type: 'application/octet-stream',
          });
          const dt = new DataTransfer();
          dt.items.add(file);
          for (const type of ['dragenter', 'dragover', 'drop']) {
            const ev = new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt,
            });
            dz.dispatchEvent(ev);
          }
        },
        { bytes },
      );

      // Transition assertions: the guidance alert and Sparrow toast were both
      // absent immediately before the drop (asserted in scenario 2), so their
      // appearance now can only come from the drop event path.
      const toastSeen = await toastVisible();
      const alert = await guidanceAlertVisible();
      steps.push({
        name: 'drag: dropping the binary .mv.db re-shows the Sparrow guidance (fresh toast + alert transition)',
        passed: toastSeen && alert.visible && alert.text.includes(GUIDANCE_EXPORT_SNIPPET),
        detail: `toast=${toastSeen} alert=${alert.visible} (both absent pre-drop; drop event with DataTransfer on dropzone root)`,
      });

      // The drop must also have REPLACED the parsed-descriptor success state
      // from scenario 2 (onDrop clears parsedDescriptor for Sparrow files).
      const successStillShown = await page
        .locator('[role="alert"]', { hasText: 'Descriptor Parsed Successfully' })
        .count();
      steps.push({
        name: 'drag: the previous parsed-descriptor success alert is cleared by the drop',
        passed: successStillShown === 0,
        detail: `found ${successStillShown} success alert(s) after the drop (expected 0)`,
      });
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

  const ok = steps.every((s) => s.passed);

  console.log(`[sparrow-mvdb-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[sparrow-mvdb-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[sparrow-mvdb-browser] PASSED: dropping/selecting a real binary .mv.db shows the Sparrow export guidance (toast + inline alert), and valid Sparrow JSON, .txt raw-descriptor, and .bsms files still parse through the dropzone.',
  );
}

main().catch((err) => {
  console.error('[sparrow-mvdb-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
