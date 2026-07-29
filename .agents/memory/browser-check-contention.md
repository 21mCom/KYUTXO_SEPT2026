---
name: Concurrent browser-check contention
description: Why the Chromium validation checks time out on input-password when run together
---
The validation suite runs several real-Chromium checks (sample-pdf, pof-empty, pof-empty-live, pdf-glyph, proof-verify) concurrently. Under that load (30+ Chromium processes plus Vite dev-server transforms) the initial page load exceeds the 30s `input-password` wait, so multiple checks fail with the same timeout.

**Why:** Nix Chromium + Vite cold transforms are CPU-bound; parallel runs starve each other. The app itself is fine — the same checks pass immediately when run one at a time.

**How to apply:** If validation reports several browser checks all timing out on `input-password`, don't chase an app bug. Re-run each `node scripts/check-*-browser*.mjs` sequentially (kill stale `chromium` processes first); if they pass standalone, the validation failure is contention flake, not a regression. Note: `pkill -f chromium` from a bash tool call can kill the calling shell — run it in its own command.

**Validation-runner variance:** the task-completion validation runner launches the browser checks concurrently, so failure subsets are random run-to-run (one run failed 2 checks, the next failed 9 — including ones the first run passed). Symptoms in logs: `EADDRINUSE 0.0.0.0:5000`, `page.goto: Timeout`, `ERR_CONNECTION_REFUSED`, or stale `.vite/deps` dynamic-import fetches. Verify each failed check sequentially (all green = environmental), then simply retry completion; only skip validation with an audited reason if repeated runs keep failing on contention alone. Runs can also hang outright: 8+ parallel checks all stuck RUNNING with log files untouched for 20+ min (fork EAGAIN starves Chromium subprocess spawns). Check `ls --time-style` on the run's log dir; if stale, `pkill -f "check-.*browser.mjs"` then `pkill -f chromium` (separate commands) before starting a replacement attempt.

## Parallel validation runs kill the shared dev server
Completion-validation runs the browser checks in PARALLEL; they all share port 5000. Whichever script spawns the dev server tears it down when it finishes, yanking it from the still-running checks (EADDRINUSE / ERR_CONNECTION_REFUSED, failures rotate between runs).
**How to apply:** before markTaskComplete, start the "Start application" workflow so every check "reuses" the server and none owns/kills it — flakiness disappears. Note this alone is NOT sufficient: even with the shared server up, fork-EAGAIN spawn starvation can still hang/fail a random subset of checks every run.

**Update (2026-07-28):** contention also shows up as `pthread_create: Resource temporarily unavailable` inside Chromium — a different random subset of browser checks fails on each validation run while every check passes standalone. After several genuinely failed full-validation attempts, verify the change-relevant suites locally and use an audited `skip_validation_reason` rather than retrying indefinitely.

## jsdom vitest suites also flake under validation load
Heavy page-level vitest suites (e.g. ProofOfFundsDeclaration.*) hit the 5s default testTimeout / 1s waitFor defaults when running alongside the parallel Chromium checks, failing with "Test timed out in 5000ms" while passing standalone. Another symptom: all tests PASS but the run exits 1 with `[vitest-pool]: Timeout terminating forks worker` — pure load artifact, not a test failure.
**How to apply:** harden such suites with `describe("...", { timeout: 60_000 }, ...)` and explicit `waitFor(..., { timeout })` on slow async steps (PDF assembly, balance checks) instead of retrying validation forever.
## Chromium SIGTRAP crashes + hung check scripts
Even with the dev server pre-started, concurrent runs can crash individual Chromium instances (`signal=SIGTRAP`, `browser has been closed`) at random — a different check fails each run. Worse, some check scripts print the ERROR but never exit, wedging the run until the poll budget is exhausted (POLL_BUDGET_EXCEEDED).
**How to apply:** after a failed/wedged run, `pkill -9 -f "check-.*browser.mjs"` (expect the shell call to report exit -1 — it kills its own process group; run it alone), confirm the failed checks pass serially, then retry. If several consecutive runs fail only on rotating SIGTRAP flakes while every check passes standalone, that is the audited case for skip_validation_reason.

## Long-lived dev server goes stale mid-marathon
After many back-to-back validation runs, a check can fail on `input-password` timeout even on an idle machine because the long-running Vite dev server itself is wedged/stale. Restarting the "Start application" workflow (then re-running the check standalone to confirm green) fixes it; persistence + retry-on-idle eventually lands a fully green run without skip_validation_reason.
