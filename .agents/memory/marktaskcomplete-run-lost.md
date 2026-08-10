---
name: markTaskComplete RUN_LOST validation flake
description: Completion-triggered validation runs can be unreadable (RUN_LOST) even though the checks themselves pass; how to complete the task anyway.
---

`markTaskComplete` spawns its own validation run before code review; that run can come back `RUN_LOST` ("validation run ... could not be read") repeatedly while the identical checks pass when started manually.

**Why:** Seen when a task's completion validation failed 3x with RUN_LOST while a manual `startValidationRun` of the same commands PASSED with exit 0 — an infra flake in the completion path, not a test failure.

**How to apply:** Retry once or twice. If RUN_LOST persists, run the affected checks via `startValidationRun` yourself, confirm PASSED, then call `markTaskComplete` with `skip_validation_reason` citing the manual run ID, per-command exit codes, and any direct vitest/tsc evidence.
