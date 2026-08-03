---
name: Corrupted test-file repair
description: Repairing merge-mangled test files must restore original assertions, not delete them
---

**Rule:** When a test file is damaged by a merge (undefined variables, duplicated describe blocks, bodies swapped for unrelated assertions), repair it by reconstructing each test's original intent from git history (`git show <commit>~1:file`), never by deleting the broken tests.

**Why:** A prior "repair" of the electron security/hygiene test files silently dropped ~30 tests (sanitizeIpcError, logMainError, log/error-hygiene, source-lint guards), leaving the IPC error-sanitization guarantee with zero regression coverage while all workflows showed green.

**How to apply:** Before trusting a "tests pass" state after a corruption fix, diff the test count/describe blocks against the pre-corruption revision and re-add anything missing with corrected bodies.
