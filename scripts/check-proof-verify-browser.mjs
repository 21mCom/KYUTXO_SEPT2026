#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds signature-verification
// crypto path. Unit tests run in Node, where the `Buffer` global exists and
// dependencies resolve their Node builds, so they CANNOT catch a browser-only
// "Buffer is not defined" crash or a Web Crypto regression. This script loads
// the actual Vite-bundled module in a real headless Chromium (no `Buffer`
// global) and runs the shared self-check on the P2SH-P2WSH BIP-322 proof path.
//
// It passes only when, in the browser:
//   - report.bufferGlobalPresent === false  (proves we ran in a true browser)
//   - report.ok === true                    (valid proof verifies; tampered and
//                                             wrong-message proofs fail cleanly)
//
// Usage: node scripts/check-proof-verify-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const MODULE_PATH = "/src/lib/proofVerificationBrowserCheck.ts";

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
  console.log(`[proof-verify-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[proof-verify-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[proof-verify-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[proof-verify-browser] dev server ready at ${BASE_URL}`);
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
      if (t.toLowerCase().includes("buffer is not defined")) {
        console.log(`[proof-verify-browser][page-console] ${t}`);
      }
    });
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    report = await page.evaluate(async (modulePath) => {
      const mod = await import(modulePath);
      return await mod.runProofVerificationBrowserCheck({ throwOnFailure: false });
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
    `[proof-verify-browser] bufferGlobalPresent=${report.bufferGlobalPresent} ok=${report.ok}`,
  );
  for (const step of report.steps) {
    console.log(
      `  [${step.passed ? "PASS" : "FAIL"}] ${step.name} :: ${step.detail}`,
    );
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
      "The browser proof-verification check failed (a verify step did not pass). " +
        "This likely means a `Buffer`-global crash or a Web Crypto regression was reintroduced.",
    );
  }

  if (failures.length > 0) {
    console.error("\n[proof-verify-browser] FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("[proof-verify-browser] PASSED: real-browser proof verification is healthy.");
}

main().catch((err) => {
  console.error("[proof-verify-browser] ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
