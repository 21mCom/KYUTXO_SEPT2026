---
name: .replit validation workflow wiring
description: How to register a new check script as a completion-validation gate, and what to do when validation only fails on unrelated flaky browser checks.
---

**Rule:** A new check script only gates task completion when it has BOTH a named workflow entry with `isValidation = true` AND a `workflow.run` entry in the Project workflow list. `configureWorkflow` alone may not persist that wiring — write a full `.replit.new` and apply it via `verifyAndReplaceDotReplit` (direct `.replit` edits are forbidden).

**Why:** A completion review rejected a task because the new browser check existed but never ran in validation; `configureWorkflow` had silently not persisted the validation flag.

**How to apply:** After adding any `scripts/check-*.{js,mjs}` guard, verify it appears in the validation run's command list on the first `markTaskComplete` attempt. `verifyAndReplaceDotReplit` takes `{ tempFilePath }` and it must be an ABSOLUTE path (e.g. `/home/runner/workspace/.replit.new`).

**Browser checks must self-start the dev server:** any `check-*-browser.mjs` that goes straight to `page.goto` without an isServerUp/waitForServer + `npm run dev` spawn fallback will flake in validation with ERR_CONNECTION_REFUSED when it wins the lock while the app workflow is down. Always include the ensure-server preamble.

**Validation flake escape hatch:** When repeated full validation runs each fail only on *different, unrelated* browser checks (chromium `pthread_create EAGAIN`, `input-password` load timeouts, vitest worker-teardown crashes with all tests passing), that is parallel-Chromium contention, not a regression. After several genuinely different attempts with your own check + code review green, `markTaskComplete` with an audited `skip_validation_reason` is acceptable. Also: runs can wedge with hung check processes at 0% CPU — `pkill -9 -f 'check-.*browser'` forces the run to a terminal state so a replacement attempt can start.

**Vitest suites die in the same storm:** in task envs the parallel fan-out also EAGAIN-kills vitest suites at pool start (`pthread_create`, `write EPIPE`, `[vitest-pool-runner]: Timeout waiting for worker to respond`) — a different random ~third of suites each run, unrelated to the change. Wedged vitest stragglers (0% CPU `npx → npm exec → node vitest` chain) keep the run RUNNING forever; `kill -9` that chain to force the terminal state. Confirm contention (not regression) by running the failed suites serially before skipping.

**Hardening new browser checks:** retry `chromium.launch` (EAGAIN under load) and retry the initial goto+first-selector wait with generous timeouts; single-shot 30s waits flake under parallel validation.

**Rebase conflicts in `.replit`:** when two tasks each append a validation workflow block, the rebase conflicts at the append point — resolve by keeping BOTH full blocks (the `workflow.run` list entries usually merge cleanly on their own). Direct edits stay blocked mid-rebase: splice the merged TOML into a temp file and apply via `verifyAndReplaceDotReplit`, then `continueMergeResolution`. Gotcha: while `.replit` is conflicted the env config is not applied and `node`/`python3` vanish from PATH — call the `/nix/store/*nodejs*/bin/node` binary directly. Also don't string-match "conflict" on `continueMergeResolution`'s result to decide success (`conflictFiles: []` matches); check `status === "rebase_complete"`.
