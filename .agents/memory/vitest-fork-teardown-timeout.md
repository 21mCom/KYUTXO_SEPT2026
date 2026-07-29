---
name: Vitest fork teardown timeout under load
description: Why green vitest runs exit 1 with "Timeout terminating forks worker" and the fix
---
Rule: when a vitest suite passes all tests but exits 1 with `[vitest-pool]: Timeout terminating forks worker`, the cause is fork workers being slow to shut down under machine load (e.g. parallel completion-validation suites), tripping the default 10s `teardownTimeout` — not leaked handles.

**Why:** the `--reporter=hanging-process` reporter showed zero open handles for the flaking suites; the failure only reproduced under concurrent load. Vitest treats a teardown-termination timeout as a failed run even when every test passed.

**How to apply:** first confirm with `--reporter=hanging-process` that nothing is actually leaking; if clean, raise `test.teardownTimeout` in `vitest.config.ts` (this repo uses 60s) instead of hunting phantom leaks in test files.
