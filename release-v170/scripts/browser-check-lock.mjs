// Shared serialization lock for the real-Chromium check scripts
// (scripts/check-*-browser*.mjs).
//
// WHY: completion validation runs 8+ of these checks concurrently on one
// machine. They share the port-5000 dev server and starve each other of
// CPU/memory: Chromium dies with SIGTRAP / "browser has been closed",
// page.goto times out, and a random subset of checks fails on every run even
// though each check passes when run serially
// (see .agents/memory/browser-check-contention.md).
//
// HOW: each check process acquires an exclusive mkdir-based lock in /tmp
// before doing ANY work (including any dev-server spawn) and holds it until
// exit. mkdir is atomic on POSIX, so exactly one process wins; the rest poll.
// The winner records its pid so waiters can reap the lock if the owner died
// without cleaning up (kill -9, OOM, SIGTRAP).
//
// Usage (top of a check script, .mjs supports top-level await):
//   import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
//   await acquireBrowserCheckLock();
//
// The lock is released automatically on normal exit and on
// SIGINT/SIGTERM/uncaughtException. Override the location with
// BROWSER_CHECK_LOCK_DIR (useful for tests).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_DIR =
  process.env.BROWSER_CHECK_LOCK_DIR ||
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'kyutxo-browser-check.lock');
const OWNER_FILE = 'owner.json';
const POLL_MS = 2000;
// A single check normally finishes in well under 5 minutes; if we have been
// queued for 20 the run is doomed anyway — fail loudly instead of hanging.
const MAX_WAIT_MS = 20 * 60 * 1000;
// If the owner file is unreadable/absent, only reap the lock once it is
// clearly ancient (owner crashed between mkdir and writeFile).
const ORPHAN_AGE_MS = 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return err && err.code === 'EPERM';
  }
}

function readOwner() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(LOCK_DIR, OWNER_FILE), 'utf8'),
    );
  } catch {
    return null;
  }
}

function lockAgeMs() {
  try {
    return Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
  } catch {
    return 0;
  }
}

function tryReapStaleLock(label) {
  const owner = readOwner();
  const stale = owner
    ? typeof owner.pid === 'number' && !pidAlive(owner.pid)
    : lockAgeMs() > ORPHAN_AGE_MS;
  if (!stale) return false;
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    console.log(
      `[browser-check-lock] ${label}: reaped stale lock (owner ${
        owner ? `pid ${owner.pid} "${owner.label}" is gone` : 'unknown/orphaned'
      })`,
    );
    return true;
  } catch {
    return false; // someone else reaped it first — fine, retry mkdir
  }
}

let hooksInstalled = false;
let holdingLock = false;

export function releaseBrowserCheckLock() {
  if (!holdingLock) return;
  holdingLock = false;
  try {
    const owner = readOwner();
    // Only remove the lock if it is still OURS — never yank a successor's.
    if (owner && owner.pid === process.pid) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  } catch {
    /* best effort — a waiter will reap via the dead-pid check */
  }
}

function installReleaseHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', releaseBrowserCheckLock);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      releaseBrowserCheckLock();
      process.exit(1);
    });
  }
  process.on('uncaughtException', (err) => {
    console.error(err);
    releaseBrowserCheckLock();
    process.exit(1);
  });
}

/**
 * Block until this process holds the exclusive browser-check lock.
 * @param {string} [label] short name for log lines; defaults to the script name.
 */
export async function acquireBrowserCheckLock(
  label = path.basename(process.argv[1] || 'browser-check'),
) {
  const start = Date.now();
  let announcedWait = false;
  // os.tmpdir() can point at a runner-specific directory that has not been
  // created yet (for example D:\tmp on GitHub's Windows runner). Creating only
  // the parent keeps the lock-directory mkdir below atomic.
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(
        path.join(LOCK_DIR, OWNER_FILE),
        JSON.stringify({
          pid: process.pid,
          label,
          acquiredAt: new Date().toISOString(),
        }),
      );
      holdingLock = true;
      installReleaseHooks();
      if (announcedWait) {
        console.log(
          `[browser-check-lock] ${label}: acquired lock after ${Math.round(
            (Date.now() - start) / 1000,
          )}s`,
        );
      }
      return;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    if (tryReapStaleLock(label)) continue;
    if (Date.now() - start > MAX_WAIT_MS) {
      const owner = readOwner();
      throw new Error(
        `[browser-check-lock] ${label}: timed out after ${Math.round(
          MAX_WAIT_MS / 60000,
        )} minutes waiting for ${LOCK_DIR}` +
          (owner ? ` (held by pid ${owner.pid} "${owner.label}")` : ''),
      );
    }
    if (!announcedWait) {
      announcedWait = true;
      const owner = readOwner();
      console.log(
        `[browser-check-lock] ${label}: waiting for another browser check to finish` +
          (owner ? ` (pid ${owner.pid} "${owner.label}")` : '') +
          '...',
      );
    }
    await sleep(POLL_MS);
  }
}
