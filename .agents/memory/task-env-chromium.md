---
name: Task-env chromium + validation contention
description: Fresh task environments can lack the chromium binary the browser checks need; validation fan-out can also fail with EAGAIN worker-spawn errors.
---

- Fresh task environments may not have `chromium` on PATH even though the main repl does. All `check-*-browser.mjs` scripts then fail with "No chromium binary found". Fix: `installSystemDependencies({ packages: ["chromium"] })` (package-management skill), then re-run.
- **Why:** browser checks resolve chromium from PATH or `CHROMIUM_BIN`; the Nix profile isn't always carried into task envs.
- Validation runs many commands concurrently; under load vitest suites can fail with `spawn ... EAGAIN` / "Failed to start forks worker" / worker timeouts even though every suite passes when run serially. Verify the failing suites individually before assuming a real regression; retrying validation after cleanup often passes.
- Storm signatures that look scary but are environmental: exit 134 = Node aborting at STARTUP (`Assertion failed: uv_thread_create` / `pthread_create: Resource temporarily unavailable`); a log showing "N passed" for every test plus one "Failed to start forks worker" Unhandled Error; browser checks dying on `ERR_CONNECTION_REFUSED` (the storm starves/kills the dev server — pre-start it, and it can still die mid-run); `check-db-noise-guard` failing because its inner canary vitest hit `npm error spawn sh EAGAIN`.
- A run can stay RUNNING forever on a wedged straggler: an `npx → npm exec → vitest run` chain at 0% CPU with an EMPTY log for 15+ min never started its pool — `kill -9` that chain to force the run terminal; leave lock-queued browser checks alone.
- If two full runs fail ONLY with these signatures and every failed suite passes serially (`--maxWorkers=1`), a third identical fan-out won't differ: use the audited `skip_validation_reason` citing run IDs + serial-pass evidence.
- Every new `check-*-browser.mjs` MUST import + await `acquireBrowserCheckLock()` or the `browser-check-lock-guard` validation gate fails the whole run.
