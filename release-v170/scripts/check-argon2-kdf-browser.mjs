#!/usr/bin/env node
// Real-browser regression guard for the Argon2id vault/backup KDF (hash-wasm).
// Node tests cannot catch a browser-only WebAssembly loading failure (asset
// resolution, CSP, bundling), so this loads the actual Vite-served module in
// real headless Chromium and runs the full derivation self-check:
// Argon2id hash/verify, AES-GCM key round-trip, and both PBKDF2 eras.
//
// It passes only when, in the browser:
//   - report.bufferGlobalPresent === false (proves a true browser environment)
//   - report.ok === true                   (every derivation step passed)
//
// Usage: node scripts/check-argon2-kdf-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const MODULE_PATH = "/src/lib/argon2KdfBrowserCheck.ts";

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync("which chromium", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.",
    );
  }
}

async function isServerUp(url) {
  try {
    const res = await fetch(url, { method: "GET" });
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
  console.log(`[argon2-kdf-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[argon2-kdf-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[argon2-kdf-browser] starting dev server (npm run dev) ...`);
    devProc = spawn("npm", ["run", "dev"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[argon2-kdf-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  let report;
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (/wasm|webassembly|argon/i.test(t)) {
        console.log(`[argon2-kdf-browser][page-console] ${t}`);
      }
    });
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    report = await page.evaluate(async (modulePath) => {
      const mod = await import(modulePath);
      return await mod.runArgon2KdfBrowserCheck();
    }, MODULE_PATH);
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, "SIGTERM");
      } catch {
        try {
          devProc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
  }

  console.log(
    `[argon2-kdf-browser] bufferGlobalPresent=${report.bufferGlobalPresent} ok=${report.ok} argonDeriveMs=${Math.round(report.argonDeriveMs)}`,
  );
  for (const step of report.steps) {
    console.log(`  [${step.passed ? "PASS" : "FAIL"}] ${step.name} :: ${step.detail}`);
  }

  const failures = [];
  if (report.bufferGlobalPresent !== false) {
    failures.push(
      "Expected bufferGlobalPresent=false (a true browser has no Node Buffer global); " +
        "the check did not run in a real browser environment.",
    );
  }
  if (report.ok !== true) {
    failures.push(
      "The browser Argon2id KDF check failed — likely a wasm-loading regression " +
        "(bundling/CSP) that Node tests cannot see.",
    );
  }

  if (failures.length > 0) {
    console.error("\n[argon2-kdf-browser] FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("[argon2-kdf-browser] PASSED: Argon2id wasm derivation is healthy in a real browser.");
}

main().catch((err) => {
  console.error("[argon2-kdf-browser] ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
