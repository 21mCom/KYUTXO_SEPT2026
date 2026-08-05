#!/usr/bin/env node
// Production-server regression guard for the API response/logging hygiene
// contract (server/app.ts + server/attachments.ts).
//
// server/response-hygiene.test.ts unit-tests the error middleware, nosniff
// header, body-free request logging, and safe Content-Disposition — but only
// against mocks / the dev app object. A regression in production env
// detection (`req.app.get("env")`), in middleware ordering after the esbuild
// bundle step, or in the built static-serving path would never show up there.
// This check runs the REAL production build (`npm run build` output, started
// with NODE_ENV=production exactly like `npm start`) and asserts:
//   1. The built server serves the app HTML with the launch-token <meta>.
//   2. A real 5xx (attachment download whose open() fails: unreadable file)
//      returns a generic JSON body — no filesystem path, no OS error text —
//      and carries X-Content-Type-Options: nosniff.
//   3. A 5xx routed through the GLOBAL error middleware (truncated multipart
//      upload → busboy error → next(err)) returns exactly
//      "Internal Server Error" in production — this is the env-detection
//      regression the unit tests cannot catch.
//   4. A parser-rejected request (malformed JSON) still gets nosniff — the
//      header middleware must stay registered before the body parsers in the
//      built bundle too.
//   5. DNS-rebinding defense survives the bundle: a raw request with a
//      forged non-loopback Host header (with or without a valid launch
//      token, well-formed or parser-rejected body) is rejected 403 before
//      any parser or route runs, while the same raw request with a
//      loopback Host is served (control).
//   6. The captured server log contains the request line (method/path/status)
//      but never response bodies, the attachment's absolute filesystem path,
//      or the file's secret content.
//
// Usage: node scripts/check-prod-response-hygiene.mjs
//   KYUTXO_PROD_HYGIENE_SKIP_BUILD=1  reuse an existing dist/ (local iteration)
//   KYUTXO_PROD_HYGIENE_PORT=5391    override the probe port

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.KYUTXO_PROD_HYGIENE_PORT || 5391);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const LAUNCH_TOKEN = 'prod-hygiene-check-token';
const TOKEN_HEADER = 'x-kyutxo-launch-token';
const SECRET_CONTENT = 'PROD_HYGIENE_SECRET_FILE_CONTENT_5f2c';
const SECRET_REL_PATH = 'prod-hygiene/unreadable.bin';

const steps = [];
function step(name, passed, detail = '') {
  steps.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

function buildIfNeeded() {
  const distIndex = path.resolve('dist/index.js');
  const distHtml = path.resolve('dist/public/index.html');
  if (
    process.env.KYUTXO_PROD_HYGIENE_SKIP_BUILD === '1' &&
    fs.existsSync(distIndex) &&
    fs.existsSync(distHtml)
  ) {
    console.log('[prod-hygiene] KYUTXO_PROD_HYGIENE_SKIP_BUILD=1 — reusing existing dist/');
    return;
  }
  console.log('[prod-hygiene] building production bundle (npm run build) ...');
  execSync('npm run build', { stdio: 'inherit' });
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  buildIfNeeded();

  // Isolated data dir so the check never touches real vault attachments and
  // so log-hygiene assertions have a unique path to look for.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-prod-hygiene-'));
  const attachmentsDir = path.join(dataDir, 'attachments', path.dirname(SECRET_REL_PATH));
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const secretAbsPath = path.join(dataDir, 'attachments', SECRET_REL_PATH);
  fs.writeFileSync(secretAbsPath, SECRET_CONTENT);
  // Unreadable file: fs.open() in the download route fails with EACCES → the
  // route's catch produces a real 5xx from the production server. (Would not
  // work as root; Replit runs unprivileged.)
  fs.chmodSync(secretAbsPath, 0o000);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('This check relies on an unreadable file (chmod 000) and cannot run as root.');
  }

  let serverLog = '';
  const child = spawn('node', ['dist/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      KYUTXO_DATA_DIR: dataDir,
      KYUTXO_LAUNCH_TOKEN: LAUNCH_TOKEN,
      // Force loopback-only semantics even inside Replit.
      REPL_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    if (!(await waitForServer(`${BASE_URL}/`, 30_000))) {
      throw new Error(`Production server did not become ready on ${BASE_URL} within 30s.\n--- log ---\n${serverLog}`);
    }

    // ── 1. Built server serves the app HTML with the launch-token meta ─────
    const htmlRes = await fetch(`${BASE_URL}/`);
    const html = await htmlRes.text();
    step(
      'production server serves index.html with the launch-token <meta>',
      htmlRes.status === 200 && html.includes(`content="${LAUNCH_TOKEN}"`),
      `status=${htmlRes.status}, hasMeta=${html.includes(`content="${LAUNCH_TOKEN}"`)}`,
    );
    step(
      'HTML response carries X-Content-Type-Options: nosniff',
      htmlRes.headers.get('x-content-type-options') === 'nosniff',
      `header=${htmlRes.headers.get('x-content-type-options')}`,
    );

    // ── 2. Real 5xx: download of an unreadable attachment ──────────────────
    const dl = await fetch(`${BASE_URL}/api/attachments/download/${SECRET_REL_PATH}`, {
      headers: { [TOKEN_HEADER]: LAUNCH_TOKEN },
    });
    const dlBody = await dl.text();
    step(
      'failing attachment download returns 500',
      dl.status === 500,
      `status=${dl.status}`,
    );
    step(
      '5xx download body is generic (no fs path, no OS error text)',
      dlBody.includes('Download failed') &&
        !dlBody.includes(dataDir) &&
        !dlBody.includes('EACCES') &&
        !dlBody.includes('permission denied') &&
        !dlBody.includes(SECRET_CONTENT),
      `body=${dlBody.slice(0, 200)}`,
    );
    step(
      '5xx download response carries nosniff',
      dl.headers.get('x-content-type-options') === 'nosniff',
      `header=${dl.headers.get('x-content-type-options')}`,
    );

    // ── 3. Global error middleware 5xx in production ────────────────────────
    // A truncated multipart body makes busboy fail with "Unexpected end of
    // form"; the upload wrapper forwards it via next(err) to the GLOBAL error
    // middleware with no status → 500. In development the client would see
    // the busboy message; in production it must be exactly the generic string.
    const boundary = 'ProdHygieneBoundary';
    const truncated = await fetch(`${BASE_URL}/api/attachments/write`, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: LAUNCH_TOKEN,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\n\r\npartial`,
    });
    const truncatedBody = await truncated.text();
    let truncatedMessage = null;
    try {
      truncatedMessage = JSON.parse(truncatedBody).message;
    } catch {
      /* asserted below */
    }
    step(
      'error-middleware 5xx returns exactly the generic production message',
      truncated.status === 500 && truncatedMessage === 'Internal Server Error',
      `status=${truncated.status}, message=${JSON.stringify(truncatedMessage)}`,
    );
    step(
      'error-middleware 5xx response carries nosniff',
      truncated.headers.get('x-content-type-options') === 'nosniff',
      `header=${truncated.headers.get('x-content-type-options')}`,
    );

    // ── 4. Parser-rejected request still gets nosniff in the built bundle ──
    const badJson = await fetch(`${BASE_URL}/api/tor/settings`, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: LAUNCH_TOKEN,
        'Content-Type': 'application/json',
      },
      body: '{ not json',
    });
    await badJson.text();
    step(
      'malformed-JSON (parser-rejected) response is 4xx with nosniff',
      badJson.status >= 400 && badJson.status < 500 &&
        badJson.headers.get('x-content-type-options') === 'nosniff',
      `status=${badJson.status}, header=${badJson.headers.get('x-content-type-options')}`,
    );

    // ── 5. DNS-rebinding defense: rogue Host headers are rejected ──────────
    // fetch/undici normalizes the Host header, so use node:http to send a
    // literal forged Host against the loopback socket — exactly what a
    // rebound-DNS browser request looks like to the server.
    const rawRequest = (options, body = null) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: PORT, ...options },
          (res) => {
            let data = '';
            res.on('data', (d) => { data += d; });
            res.on('end', () =>
              resolve({ status: res.statusCode, headers: res.headers, body: data }));
          },
        );
        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
      });

    // 5a. Rogue Host cannot read the token-bearing HTML.
    const rogueHtml = await rawRequest({
      method: 'GET',
      path: '/',
      headers: { Host: 'attacker.example' },
    });
    step(
      'rogue Host on / is rejected with 403 and never sees the launch token',
      rogueHtml.status === 403 &&
        !rogueHtml.body.includes(LAUNCH_TOKEN) &&
        rogueHtml.body.includes('Forbidden'),
      `status=${rogueHtml.status}, leaked=${rogueHtml.body.includes(LAUNCH_TOKEN)}`,
    );
    step(
      'rogue-Host 403 response carries nosniff',
      rogueHtml.headers['x-content-type-options'] === 'nosniff',
      `header=${rogueHtml.headers['x-content-type-options']}`,
    );

    // 5b. Rogue Host with a VALID launch token is still rejected before any
    // route runs — the host check must not be bypassable by a replayed token.
    const rogueApi = await rawRequest({
      method: 'GET',
      path: `/api/attachments/download/${SECRET_REL_PATH}`,
      headers: { Host: 'attacker.example:5391', [TOKEN_HEADER]: LAUNCH_TOKEN },
    });
    step(
      'rogue Host + valid token on /api is rejected 403 before the route runs',
      rogueApi.status === 403 && !rogueApi.body.includes('Download failed'),
      `status=${rogueApi.status}, body=${rogueApi.body.slice(0, 120)}`,
    );

    // 5c. Parser-rejected request from a rogue Host: the host check is
    // registered before the body parsers, so the malformed body must never
    // reach a parser — the response is 403, not a parser 4xx.
    const rogueBadJson = await rawRequest(
      {
        method: 'POST',
        path: '/api/tor/settings',
        headers: {
          Host: 'attacker.example',
          [TOKEN_HEADER]: LAUNCH_TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength('{ not json'),
        },
      },
      '{ not json',
    );
    step(
      'malformed body from rogue Host is rejected 403 (not answered by a parser)',
      rogueBadJson.status === 403,
      `status=${rogueBadJson.status}, body=${rogueBadJson.body.slice(0, 120)}`,
    );

    // 5d. Replit-domain Hosts must NOT be honored when REPL_ID is unset.
    // isAllowedHost allowlists *.replit.dev / *.replit.app only inside a
    // Replit environment; this server was launched with REPL_ID cleared, so a
    // regression making those domains accepted unconditionally in local
    // builds would show up here as a non-403.
    for (const rogueReplitHost of ['evil.replit.dev', 'evil.replit.app:5391']) {
      const rogueReplit = await rawRequest({
        method: 'GET',
        path: '/',
        headers: { Host: rogueReplitHost },
      });
      step(
        `Replit-domain Host (${rogueReplitHost}) is rejected 403 when REPL_ID is unset`,
        rogueReplit.status === 403 && !rogueReplit.body.includes(LAUNCH_TOKEN),
        `status=${rogueReplit.status}, leaked=${rogueReplit.body.includes(LAUNCH_TOKEN)}`,
      );
    }
    const rogueReplitApi = await rawRequest({
      method: 'GET',
      path: `/api/attachments/download/${SECRET_REL_PATH}`,
      headers: { Host: 'evil.replit.dev', [TOKEN_HEADER]: LAUNCH_TOKEN },
    });
    step(
      'Replit-domain Host + valid token on /api is rejected 403 when REPL_ID is unset',
      rogueReplitApi.status === 403 && !rogueReplitApi.body.includes('Download failed'),
      `status=${rogueReplitApi.status}, body=${rogueReplitApi.body.slice(0, 120)}`,
    );

    // Sanity: the same raw-socket path with a loopback Host succeeds, so the
    // rogue rejections above are due to the Host value, not the transport.
    const loopbackHtml = await rawRequest({
      method: 'GET',
      path: '/',
      headers: { Host: `localhost:${PORT}` },
    });
    step(
      'same raw request with loopback Host is served normally (control)',
      loopbackHtml.status === 200 && loopbackHtml.body.includes(`content="${LAUNCH_TOKEN}"`),
      `status=${loopbackHtml.status}`,
    );

    // ── 6. Server log hygiene ───────────────────────────────────────────────
    // Give the async request-logger "finish" handlers a moment to flush.
    await new Promise((r) => setTimeout(r, 500));
    step(
      'server log contains the download request line (method/path/status)',
      /GET \/api\/attachments\/download\/prod-hygiene\/.* 500 in \d+ms/.test(serverLog),
      '',
    );
    const logLeaks = [];
    if (serverLog.includes(dataDir)) logLeaks.push('absolute data-dir path');
    if (serverLog.includes(SECRET_CONTENT)) logLeaks.push('file content');
    if (serverLog.includes('Download failed')) logLeaks.push('response body ("Download failed")');
    if (serverLog.includes('"message"')) logLeaks.push('serialized JSON response body');
    if (serverLog.includes('permission denied')) logLeaks.push('raw OS error message');
    step(
      'server log leaks no filesystem path, file content, or response body',
      logLeaks.length === 0,
      logLeaks.length ? `leaked: ${logLeaks.join(', ')}` : '',
    );
    // The route-level 5xx must still be diagnosable: name + errno only.
    step(
      'server log records the sanitized error (name + errno code only)',
      serverLog.includes('Download error: Error (EACCES)'),
      '',
    );
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.chmodSync(secretAbsPath, 0o600);
    } catch { /* already gone */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('\n[prod-hygiene] Results:');
  for (const s of steps) {
    console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  }
  const failed = steps.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\n[prod-hygiene] ${failed.length}/${steps.length} checks FAILED`);
    console.error(`--- server log ---\n${serverLog}`);
    process.exit(1);
  }
  console.log(`\n[prod-hygiene] all ${steps.length} checks passed`);
}

main().catch((err) => {
  console.error('[prod-hygiene] fatal:', err);
  process.exit(1);
});
