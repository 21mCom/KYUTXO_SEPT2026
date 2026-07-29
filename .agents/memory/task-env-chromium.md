---
name: Task-env chromium + validation contention
description: Fresh task environments can lack the chromium binary the browser checks need; validation fan-out can also fail with EAGAIN worker-spawn errors.
---

- Fresh task environments may not have `chromium` on PATH even though the main repl does. All `check-*-browser.mjs` scripts then fail with "No chromium binary found". Fix: `installSystemDependencies({ packages: ["chromium"] })` (package-management skill), then re-run.
- **Why:** browser checks resolve chromium from PATH or `CHROMIUM_BIN`; the Nix profile isn't always carried into task envs.
- Validation runs many commands concurrently; under load vitest suites can fail with `spawn ... EAGAIN` / "Failed to start forks worker" / worker timeouts even though every suite passes when run serially. Verify the failing suites individually before assuming a real regression; retrying validation after cleanup often passes.
- Every new `check-*-browser.mjs` MUST import + await `acquireBrowserCheckLock()` or the `browser-check-lock-guard` validation gate fails the whole run.
